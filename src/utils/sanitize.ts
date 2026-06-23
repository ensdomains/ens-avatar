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
import { parse as parseCss } from 'postcss';

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

// At-rules that load external resources or change parsing — always removed.
const FORBIDDEN_AT_RULES = new Set<string>([
  'import',
  'charset',
  'namespace',
  'font-face',
  'apply',
]);

/**
 * Normalizes CSS escape sequences and comments so obfuscated payloads
 * (e.g. `ur\6c(...)`, `ur/* *​/l(...)`) are caught by the checks below.
 */
function normalizeForDetection(value: string): string {
  return value
    .toLowerCase()
    .replace(/\/\*[\s\S]*?\*\//g, '') // strip comments
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
  const urls = normalized.match(/url\s*\([^)]*\)/g) || [];
  for (const url of urls) {
    const inner = url
      .replace(/^url\s*\(\s*['"]?/, '')
      .replace(/['"]?\s*\)\s*$/, '')
      .trim();
    if (!inner.startsWith('#')) return false; // only internal references
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
  root.walkAtRules(atRule => {
    if (FORBIDDEN_AT_RULES.has(atRule.name.toLowerCase())) atRule.remove();
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

/**
 * Sanitize SVG content to prevent XSS, phishing, and external resource loading.
 *
 * This is the same engine the resolver applies to inline/on-chain SVG avatars,
 * exported so you can apply it to SVG bytes you fetch yourself — e.g. a remote
 * `http(s)` SVG avatar, which `getAvatar` returns as an unsanitized URL — before
 * inlining them into the DOM. (No need to call it when rendering remote SVGs via
 * a sandboxed context like `<img>`, CSS `background-image`, or `<image href>`.)
 *
 * @param svg - Raw SVG string
 * @returns Sanitized SVG string
 */
export function sanitizeSVG(svg: string): string {
  const cleaned = sanitizeHtml(svg, {
    allowedTags,
    allowedAttributes,
    // <style> content is sanitized by sanitizeStyleBlock below, not by sanitize-html.
    allowVulnerableTags: true,
    // Preserve case for SVG elements/attributes (viewBox, clipPath, …).
    parser: {
      lowerCaseTags: false,
      lowerCaseAttributeNames: false,
    },
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
  return cleaned.replace(STYLE_BLOCK_REGEX, (_match, css: string) => {
    const safe = sanitizeStyleBlock(css);
    return safe ? `<style>${safe}</style>` : '';
  });
}
