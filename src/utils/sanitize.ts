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

// A CSS hex escape decoded the way browsers do: code points that aren't
// valid (0, surrogates, beyond U+10FFFF) become U+FFFD.
function decodeCssHexEscape(hex: string): string {
  const codePoint = parseInt(hex, 16);
  if (
    codePoint === 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return '\ufffd';
  }
  return String.fromCodePoint(codePoint);
}

/**
 * Normalizes CSS escape sequences and comments so obfuscated payloads
 * (e.g. `ur\6c(...)`, `ur/* *​/l(...)`) are caught by the checks below.
 */
function normalizeForDetection(value: string): string {
  return decodeCssEscapes(stripCssComments(value.toLowerCase()));
}

/**
 * Decode CSS escapes and lowercase, keeping comments. Inside `url(…)` a
 * `/* *\/` is not a comment but part of the URL: `url(/**\/#a)` requests the
 * path "/**\/", so url() targets are also checked on this form.
 */
function decodeCssEscapes(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/\\([0-9a-f]{1,6})\s?/g, (_match, hex) =>
        decodeCssHexEscape(hex)
      ) // hex escapes: \6c -> l
      .replace(/\\(.)/g, '$1') // simple escapes: \l -> l
      // Escapes can spell uppercase letters (\55 \52 \4c is "URL"), and CSS
      // matches function names and keywords case-insensitively.
      .toLowerCase()
  );
}

/**
 * Returns true if a CSS value is safe: no script/binding/external-load tokens,
 * and any `url(...)` is an internal fragment reference (`url(#id)`) only.
 */
// CSS functions allowed in values. Anything else written as `name(` is
// rejected (an allowlist, not a list of known-bad tokens). Deliberately left
// out: var, env, attr, src, image-set, cross-fade, element, paint, expression.
const ALLOWED_CSS_FUNCTIONS = new Set<string>([
  'url',
  // colors
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'hwb',
  'lab',
  'lch',
  'oklab',
  'oklch',
  'color',
  'color-mix',
  'light-dark',
  // math
  'calc',
  'min',
  'max',
  'clamp',
  // transforms
  'matrix',
  'matrix3d',
  'translate',
  'translatex',
  'translatey',
  'translatez',
  'translate3d',
  'scale',
  'scalex',
  'scaley',
  'scalez',
  'scale3d',
  'rotate',
  'rotatex',
  'rotatey',
  'rotatez',
  'rotate3d',
  'skew',
  'skewx',
  'skewy',
  'perspective',
  // filters
  'blur',
  'brightness',
  'contrast',
  'drop-shadow',
  'grayscale',
  'hue-rotate',
  'invert',
  'opacity',
  'saturate',
  'sepia',
  // shapes
  'inset',
  'circle',
  'ellipse',
  'polygon',
  'path',
  // timing
  'cubic-bezier',
  'steps',
]);

const isIdentChar = (code: number) =>
  (code >= 97 && code <= 122) || // a-z (input is lowercased)
  (code >= 48 && code <= 57) || // 0-9
  code === 45 || // -
  code === 95 || // _
  code >= 0x80;

/**
 * True if every function in a normalized CSS value is allowlisted. A function
 * is an identifier immediately followed by `(` (as CSS tokenizes it), so bare
 * parentheses such as `@media (min-width: 1px)` are allowed. Each `(` looks
 * back only over the identifier before it, so the scan is linear.
 */
function hasOnlyAllowedFunctions(normalized: string): boolean {
  for (
    let paren = normalized.indexOf('(');
    paren !== -1;
    paren = normalized.indexOf('(', paren + 1)
  ) {
    let start = paren;
    while (start > 0 && isIdentChar(normalized.charCodeAt(start - 1))) start--;
    if (start === paren) continue; // bare parenthesis, not a function
    if (!ALLOWED_CSS_FUNCTIONS.has(normalized.slice(start, paren)))
      return false;
  }
  return true;
}

