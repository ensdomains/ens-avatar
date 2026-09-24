/**
 * SVG sanitization — a single engine that behaves identically in browsers,
 * Node.js, and edge runtimes (Cloudflare Workers).
 *
 * Built on sanitize-html (htmlparser2): pure JavaScript, no DOM dependency, so the
 * same code path runs everywhere and produces the same output. CSS is sanitized with
 * an allowlist — only SVG presentation properties survive, and `url(...)` is permitted
 * only for internal fragment references (`url(#id)`), so gradients/clips/masks keep
 * working while external resource loading (tracking, exfiltration) is blocked.
 */
import sanitizeHtml from 'sanitize-html';
import { Parser } from 'htmlparser2';
import { parse as parseCss } from 'postcss';
import { assertLimit } from './limits';

/**
 * Default upper bound on an SVG passed to sanitizeSVG (UTF-16 code units).
 * Parsing and CSS processing are superlinear on some inputs, so this bounds
 * the CPU and memory a hostile SVG can cost. Override per call.
 */
export const DEFAULT_MAX_SVG_LENGTH = 256 * 1024;
// htmlparser2 keeps open elements in an array it unshifts/scans per tag, so
// deep nesting is quadratic. Real SVGs nest a few dozen levels at most.
const MAX_SVG_NESTING_DEPTH = 256;
// sanitize-html copies its output string for every element exclusiveFilter
// drops, so the number of <style> elements is capped too.
const MAX_STYLE_ELEMENTS = 64;
// postcss is quadratic on some single declarations/selectors (e.g. repeated
// "important", comments in selectors) and in removing nodes while walking, so
// the raw CSS it parses is capped per <style> block and per SVG, and so is a
// block's node count. The CSS kept per SVG is capped separately, after
// sanitizing, so discarded rules don't count against it.
const MAX_STYLE_BLOCK_LENGTH = 32 * 1024;
const MAX_STYLE_PARSE_LENGTH = 128 * 1024;
const MAX_CSS_NODES = 2000;
const MAX_STYLE_OUTPUT_LENGTH = 64 * 1024;
const MAX_STYLE_ATTRIBUTE_LENGTH = 16 * 1024;

// CSS properties allowed in `style` attributes and `<style>` blocks.
// Presentation / paint / text / layout only — nothing that loads external resources.
const SAFE_CSS_PROPERTIES = new Set<string>([
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-miterlimit',
  'opacity',
  'color',
  'stop-color',
  'stop-opacity',
  'flood-color',
  'flood-opacity',
  'lighting-color',
  'font',
  'font-family',
  'font-size',
  'font-size-adjust',
  'font-stretch',
  'font-style',
  'font-variant',
  'font-weight',
  'text-anchor',
  'text-decoration',
  'text-rendering',
  'letter-spacing',
  'word-spacing',
  'dominant-baseline',
  'alignment-baseline',
  'baseline-shift',
  'direction',
  'writing-mode',
  'transform',
  'transform-origin',
  'display',
  'visibility',
  'overflow',
  'clip-path',
  'clip-rule',
  'mask',
  'filter',
  'marker',
  'marker-start',
  'marker-mid',
  'marker-end',
  'paint-order',
  'vector-effect',
  'shape-rendering',
  'image-rendering',
  'color-interpolation',
  'color-interpolation-filters',
  'mix-blend-mode',
  'isolation',
  // SVG2 geometry-as-CSS (harmless, occasionally used)
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'x',
  'y',
  'width',
  'height',
  'd',
]);

// At-rules that may stay (matched after unescaping, so `@i\mport` can't pass
// as something else). Everything else — @import, @font-face, @namespace, … —
// is removed.
const ALLOWED_AT_RULES = new Set<string>([
  'media',
  'supports',
  'container',
  'layer',
  'keyframes',
  '-webkit-keyframes',
]);

/**
 * Remove CSS comments in linear time. (`/\/\*[\s\S]*?\*\//g` rescans to the
 * end of the input for every unterminated `/*`, which is quadratic.) An
 * unterminated comment is kept, so its text is still checked (fail closed).
 */
