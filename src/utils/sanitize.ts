/**
 * Platform-specific SVG sanitization
 *
 * - Browser/Node.js with JSDOM: Uses DOMPurify (battle-tested, superior SVG support)
 * - Cloudflare Workers / Node.js without JSDOM: Uses sanitize-html (parser-based, works without DOM)
 *
 * Both sanitizers are production-ready and actively maintained for security.
 */
import createDOMPurify from 'dompurify';
import sanitizeHtml from 'sanitize-html';

/**
 * Strips dangerous CSS constructs from a style attribute value.
 * Allows safe visual properties (colors, fonts, transforms, etc.)
 * while blocking url(), expression(), -moz-binding, @import, behavior —
 * all of which can trigger external resource loading or script execution.
 */
function sanitizeStyleValue(css: string): string {
  // First, normalize CSS escape sequences that could bypass pattern matching.
  // e.g. `ur\6c(evil.com)` → `url(evil.com)`, `ur\l(...)` → `url(...)`
  let clean = css;
  // Strip CSS comments (could split keywords: `ur/**/l(...)`)
  clean = clean.replace(/\/\*[\s\S]*?\*\//g, '');
  // Decode CSS hex escapes: \XX or \XXXXXX (optionally followed by one space)
  clean = clean.replace(/\\([0-9a-fA-F]{1,6})\s?/g, (_, hex) =>
    String.fromCharCode(parseInt(hex, 16))
  );
  // Decode simple backslash escapes: \l → l
  clean = clean.replace(/\\(.)/g, '$1');

  // Now apply pattern-based removal on normalized CSS
  // Remove url(...) — external resource loading / data exfiltration
  clean = clean.replace(/url\s*\([^)]*\)/gi, '');
  // Remove expression(...) — IE script execution
  clean = clean.replace(/expression\s*\([^)]*\)/gi, '');
  // Remove -moz-binding — Firefox XBL script execution
  clean = clean.replace(/-moz-binding\s*:[^;]*(;|$)/gi, '$1');
  // Remove behavior — IE HTC script execution
  clean = clean.replace(/behavior\s*:[^;]*(;|$)/gi, '$1');
  // Remove @import — external stylesheet loading
  clean = clean.replace(/@import\s+[^;]*(;|$)/gi, '$1');
  return clean.trim();
}

/**
 * Sanitize SVG content to prevent XSS attacks
 * @param svg - Raw SVG string
 * @param jsdomWindow - Optional JSDOM window (required for Node.js when using DOMPurify)
 * @returns Sanitized SVG string
 */
export function sanitizeSVG(svg: string, jsdomWindow?: any): string {
  // Determine if we have a usable DOM window for DOMPurify
  let domWindow: any = jsdomWindow;
  if (!domWindow) {
    try {
      if (typeof window !== 'undefined') {
        domWindow = window;
      }
    } catch {
      // window reference throws in some environments
    }
  }

  // Strategy 1: DOMPurify (when we have a DOM window)
  if (domWindow) {
    try {
      return sanitizeWithDOMPurify(svg, domWindow);
    } catch {
      // Fall back to sanitize-html if DOMPurify fails
    }
  }

  // Strategy 2: sanitize-html (no DOM available — CF Workers, Node.js without JSDOM)
  return sanitizeWithSanitizeHtml(svg);
}

/**
 * DOMPurify-based sanitization (Browser/Node.js with DOM)
 * Requires a window object (native in browser, JSDOM in Node.js)
 */
