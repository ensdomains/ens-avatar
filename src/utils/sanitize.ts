/**
 * Platform-specific SVG sanitization
 *
 * - Browser/Node.js: Uses DOMPurify (8.74 KB, battle-tested, superior SVG support)
 * - Cloudflare Workers: Uses sanitize-html (900 KB, parser-based, works without DOM)
 *
 * Both sanitizers are production-ready and actively maintained for security.
 */

// Detect runtime environment
const hasWindow = typeof window !== 'undefined';
const hasGlobalThis = typeof globalThis !== 'undefined';
const isCloudflareWorker =
  hasGlobalThis && !hasWindow && typeof globalThis.fetch === 'function';

/**
 * Sanitize SVG content to prevent XSS attacks
 * @param svg - Raw SVG string
 * @param jsdomWindow - Optional JSDOM window (required for Node.js when using DOMPurify)
 * @returns Sanitized SVG string
 */
export function sanitizeSVG(svg: string, jsdomWindow?: any): string {
  // Strategy 1: DOMPurify (Browser or Node.js with JSDOM)
  if (!isCloudflareWorker) {
    return sanitizeWithDOMPurify(svg, jsdomWindow);
  }

  // Strategy 2: sanitize-html (Cloudflare Workers)
  return sanitizeWithSanitizeHtml(svg);
}

/**
 * DOMPurify-based sanitization (Browser/Node.js)
 * Requires window object (native in browser, JSDOM in Node.js)
 */
function sanitizeWithDOMPurify(svg: string, jsdomWindow?: any): string {
  const createDOMPurify = require('dompurify');

  let domWindow;
  try {
    domWindow = window;
  } catch {
    // Node.js environment - require JSDOM window
    if (!jsdomWindow) {
      throw Error(
        'In Node.js environment, JSDOM window is required for DOMPurify'
      );
    }
    domWindow = jsdomWindow;
  }

  const DOMPurify = createDOMPurify(domWindow as any);

  // Add security hooks
  DOMPurify.addHook('uponSanitizeElement', (node: any, data: any) => {
    // Remove meta refresh tags (can be used for phishing)
    if (data.tagName === 'meta') {
      if (node.getAttribute('http-equiv') === 'refresh') {
        node.remove();
      }
    }
  });

  // Sanitize with SVG profile and forbidden tags
  const cleanDOM = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['a', 'area', 'base', 'iframe', 'link'],
  });

  return cleanDOM;
}

/**
 * sanitize-html-based sanitization (Cloudflare Workers)
 * Parser-based, no DOM dependency
 */
function sanitizeWithSanitizeHtml(svg: string): string {
  const sanitizeHtml = require('sanitize-html');

  // Comprehensive SVG element and attribute whitelist
  // Based on DOMPurify's SVG profile and SVG 1.1/2.0 specs
  const allowedTags = [
    // SVG root and structure
    'svg',
    'g',
    'defs',
    'symbol',
    'use',
    'marker',
    'clipPath',
    'mask',
    'pattern',
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
    'foreignObject',
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
    textPath: ['href', 'xlink:href', 'startOffset', 'method', 'spacing'],
    use: ['href', 'xlink:href', 'x', 'y', 'width', 'height'],
    image: [
      'href',
      'xlink:href',
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
    filter: [
      'id',
      'x',
      'y',
      'width',
      'height',
      'filterUnits',
      'primitiveUnits',
    ],
    g: ['id', 'transform'],
    defs: ['id'],
    symbol: ['id', 'viewBox', 'preserveAspectRatio'],
  };

  const cleanSVG = sanitizeHtml(svg, {
    allowedTags,
    allowedAttributes,
    // Preserve case for SVG elements (important!)
    parser: {
      lowerCaseTags: false,
      lowerCaseAttributeNames: false,
    },
    // Disallow all protocols except safe ones
    allowedSchemes: ['http', 'https', 'data'],
    allowedSchemesByTag: {
      image: ['http', 'https', 'data'],
      use: ['http', 'https'],
    },
    // Don't allow any iframe-related attributes
    allowIframeRelativeUrls: false,
  });

  return cleanSVG;
}