function stripCssComments(value: string): string {
  let out = '';
  let i = 0;
  while (i < value.length) {
    const start = value.indexOf('/*', i);
    if (start === -1) return out + value.slice(i);
    out += value.slice(i, start);
    const end = value.indexOf('*/', start + 2);
    if (end === -1) return out + value.slice(start);
    i = end + 2;
  }
  return out;
}

/**
 * Normalizes CSS escape sequences and comments so obfuscated payloads
 * (e.g. `ur\6c(...)`, `ur/* *​/l(...)`) are caught by the checks below.
 */
function normalizeForDetection(value: string): string {
  return stripCssComments(value.toLowerCase())
    .replace(/\\([0-9a-f]{1,6})\s?/g, (_match, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    ) // hex escapes: \6c -> l
    .replace(/\\(.)/g, '$1'); // simple escapes: \l -> l
}

/**
 * Returns true if a CSS value is safe: no script/binding/external-load tokens,
 * and any `url(...)` is an internal fragment reference (`url(#id)`) only.
 */
function isSafeCssValue(value: string): boolean {
  const normalized = normalizeForDetection(value);
  if (
    /expression\s*\(|javascript:|vbscript:|-moz-binding|behavior\s*:|image-set|cross-fade|@import|element\s*\(/.test(
      normalized
    )
  ) {
    return false;
  }
  // Scan url(...) tokens in linear time; `/url\s*\([^)]*\)/g` rescans to the
  // end of the input for every unterminated `url(`, which is quadratic.
  const urlOpen = /url\s*\(/g;
  while (urlOpen.exec(normalized) !== null) {
    const close = normalized.indexOf(')', urlOpen.lastIndex);
    if (close === -1) return false; // unterminated url( — fail closed
    const inner = normalized
      .slice(urlOpen.lastIndex, close)
      .trim()
      .replace(/^['"]/, '')
      .replace(/['"]$/, '')
      .trim();
    if (!inner.startsWith('#')) return false; // only internal references
    urlOpen.lastIndex = close + 1;
  }
  return true;
}

function isAllowedDeclaration(property: string, value: string): boolean {
  return (
    SAFE_CSS_PROPERTIES.has(property.trim().toLowerCase()) &&
    isSafeCssValue(value)
  );
}

/** Sanitize an inline `style=""` attribute value against the allowlist. */
function sanitizeStyleAttribute(css: string): string {
  if (css.length > MAX_STYLE_ATTRIBUTE_LENGTH) return '';
  return css
    .split(';')
    .map(declaration => declaration.trim())
    .filter(Boolean)
    .map(declaration => {
      const colon = declaration.indexOf(':');
      if (colon < 0) return null;
      const property = declaration.slice(0, colon).trim();
      const value = declaration.slice(colon + 1).trim();
      return isAllowedDeclaration(property, value)
        ? `${property.toLowerCase()}:${value}`
        : null;
    })
    .filter(Boolean)
    .join(';');
}

/** Sanitize the CSS text inside a `<style>` block with postcss. */
function sanitizeStyleBlock(css: string): string {
  let root;
  try {
    root = parseCss(css);
  } catch {
    return ''; // unparseable CSS — fail closed
  }
  let nodes = 0;
  root.walk(() => {
    if (++nodes > MAX_CSS_NODES) return false; // stop walking
    return undefined;
  });
  if (nodes > MAX_CSS_NODES) return '';
  root.walkAtRules(atRule => {
    const name = normalizeForDetection(atRule.name);
    if (!ALLOWED_AT_RULES.has(name) || !isSafeCssValue(atRule.params)) {
      atRule.remove();
    }
  });
  root.walkDecls(decl => {
    if (!isAllowedDeclaration(decl.prop, decl.value)) decl.remove();
  });
  // Drop rules / at-rules left empty after declaration removal.
  root.walkRules(rule => {
    if (rule.nodes.length === 0) rule.remove();
  });
  root.walkAtRules(atRule => {
    if (atRule.nodes && atRule.nodes.length === 0) atRule.remove();
  });
  return root.toString().trim();
}

/**
 * Restrict an element's `href`: keep only internal fragment references (`#id`),
 * and — for raster-capable elements — inline `data:image/*` URIs.
 */
function restrictHref(
  attribs: sanitizeHtml.Attributes,
  allowDataImage: boolean
): sanitizeHtml.Attributes {
  const href = attribs.href;
  if (typeof href === 'string') {
    const trimmed = href.trim();
    const ok =
      trimmed.startsWith('#') ||
      (allowDataImage &&
        /^data:image\//i.test(trimmed) &&
        !/^data:text\/html/i.test(trimmed));
    if (!ok) delete attribs.href;
  }
  return attribs;
}

// Comprehensive SVG element allowlist (SVG 1.1 / 2.0). No foreignObject (HTML
// embedding), no script/a/iframe/link/base. `style` is allowed because its CSS
// content is sanitized by sanitizeStyleBlock after parsing.
const allowedTags = [
  // Structure
  'svg',
  'g',
  'defs',
  'symbol',
  'use',
  'marker',
  'clipPath',
  'mask',
  'pattern',
  'style',
  // Shapes
  'circle',
  'ellipse',
  'line',
  'path',
  'polygon',
  'polyline',
  'rect',
  // Text
  'text',
  'tspan',
  'textPath',
  // Gradients and filters
  'linearGradient',
  'radialGradient',
  'stop',
  'filter',
  'feBlend',
  'feColorMatrix',
  'feComponentTransfer',
  'feComposite',
  'feConvolveMatrix',
  'feDiffuseLighting',
  'feDisplacementMap',
  'feFlood',
  'feGaussianBlur',
  'feImage',
  'feMerge',
  'feMergeNode',
  'feMorphology',
  'feOffset',
  'feSpecularLighting',
  'feTile',
  'feTurbulence',
  'feDistantLight',
  'fePointLight',
  'feSpotLight',
  'feFuncR',
  'feFuncG',
  'feFuncB',
  'feFuncA',
  // Other
  'image',
  'title',
  'desc',
  'metadata',
];

const allowedAttributes: { [key: string]: string[] } = {
  // Global SVG attributes (apply to all tags)
  '*': [
    'id',
    'class',
    'style',
    'transform',
    'fill',
    'fill-opacity',
    'fill-rule',
    'stroke',
    'stroke-width',
    'stroke-opacity',
    'stroke-linecap',
    'stroke-linejoin',
    'stroke-dasharray',
    'stroke-dashoffset',
    'opacity',
    'visibility',
    'display',
    'clip-path',
    'clip-rule',
    'mask',
    'filter',
    'color',
    'color-interpolation',
  ],
  svg: [
    'xmlns',
    'xmlns:xlink',
    'viewBox',
    'preserveAspectRatio',
    'width',
    'height',
    'x',
    'y',
    'version',
    'baseProfile',
  ],
  circle: ['cx', 'cy', 'r'],
  ellipse: ['cx', 'cy', 'rx', 'ry'],
  line: ['x1', 'y1', 'x2', 'y2'],
  path: ['d', 'pathLength'],
  polygon: ['points'],
  polyline: ['points'],
  rect: ['x', 'y', 'width', 'height', 'rx', 'ry'],
  text: [
    'x',
    'y',
    'dx',
    'dy',
    'text-anchor',
    'font-family',
    'font-size',
    'font-weight',
  ],
  tspan: ['x', 'y', 'dx', 'dy', 'text-anchor'],
  textPath: ['href', 'startOffset', 'method', 'spacing'],
  use: ['href', 'x', 'y', 'width', 'height'],
  image: ['href', 'x', 'y', 'width', 'height', 'preserveAspectRatio'],
  feImage: [
    'href',
    'result',
    'x',
    'y',
    'width',
    'height',
    'preserveAspectRatio',
  ],
  linearGradient: [
    'id',
    'x1',
    'y1',
    'x2',
    'y2',
    'gradientUnits',
    'gradientTransform',
  ],
  radialGradient: [
    'id',
    'cx',
    'cy',
    'r',
    'fx',
    'fy',
    'gradientUnits',
    'gradientTransform',
  ],
  stop: ['offset', 'stop-color', 'stop-opacity'],
  pattern: [
    'id',
    'x',
    'y',
    'width',
    'height',
    'patternUnits',
    'patternTransform',
  ],
  marker: [
    'id',
    'markerWidth',
    'markerHeight',
    'refX',
    'refY',
    'orient',
    'markerUnits',
  ],
  clipPath: ['id', 'clipPathUnits'],
  mask: ['id', 'x', 'y', 'width', 'height', 'maskUnits', 'maskContentUnits'],
  filter: ['id', 'x', 'y', 'width', 'height', 'filterUnits', 'primitiveUnits'],
  g: ['id', 'transform'],
  defs: ['id'],
  symbol: ['id', 'viewBox', 'preserveAspectRatio'],
};

const STYLE_BLOCK_REGEX = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;

const TOO_DEEP = new Error('SVG too deep or too many <style> elements');

// Parse as SVG does: honour self-closing tags everywhere. In HTML mode a
// `<style/>` inside <desc>/<title> (HTML integration points) would open a raw
// text element that swallows entity-encoded markup, which is then emitted
// decoded, e.g. `<desc><style/>&lt;img onerror=…&gt;` → a live <img>.
const PARSER_OPTIONS = {
  decodeEntities: true,
  lowerCaseTags: false,
  lowerCaseAttributeNames: false,
  recognizeSelfClosing: true,
};

const ALLOWED_TAGS_LOWER = new Set(allowedTags.map(tag => tag.toLowerCase()));
const TAG_START = /<\/?([A-Za-z][\w:-]*)/y;

/**
 * Safety net on the final output: every '<' must open or close an allowlisted
 * element, and no tag may carry an event-handler attribute. sanitize-html
 * escapes '<' in text and attribute values, so a raw '<' anywhere else means
 * markup got through (e.g. inside a <style> or <title>). Linear, and
 * independent of how any parser treats raw-text elements.
 */
function isInertMarkup(html: string): boolean {
  let i = html.indexOf('<');
  while (i !== -1) {
    TAG_START.lastIndex = i;
    const match = TAG_START.exec(html);
    if (!match || !ALLOWED_TAGS_LOWER.has(match[1].toLowerCase())) return false;
    const end = scanAttributes(html, TAG_START.lastIndex);
    if (end === -1) return false;
    i = html.indexOf('<', end);
  }
  return true;
}

/**
 * Walk a tag's attributes from `i` (just past the tag name). Returns the
 * index of the closing '>', or -1 if the tag is malformed or has an event
 * handler attribute. Only attribute names are checked: quoted values are
 * skipped, so text like title="turn onx=1" isn't mistaken for a handler.
 */
function scanAttributes(html: string, i: number): number {
  const WHITESPACE = /\s/;
  for (;;) {
    while (i < html.length && WHITESPACE.test(html[i])) i++;
    if (i >= html.length) return -1;
    if (html[i] === '>') return i;
    if (html[i] === '/') {
      i++;
      continue;
    }
    const nameStart = i;
    while (i < html.length && !/[\s/>=]/.test(html[i])) i++;
    if (/^on/i.test(html.slice(nameStart, i))) return -1;
    while (i < html.length && WHITESPACE.test(html[i])) i++;
    if (html[i] !== '=') continue;
    i++;
    while (i < html.length && WHITESPACE.test(html[i])) i++;
    const quote = html[i];
    if (quote === '"' || quote === "'") {
      const close = html.indexOf(quote, i + 1);
      if (close === -1) return -1;
      i = close + 1;
    } else {
      while (i < html.length && !/[\s>]/.test(html[i])) i++;
    }
  }
}

/**
 * True if elements nest deeper than `max` or there are more than
 * MAX_STYLE_ELEMENTS <style> elements. Uses the same parser (and options) as
 * sanitize-html, and stops as soon as a limit is crossed, so the parser's
 * element stack never grows past `max`.
 */
function exceedsLimits(svg: string, max: number): boolean {
  let depth = 0;
  let styles = 0;
  const parser = new Parser(
    {
      onopentagname(name) {
        if (++depth > max) throw TOO_DEEP;
        if (name.toLowerCase() === 'style' && ++styles > MAX_STYLE_ELEMENTS) {
          throw TOO_DEEP;
        }
      },
      onclosetag() {
        depth--;
      },
    },
    PARSER_OPTIONS
  );
  try {
    parser.write(svg);
    parser.end();
  } catch (error) {
    if (error === TOO_DEEP) return true;
    throw error;
  }
  return false;
}

/**
 * Sanitize SVG content to prevent XSS, phishing, and external resource loading.
 *
 * This is the same engine the resolver applies to inline/on-chain SVG avatars,
 * exported so you can apply it to SVG bytes you fetch yourself — e.g. a remote
 * `http(s)` SVG avatar, which `getAvatar` returns as an unsanitized URL — before
 * inlining them into the DOM. (No need to call it when rendering remote SVGs via
 * a sandboxed context like `<img>`, CSS `background-image`, or `<image href>`.)
 *
 * Returns '' (fail closed) for SVGs longer than `maxLength` or nested deeper
 * than 256 elements, or with more than 64 <style> elements.
 *
 * @param svg - Raw SVG string
 * @param options.maxLength - Maximum input length @default 262144 (256 KiB)
 * @returns Sanitized SVG string
 */
export function sanitizeSVG(
  svg: string,
  { maxLength = DEFAULT_MAX_SVG_LENGTH }: { maxLength?: number } = {}
): string {
  assertLimit('maxLength', maxLength);
  if (svg.length > maxLength) return '';
  if (exceedsLimits(svg, MAX_SVG_NESTING_DEPTH)) return '';

  const cleaned = sanitizeHtml(svg, {
    allowedTags,
    allowedAttributes,
    // <style> content is sanitized by sanitizeStyleBlock below, not by sanitize-html.
    allowVulnerableTags: true,
    // Preserve case for SVG elements/attributes (viewBox, clipPath, …).
    parser: PARSER_OPTIONS,
    // Drop <style> whose text holds markup or entities (see below).
    exclusiveFilter: frame => frame.tag === 'style' && /[<&]/.test(frame.text),
    allowedSchemes: ['http', 'https', 'data'],
    allowedSchemesByTag: {
      // image/feImage: only data:image/* (transform enforces further) — no external loading.
      image: ['data'],
      feImage: ['data'],
      // use/textPath: no schemes — only internal fragment references (#id).
      use: [],
      textPath: [],
    },
    disallowedTagsMode: 'discard',
    allowIframeRelativeUrls: false,
    transformTags: {
      '*': (tagName, attribs) => {
        if (typeof attribs.style === 'string') {
          const clean = sanitizeStyleAttribute(attribs.style);
          if (clean) attribs.style = clean;
          else delete attribs.style;
        }
        return { tagName, attribs };
      },
      use: (tagName, attribs) => ({
        tagName,
        attribs: restrictHref(attribs, false),
      }),
      textPath: (tagName, attribs) => ({
        tagName,
        attribs: restrictHref(attribs, false),
      }),
      image: (tagName, attribs) => ({
        tagName,
        attribs: restrictHref(attribs, true),
      }),
      feImage: (tagName, attribs) => ({
        tagName,
        attribs: restrictHref(attribs, true),
      }),
    },
  });

  // Second pass: sanitize the CSS inside any surviving <style> blocks. sanitize-html
  // keeps their content verbatim; here we run it through the same allowlist.
  let parseBudget = MAX_STYLE_PARSE_LENGTH;
  let styleBudget = MAX_STYLE_OUTPUT_LENGTH;
  const output = cleaned.replace(STYLE_BLOCK_REGEX, (_match, css: string) => {
    if (css.length > MAX_STYLE_BLOCK_LENGTH || css.length > parseBudget) {
      return '';
    }
    parseBudget -= css.length;
    const safe = sanitizeStyleBlock(css);
    // Inlined into HTML, <style> inside <svg> is parsed as markup, not raw
    // text: a '<' (or an entity that decodes to one) in the CSS would become a
    // live element. CSS never needs them, so drop such blocks.
    if (!safe || /[<&]/.test(safe)) return '';
    if (safe.length > styleBudget) return '';
    styleBudget -= safe.length;
    return `<style>${safe}</style>`;
  });
  return isInertMarkup(output) ? output : '';
}