function sanitizeWithDOMPurify(svg: string, domWindow: any): string {
  const DOMPurify = createDOMPurify(domWindow);

  // Remove any previously accumulated hooks before adding new ones
  DOMPurify.removeAllHooks();

  // Hook: Remove meta refresh tags (phishing vector)
  DOMPurify.addHook('uponSanitizeElement', (node: any, data: any) => {
    if (data.tagName === 'meta') {
      if (node.getAttribute('http-equiv') === 'refresh') {
        node.remove();
      }
    }
  });

  // Hook: Block dangerous URL schemes in href attributes
  DOMPurify.addHook('uponSanitizeAttribute', (node: any, data: any) => {
    if (data.attrName === 'xlink:href' || data.attrName === 'href') {
      const value = data.attrValue;
      if (value && typeof value === 'string') {
        const normalized = value.toLowerCase().trim();
        if (
          normalized.startsWith('javascript:') ||
          normalized.startsWith('data:text/html') ||
          normalized.startsWith('vbscript:')
        ) {
          data.keepAttr = false;
          node.removeAttribute(data.attrName);
        }
      }
    }
  });

  // Hook: Block external resource loading to prevent tracking/exfiltration.
  // SVGs served as avatar data should be self-contained — no external fetches.
  DOMPurify.addHook('afterSanitizeAttributes', (node: any) => {
    // Sanitize style attribute — keep safe CSS, strip url()/expression()/etc.
    const style = node.getAttribute('style');
    if (style) {
      const clean = sanitizeStyleValue(style);
      if (clean) {
        node.setAttribute('style', clean);
      } else {
        node.removeAttribute('style');
      }
    }

    const href = node.getAttribute('href');
    if (!href) return;

    const tagName = (node.tagName || '').toLowerCase();
    const trimmed = href.trim();

    // <use> and <textPath>: only internal fragment references (#id)
    if (tagName === 'use' || tagName === 'textpath') {
      if (!trimmed.startsWith('#')) {
        node.removeAttribute('href');
      }
      return;
    }

    // <image> and <feImage>: only data:image/* URIs (inline raster), no external loading
    if (tagName === 'image' || tagName === 'feimage') {
      if (!trimmed.startsWith('#') && !/^data:image\//i.test(trimmed)) {
        node.removeAttribute('href');
      }
      return;
    }
  });

  // Sanitize with SVG profile and forbidden tags
  const cleanDOM = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: [
      'a',
      'area',
      'base',
      'foreignObject',
      'iframe',
      'link',
      'script',
    ],
    FORBID_ATTR: ['xlink:href'],
    ADD_DATA_URI_TAGS: ['feimage'],
  });

  return cleanDOM;
}

/**
 * sanitize-html-based sanitization (Cloudflare Workers / Node.js without JSDOM)
 * Parser-based, no DOM dependency
 */
export function sanitizeWithSanitizeHtml(svg: string): string {
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
    // Other (NO foreignObject — enables HTML embedding)
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
      // image/feImage: only data:image/* (transform enforces further);
      // no http/https to prevent external resource loading = tracking
      image: ['data'],
      feImage: ['data'],
      // use/textPath: no schemes at all — only fragment references (#id)
      use: [],
      textPath: [],
    },
    disallowedTagsMode: 'discard',
    allowIframeRelativeUrls: false,
    // Transform tags to enforce strict href policies and sanitize style values
    transformTags: {
      '*': (tagName: string, attribs: any) => {
        // Sanitize style attribute on every element
        if (attribs.style && typeof attribs.style === 'string') {
          const clean = sanitizeStyleValue(attribs.style);
          if (clean) {
            attribs.style = clean;
          } else {
            delete attribs.style;
          }
        }
        return { tagName, attribs };
      },
      use: (tagName: string, attribs: any) => {
        // <use>: only allow internal fragment references
        if (attribs.href && typeof attribs.href === 'string') {
          if (!attribs.href.trim().startsWith('#')) {
            delete attribs.href;
          }
        }
        return { tagName, attribs };
      },
      textPath: (tagName: string, attribs: any) => {
        // <textPath>: only allow internal fragment references
        if (attribs.href && typeof attribs.href === 'string') {
          if (!attribs.href.trim().startsWith('#')) {
            delete attribs.href;
          }
        }
        return { tagName, attribs };
      },
      image: (tagName: string, attribs: any) => {
        if (attribs.href && typeof attribs.href === 'string') {
          const trimmed = attribs.href.trim();
          // Allow fragment references (#id) and data:image/* URIs
          if (!trimmed.startsWith('#') && !/^data:image\//i.test(trimmed)) {
            delete attribs.href;
          }
          if (trimmed.toLowerCase().startsWith('data:text/html')) {
            delete attribs.href;
          }
        }
        return { tagName, attribs };
      },
      feImage: (tagName: string, attribs: any) => {
        // Same rules as <image>: only #fragment refs and data:image/* URIs
        if (attribs.href && typeof attribs.href === 'string') {
          const trimmed = attribs.href.trim();
          if (!trimmed.startsWith('#') && !/^data:image\//i.test(trimmed)) {
            delete attribs.href;
          }
          if (trimmed.toLowerCase().startsWith('data:text/html')) {
            delete attribs.href;
          }
        }
        return { tagName, attribs };
      },
    },
  });

  return cleanSVG;
}