// Characters without which a CSS value can't call a function (`(`, or a
// `\` escape that decodes to one) or carry a dangerous keyword token
// (`javascript:`, `behavior:`, `@import`).
const NEEDS_CSS_CHECK = /[(\\:@]/;

function isSafeCssValue(value: string): boolean {
  // Fast path: most values (numbers, colors, path data) can't load anything.
  if (!NEEDS_CSS_CHECK.test(value)) return true;
  const normalized = normalizeForDetection(value);
  if (!hasOnlyAllowedFunctions(normalized)) return false;
  if (
    /expression\s*\(|javascript:|vbscript:|-moz-binding|behavior\s*:|image-set|cross-fade|@import|element\s*\(/.test(
      normalized
    )
  ) {
    return false;
  }
  // url() may only target #id: checked with comments stripped (as CSS
  // tokenizes outside url()) and with comments kept (literal inside url()).
  return (
    onlyInternalUrls(normalized) && onlyInternalUrls(decodeCssEscapes(value))
  );
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
  'feDropShadow',
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

function allowAttributes(tags: string[], attributes: string[]): void {
  for (const tag of tags) {
    allowedAttributes[tag] = Array.from(
      new Set([...(allowedAttributes[tag] || []), ...attributes])
    );
  }
}

// Presentation attributes are valid on every element (their values are
// checked like CSS), as is xml:space.
allowAttributes(['*'], [...SAFE_CSS_PROPERTIES, 'xml:space']);
// xlink:href is renamed to href before filtering, so its namespace
// declaration is never needed.
allowedAttributes.svg = allowedAttributes.svg.filter(a => a !== 'xmlns:xlink');
// Filter primitives share most of their attributes.
allowAttributes(
  allowedTags.filter(tag => tag.startsWith('fe')),
  [
    'x',
    'y',
    'width',
    'height',
    'result',
    'in',
    'in2',
    'stdDeviation',
    'edgeMode',
    'operator',
    'k1',
    'k2',
    'k3',
    'k4',
    'values',
    'type',
    'tableValues',
    'slope',
    'intercept',
    'amplitude',
    'exponent',
    'offset',
    'mode',
    'dx',
    'dy',
    'radius',
    'scale',
    'xChannelSelector',
    'yChannelSelector',
    'baseFrequency',
    'numOctaves',
    'seed',
    'stitchTiles',
    'order',
    'kernelMatrix',
    'divisor',
    'bias',
    'targetX',
    'targetY',
    'preserveAlpha',
    'kernelUnitLength',
    'surfaceScale',
    'diffuseConstant',
    'specularConstant',
    'specularExponent',
    'azimuth',
    'elevation',
    'z',
    'pointsAtX',
    'pointsAtY',
    'pointsAtZ',
    'limitingConeAngle',
  ]
);
allowAttributes(['filter'], ['color-interpolation-filters', 'href']);
allowAttributes(
  ['linearGradient', 'radialGradient'],
  ['spreadMethod', 'fr', 'href']
);
allowAttributes(
  ['pattern'],
  ['viewBox', 'preserveAspectRatio', 'patternContentUnits', 'href']
);
allowAttributes(['text', 'tspan'], ['textLength', 'lengthAdjust', 'rotate']);

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
// Elements whose href may also be an inline raster image.
const DATA_IMAGE_HREF_TAGS = new Set(['image', 'feImage']);

/**
 * The single attribute transform, for every element (sanitize-html runs only
 * one transform per tag, so this replaces the per-tag ones):
 * - xlink:href becomes href (an existing href wins), then href is restricted
 *   to #id (plus data:image/* on image/feImage);
 * - style is sanitized against the CSS allowlist;
 * - every other value is checked like a CSS value, so url() can only point
 *   at #id and only allowlisted functions survive, in attributes too;
 * - svg elements get the SVG namespace (and no other xmlns declarations), so
 *   the document can't be switched to XHTML.
 */
function transformAttributes(
  tagName: string,
  attribs: sanitizeHtml.Attributes
): sanitizeHtml.Tag {
  if (attribs['xlink:href'] !== undefined) {
    if (attribs.href === undefined) attribs.href = attribs['xlink:href'];
    delete attribs['xlink:href'];
  }
  restrictHref(attribs, DATA_IMAGE_HREF_TAGS.has(tagName));
  for (const name of Object.keys(attribs)) {
    if (name === 'href') continue;
    if (name === 'style') {
      const clean = sanitizeStyleAttribute(attribs.style);
      if (clean) attribs.style = clean;
      else delete attribs.style;
    } else if (!isSafeCssValue(attribs[name])) {
      delete attribs[name];
    }
  }
  if (tagName === 'svg') {
    for (const name of Object.keys(attribs)) {
      if (name === 'xmlns' || name.startsWith('xmlns:')) delete attribs[name];
    }
    attribs.xmlns = SVG_NAMESPACE;
  }
  return { tagName, attribs };
}

/**
 * Unwrap a single CDATA section around a <style> block's CSS (as Illustrator
 * writes them). Anything else containing '<' or '&' is still dropped.
 */
function unwrapCDATA(css: string): string {
  const match = /^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/.exec(css);
  return match ? match[1] : css;
}

/** Every upper/lower-case spelling of `word` (2^length strings). */
function caseVariants(word: string): string[] {
  return Array.from({ length: 2 ** word.length }, (_, mask) =>
    Array.from(word, (char, i) =>
      mask & (1 << i) ? char.toUpperCase() : char
    ).join('')
  );
}

// Disallowed tags whose content is dropped along with them. sanitize-html
// compares tag names exactly, and the allowlist is case-sensitive, so
// `<STYLE>` or `<Script>` would be discarded but their content kept as text;
// list every case spelling of script and style. (Renaming tags to lowercase in
// the transform instead hits a sanitize-html bug with void elements inside
// renamed tags.)
const NON_TEXT_TAGS = [
  'textarea',
  'option',
  ...caseVariants('script'),
  ...caseVariants('style'),
];

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
  // Normalizing (unescaping, comment stripping) can only produce "url(" from
  // text that contains "url", a CSS escape or a comment; skip it otherwise.
  if (!/url|\\|\/\*/i.test(html)) return true;
  return (
    onlyInternalUrls(normalizeForDetection(html)) &&
    onlyInternalUrls(decodeCssEscapes(html))
  );
}

// A quote that may open a url() target: raw, or as serialized in an attribute.
const LEADING_QUOTE = /^(?:["']|&quot;|&#34;|&#x22;|&#39;|&#x27;|&apos;)/;

/**
 * Safety net: every url( in the (normalized) output must target #… — in
 * attributes, style attributes and <style> blocks alike — so a later change
 * to an allowlist can't reopen external loads. One forward scan: each step
 * moves past the previous match, and an unterminated url( fails at once.
 */
function onlyInternalUrls(normalized: string): boolean {
  let i = normalized.indexOf('url');
  while (i !== -1) {
    let j = i + 3;
    while (j < normalized.length && /\s/.test(normalized[j])) j++;
    if (normalized[j] !== '(') {
      i = normalized.indexOf('url', i + 3);
      continue;
    }
    const close = normalized.indexOf(')', j + 1);
    if (close === -1) return false;
    const target = normalized
      .slice(j + 1, close)
      .trim()
      .replace(LEADING_QUOTE, '')
      .trim();
    if (!target.startsWith('#')) return false;
    i = normalized.indexOf('url', close + 1);
  }
  return true;
}

/**
 * Walk a tag's attributes from `i` (just past the tag name). Returns the
 * index of the closing '>', or -1 if the tag is malformed or has an event
 * handler attribute. Only attribute names are checked: quoted values are
 * skipped, so text like title="turn onx=1" isn't mistaken for a handler.
 */
// HTML whitespace (tab, LF, FF, CR, space): how browsers split attributes.
const isHtmlSpace = (code: number) =>
  code === 32 || code === 9 || code === 10 || code === 12 || code === 13;

function scanAttributes(html: string, i: number): number {
  const length = html.length;
  const skipSpace = () => {
    while (i < length && isHtmlSpace(html.charCodeAt(i))) i++;
  };
  for (;;) {
    skipSpace();
    if (i >= length) return -1;
    const code = html.charCodeAt(i);
    if (code === 62) return i; // >
    if (code === 47) {
      // /
      i++;
      continue;
    }
    const nameStart = i;
    while (i < length) {
      const c = html.charCodeAt(i);
      if (isHtmlSpace(c) || c === 47 || c === 62 || c === 61) break; // / > =
      i++;
    }
    if (/^on/i.test(html.slice(nameStart, nameStart + 2))) return -1;
    skipSpace();
    if (html.charCodeAt(i) !== 61) continue; // =
    i++;
    skipSpace();
    const quote = html[i];
    if (quote === '"' || quote === "'") {
      const close = html.indexOf(quote, i + 1);
      if (close === -1) return -1;
      i = close + 1;
    } else {
      while (i < length) {
        const c = html.charCodeAt(i);
        if (isHtmlSpace(c) || c === 62) break;
        i++;
      }
    }
  }
}

/**
 * True if every `<` starts markup, as XML requires: a tag (a name start
 * character or `/`), a comment, a CDATA section, a processing instruction or
 * a declaration (`<!DOCTYPE`, `<!ENTITY`). A `<` anywhere else makes the
 * document malformed (no SVG renderer would display it) and is the most
 * expensive input for the sanitizer, so such input is rejected before
 * parsing. `<` inside comments, CDATA and processing instructions is legal and
 * skipped; an unterminated one is rejected. Linear: every step jumps forward.
 */
export function hasWellFormedMarkupStarts(svg: string): boolean {
  let i = svg.indexOf('<');
  while (i !== -1) {
    const next = svg.charCodeAt(i + 1);
    let resume = i + 1;
    if (
      (next >= 65 && next <= 90) || // A-Z
      (next >= 97 && next <= 122) || // a-z
      next === 95 || // _
      next === 58 || // :
      next === 47 || // /
      next >= 0x80
    ) {
      // a start or end tag
    } else if (svg.startsWith('<!--', i)) {
      const end = svg.indexOf('-->', i + 4);
      if (end === -1) return false;
      resume = end + 3;
    } else if (svg.startsWith('<![CDATA[', i)) {
      const end = svg.indexOf(']]>', i + 9);
      if (end === -1) return false;
      resume = end + 3;
    } else if (next === 63) {
      // <? … ?>
      const end = svg.indexOf('?>', i + 2);
      if (end === -1) return false;
      resume = end + 2;
    } else if (next !== 33) {
      // not "<!" (DOCTYPE / ENTITY / other declaration) either
      return false;
    }
    i = svg.indexOf('<', resume);
  }
  return true;
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
 * Returns '' (fail closed) for SVGs longer than `maxLength`, nested deeper
 * than 256 elements, with more than 64 <style> elements, or with a `<` that
 * doesn't start markup (malformed XML; see hasWellFormedMarkupStarts).
 *
 * @param svg - Raw SVG string
 * @param options.maxLength - Maximum input length @default 262144 (256 KiB)
 * @returns Sanitized SVG string
 */
// SVG <desc> and <title> hold text only. They are also HTML integration
// points: inlined into a page, their child elements are parsed as HTML, so an
// allowed <title> or <style> inside them would become an HTML element (a page
// title, page-wide CSS). Their child elements are dropped; text is kept.
const TEXT_ONLY_CONTAINERS = new Set(['desc', 'title']);
const TAG_TOKEN = /<(\/?)([A-Za-z][\w:-]*)[^>]*>/y;

/**
 * Remove element tags nested inside <desc>/<title> from sanitize-html's
 * output (where every '<' starts a tag: text and attribute values are
 * escaped, and <style> CSS contains no '<'). One forward scan.
 */
function dropElementsInTextOnlyContainers(html: string): string {
  if (!/<(?:desc|title)\b/i.test(html)) return html;
  let out = '';
  let last = 0; // start of the not-yet-copied text
  let container: string | null = null; // the open desc/title
  let nested = 0; // same-name tags opened inside it
  let i = html.indexOf('<');
  while (i !== -1) {
    TAG_TOKEN.lastIndex = i;
    const match = TAG_TOKEN.exec(html);
    if (!match) return html; // not sanitize-html output: let the net decide
    const closing = match[1] === '/';
    const name = match[2].toLowerCase();
    const end = TAG_TOKEN.lastIndex;
    if (container === null) {
      if (!closing && TEXT_ONLY_CONTAINERS.has(name)) container = name;
    } else if (closing && name === container && nested === 0) {
      container = null;
    } else {
      if (name === container) nested += closing ? -1 : 1;
      // an element inside desc/title: copy the text before it, skip the tag
      out += html.slice(last, i);
      last = end;
    }
    i = html.indexOf('<', end);
  }
  return out + html.slice(last);
}

/**
 * Keep only the root <svg> element of sanitized output. sanitize-html keeps
 * text outside the root (a DOCTYPE's internal subset comes out as `]&gt;`,
 * `<?xml?>GIF89a<svg>…` as `GIF89a<svg>…`), which makes the document invalid
 * and lets its first bytes be sniffed as another format. Returns null when
 * there is no root <svg>.
 */
export function extractSVGRoot(svg: string): string | null {
  const start = svg.search(/<svg[\s>]/);
  const end = svg.lastIndexOf('</svg>');
  if (start === -1 || end < start) return null;
  return svg.slice(start, end + '</svg>'.length);
}

/**
 * Sanitize an SVG to a standalone document: `sanitizeSVG` plus root-only
 * extraction, so the result starts with `<svg` and ends with `</svg>`.
 * Use this for SVG bytes you serve or store as a file (e.g. a fetched remote
 * avatar). Whitespace is kept as is (collapsing it would join adjacent
 * `<tspan>`s). Returns null when nothing usable remains, or the input is
 * over `maxLength`, the nesting or <style> limits, or malformed (a stray `<`).
 */
export function sanitizeSVGDocument(
  svg: string,
  options: { maxLength?: number } = {}
): string | null {
  const clean = sanitizeSVG(svg, options);
  return clean ? extractSVGRoot(clean) : null;
}

export function sanitizeSVG(
  svg: string,
  { maxLength = DEFAULT_MAX_SVG_LENGTH }: { maxLength?: number } = {}
): string {
  assertLimit('maxLength', maxLength);
  if (svg.length > maxLength) return '';
  if (!hasWellFormedMarkupStarts(svg)) return '';
  if (exceedsLimits(svg, MAX_SVG_NESTING_DEPTH)) return '';

  const cleaned = sanitizeHtml(svg, {
    allowedTags,
    allowedAttributes,
    // <style> content is sanitized by sanitizeStyleBlock below, not by sanitize-html.
    allowVulnerableTags: true,
    // Preserve case for SVG elements/attributes (viewBox, clipPath, …).
    parser: PARSER_OPTIONS,
    // Drop <style> whose text holds markup or entities (see below).
    exclusiveFilter: frame =>
      frame.tag === 'style' && /[<&]/.test(unwrapCDATA(frame.text)),
    nonTextTags: NON_TEXT_TAGS,
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
    transformTags: { '*': transformAttributes },
  });

  // Second pass: sanitize the CSS inside any surviving <style> blocks. sanitize-html
  // keeps their content verbatim; here we run it through the same allowlist.
  // Nothing to do (and no need to copy the output) without a <style>.
  if (!/<style/i.test(cleaned)) return finalize(cleaned);
  let parseBudget = MAX_STYLE_PARSE_LENGTH;
  let styleBudget = MAX_STYLE_OUTPUT_LENGTH;
  const output = cleaned.replace(
    STYLE_BLOCK_REGEX,
    (_match, rawCss: string) => {
      const css = unwrapCDATA(rawCss);
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
    }
  );
  return finalize(output);
}

function finalize(output: string): string {
  const textOnly = dropElementsInTextOnlyContainers(output);
  return isInertMarkup(textOnly) ? textOnly : '';
}
