import { Parser } from 'htmlparser2';
import { parseFragment } from 'parse5';
import { getImageURI, sanitizeSVG, sanitizeSVGDocument } from '../src/utils';
import { hasWellFormedMarkupStarts } from '../src/utils/sanitize';

const SVG_NS = 'http://www.w3.org/2000/svg';
const X = `xmlns="${SVG_NS}"`;

// ---------------------------------------------------------------------------
// Helpers: an independent view of the output (not the library's own checks)
// ---------------------------------------------------------------------------

interface Tag {
  name: string;
  attribs: Record<string, string>;
}

function tagsOf(svg: string): Tag[] {
  const tags: Tag[] = [];
  const parser = new Parser(
    { onopentag: (name, attribs) => tags.push({ name, attribs }) },
    { xmlMode: true }
  );
  parser.write(svg);
  parser.end();
  return tags;
}

/** Every url( target in the output, lowercased, quotes and entities stripped. */
function urlTargets(svg: string): string[] {
  const text = svg
    .toLowerCase()
    .replace(/&quot;|&#34;|&#x22;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/g, "'");
  const targets: string[] = [];
  let i = text.indexOf('url(');
  while (i !== -1) {
    const close = text.indexOf(')', i + 4);
    targets.push(
      text
        .slice(i + 4, close === -1 ? undefined : close)
        .trim()
        .replace(/^["']/, '')
    );
    i = text.indexOf('url(', i + 4);
  }
  return targets;
}

function expectSafe(out: string | null) {
  if (out === null) return;
  expect(out.startsWith('<svg')).toBe(true);
  expect(out.endsWith('</svg>')).toBe(true);
  const tags = tagsOf(out);
  for (const tag of tags) {
    const name = tag.name.toLowerCase();
    expect([
      'script',
      'foreignobject',
      'a',
      'animate',
      'set',
      'iframe',
    ]).not.toContain(name);
    if (name === 'svg') expect(tag.attribs.xmlns).toBe(SVG_NS);
    for (const attr of Object.keys(tag.attribs)) {
      expect(attr.toLowerCase().startsWith('on')).toBe(false);
    }
  }
  const lower = out.toLowerCase();
  for (const needle of [
    '<script',
    '<foreignobject',
    '<iframe',
    // eslint-disable-next-line no-script-url
    'javascript:',
    'data:text/html',
    'evil.example',
    'src(',
    '@import',
    '@font-face',
  ]) {
    expect(lower).not.toContain(needle);
  }
  for (const target of urlTargets(out)) {
    expect(target.startsWith('#')).toBe(true);
  }
}

const elapsed = (fn: () => void) => {
  const start = Date.now();
  fn();
  return Date.now() - start;
};

// ---------------------------------------------------------------------------
// Attack vectors
// ---------------------------------------------------------------------------

const VECTORS: [string, string][] = [
  ['onload', `<svg ${X} onload="alert(1)"/>`],
  ['script', `<svg ${X}><script>alert(1)</script></svg>`],
  [
    'a javascript:',
    `<svg ${X}><a href="javascript:alert(1)"><text>x</text></a></svg>`,
  ],
  [
    'animate href',
    `<svg ${X}><animate attributeName="href" to="javascript:alert(1)"/></svg>`,
  ],
  [
    'foreignObject',
    `<svg ${X}><foreignObject><iframe src="javascript:alert(1)"/></foreignObject></svg>`,
  ],
  [
    'DTD entity',
    `<!DOCTYPE svg [<!ENTITY x "&#60;script&#62;alert(1)&#60;/script&#62;">]><svg ${X}><text>&x;</text></svg>`,
  ],
  [
    'desc/style trick',
    `<svg ${X}><desc><style/>&lt;img src=x onerror=alert(1)&gt;</desc></svg>`,
  ],
  [
    'title CDATA',
    `<svg ${X}><title><![CDATA[</title><script>alert(1)</script>]]></title></svg>`,
  ],
  [
    'prefixed script',
    `<svg ${X} xmlns:h="http://www.w3.org/1999/xhtml"><h:script>alert(1)</h:script></svg>`,
  ],
  [
    'xhtml ns switch',
    `<svg xmlns="http://www.w3.org/1999/xhtml"><style>*{color:red}</style></svg>`,
  ],
  [
    'use external',
    `<svg ${X}><use href="https://evil.example/x.svg#a"/></svg>`,
  ],
  [
    'use data svg',
    `<svg ${X}><use href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=#a"/></svg>`,
  ],
  [
    'use xlink external',
    `<svg ${X} xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="https://evil.example/x.svg#a"/></svg>`,
  ],
  [
    'image external',
    `<svg ${X}><image href="https://evil.example/t.png"/></svg>`,
  ],
  [
    'image data:text/html',
    `<svg ${X}><image href="data:text/html,<script>alert(1)</script>"/></svg>`,
  ],
  [
    'feImage external',
    `<svg ${X}><filter id="f"><feImage href="https://evil.example/t.png"/></filter></svg>`,
  ],
  [
    'fill attr url()',
    `<svg ${X}><rect fill="url(https://evil.example/p.svg#g)"/></svg>`,
  ],
  [
    'filter/mask/clip attr url()',
    `<svg ${X}><rect filter="url(https://evil.example/f.svg#f)" mask="url(//evil.example/m.svg#m)" clip-path="url(https://evil.example/c.svg#c)"/></svg>`,
  ],
  [
    'stroke attr url() char refs',
    `<svg ${X}><rect stroke="url(&#x68;ttps://evil.example/p#g)"/></svg>`,
  ],
  [
    'marker attr url()',
    `<svg ${X}><path d="M0 0L1 1" marker-start="url(https://evil.example/m.svg#m)"/></svg>`,
  ],
  [
    'gradient href external',
    `<svg ${X}><linearGradient id="g" href="https://evil.example/g.svg#a"/></svg>`,
  ],
  [
    'style attr url()',
    `<svg ${X}><rect style="fill:url(https://evil.example/p#g)"/></svg>`,
  ],
  [
    '@import',
    `<svg ${X}><style>@import url(https://evil.example/x.css);rect{fill:red}</style></svg>`,
  ],
  [
    '@font-face',
    `<svg ${X}><style>@font-face{font-family:x;src:url(https://evil.example/f.woff)}</style></svg>`,
  ],
  [
    'style block url()',
    `<svg ${X}><style>rect{fill:url(https://evil.example/p#g)}</style></svg>`,
  ],
  [
    '@media url()',
    `<svg ${X}><style>@media all{rect{fill:url(https://evil.example/p#g)}}</style></svg>`,
  ],
  [
    'style src()',
    `<svg ${X}><style>rect{fill:src("https://evil.example/p#g")}</style></svg>`,
  ],
  [
    'CDATA style url()',
    `<svg ${X}><style><![CDATA[rect{fill:url(https://evil.example/p#g)}]]></style></svg>`,
  ],
  [
    'text escaping',
    `<svg ${X}><text>&lt;script&gt;alert(1)&lt;/script&gt;</text></svg>`,
  ],
];

describe('sanitizeSVGDocument: attack vectors', () => {
  it.each(VECTORS)('%s', (_name, input) => {
    expectSafe(sanitizeSVGDocument(input));
  });

  it('keeps escaped text escaped', () => {
    const out = sanitizeSVGDocument(
      `<svg ${X}><text>&lt;script&gt;alert(1)&lt;/script&gt;</text></svg>`
    );
    expect(out).toContain('&lt;script&gt;');
  });

  it('pins the SVG namespace on nested svg elements too', () => {
    const out = sanitizeSVGDocument(
      `<svg ${X}><svg xmlns="http://www.w3.org/1999/xhtml"><rect/></svg></svg>`
    )!;
    expect(tagsOf(out).filter(t => t.name === 'svg')).toHaveLength(2);
    expectSafe(out);
  });
});

describe('CSS function allowlist', () => {
  const style = (css: string) =>
    sanitizeSVGDocument(`<svg ${X}><rect style="${css}"/></svg>`)!;

  it.each([
    'fill:rgb(1,2,3)',
    'fill:color-mix(in srgb, red 50%, blue)',
    'width:calc(10px + 2%)',
    'transform:translate(1px,2px) rotate(3deg)',
    'filter:drop-shadow(1px 1px 2px black)',
    'fill:url(#g)',
  ])('keeps %s', css => {
    expect(style(css)).toContain(css.split(':')[0]);
  });

  it.each([
    'fill:src("#g")',
    'fill:var(--x)',
    'fill:attr(data-x)',
    'fill:env(safe-area-inset-top)',
    'fill:paint(x)',
    'fill:-webkit-image-set(x)',
  ])('drops %s', css => {
    expect(style(css)).not.toContain('style=');
  });

  it('allows bare parentheses in at-rule params', () => {
    const out = sanitizeSVGDocument(
      `<svg ${X}><style>@media (min-width:10px){a{fill:red}}@supports not (fill:red){a{fill:blue}}</style></svg>`
    )!;
    expect(out).toContain('@media (min-width:10px)');
    expect(out).toContain('@supports not (fill:red)');
  });

  it('keeps transform functions in attributes', () => {
    const out = sanitizeSVGDocument(
      `<svg ${X}><linearGradient id="g" gradientTransform="rotate(45) scale(2)"/><g transform="matrix(1 0 0 1 10 10)"><rect/></g></svg>`
    )!;
    expect(out).toContain('gradientTransform="rotate(45) scale(2)"');
    expect(out).toContain('transform="matrix(1 0 0 1 10 10)"');
  });

  it('drops attributes with a non-allowlisted function', () => {
    const out = sanitizeSVGDocument(
      `<svg ${X}><rect fill="src(#g)" stroke="red"/></svg>`
    )!;
    expect(out).not.toContain('fill=');
    expect(out).toContain('stroke="red"');
  });
});

// ---------------------------------------------------------------------------
// Fidelity fixtures
// ---------------------------------------------------------------------------

const FIGMA = `<svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
<g filter="url(#filter0_d)"><circle cx="20" cy="16" r="12" fill="#5298FF"/></g>
<defs><filter id="filter0_d" x="0" y="0" width="40" height="40" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">
<feFlood flood-opacity="0" result="BackgroundImageFix"/>
<feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>
<feOffset dy="4"/><feGaussianBlur stdDeviation="2"/><feComposite in2="hardAlpha" operator="out"/>
<feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0"/>
<feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow"/>
<feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow" result="shape"/>
</filter></defs></svg>`;

const ILLUSTRATOR = `<svg version="1.1" id="Layer_1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" viewBox="0 0 100 100" xml:space="preserve">
<style type="text/css"><![CDATA[
      .st0{fill:url(#SVGID_1_);}
      .st1{fill:#E30613;}
]]></style>
<linearGradient id="SVGID_1_" gradientUnits="userSpaceOnUse" x1="0" y1="50" x2="100" y2="50"><stop offset="0" style="stop-color:#FFFFFF"/><stop offset="1" style="stop-color:#000000"/></linearGradient>
<rect class="st0" width="100" height="50"/><rect class="st1" y="50" width="100" height="50"/>
</svg>`;

const XLINK = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
<linearGradient id="a"><stop offset="0" stop-color="#f00"/><stop offset="1" stop-color="#00f"/></linearGradient>
<linearGradient id="b" xlink:href="#a" x1="0" x2="1" spreadMethod="reflect"/>
<radialGradient id="c" href="#a" fr="0.1"/>
<circle id="d" r="5" fill="url(#b)" stroke="#000" stroke-miterlimit="10"/><use xlink:href="#d" x="10"/>
</svg>`;

const TEXT = `<svg xmlns="http://www.w3.org/2000/svg"><text xml:space="preserve" textLength="80"><tspan font-weight="bold" font-size="12">Hello</tspan> <tspan font-style="italic">World</tspan></text></svg>`;

const NO_XMLNS = `<svg viewBox="0 0 10 10"><rect width="5" height="5"/></svg>`;

const attrsOf = (svg: string, name: string) =>
  tagsOf(svg)
    .filter(t => t.name === name)
    .map(t => t.attribs);

describe('sanitizeSVGDocument: fidelity', () => {
  it('Figma drop shadow keeps every filter primitive attribute', () => {
    const out = sanitizeSVGDocument(FIGMA)!;
    expectSafe(out);
    expect(attrsOf(out, 'svg')[0]).toMatchObject({ fill: 'none' });
    expect(attrsOf(out, 'g')[0]).toMatchObject({ filter: 'url(#filter0_d)' });
    expect(attrsOf(out, 'filter')[0]).toMatchObject({
      id: 'filter0_d',
      x: '0',
      y: '0',
      width: '40',
      height: '40',
      filterUnits: 'userSpaceOnUse',
      'color-interpolation-filters': 'sRGB',
    });
    expect(attrsOf(out, 'feFlood')[0]).toMatchObject({
      'flood-opacity': '0',
      result: 'BackgroundImageFix',
    });
    expect(attrsOf(out, 'feColorMatrix')[0]).toMatchObject({
      in: 'SourceAlpha',
      type: 'matrix',
      values: '0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0',
      result: 'hardAlpha',
    });
    expect(attrsOf(out, 'feOffset')[0]).toMatchObject({ dy: '4' });
    expect(attrsOf(out, 'feGaussianBlur')[0]).toMatchObject({
      stdDeviation: '2',
    });
    expect(attrsOf(out, 'feComposite')[0]).toMatchObject({
      in2: 'hardAlpha',
      operator: 'out',
    });
    expect(attrsOf(out, 'feBlend')[1]).toMatchObject({
      mode: 'normal',
      in: 'SourceGraphic',
      in2: 'effect1_dropShadow',
      result: 'shape',
    });
  });

  it('Illustrator CDATA style with classes and xml:space survives', () => {
    const out = sanitizeSVGDocument(ILLUSTRATOR)!;
    expectSafe(out);
    expect(out).toContain('.st0{fill:url(#SVGID_1_);}');
    expect(out).toContain('.st1{fill:#E30613;}');
    expect(out).not.toContain('CDATA');
    expect(attrsOf(out, 'svg')[0]).toMatchObject({ 'xml:space': 'preserve' });
    expect(attrsOf(out, 'stop')[0]).toMatchObject({
      style: 'stop-color:#FFFFFF',
    });
    expect(attrsOf(out, 'linearGradient')[0]).toMatchObject({
      gradientUnits: 'userSpaceOnUse',
    });
  });

  it('xlink:href becomes href; gradient inheritance and <use> work', () => {
    const out = sanitizeSVGDocument(XLINK)!;
    expectSafe(out);
    expect(out).not.toContain('xlink');
    expect(attrsOf(out, 'linearGradient')[1]).toMatchObject({
      href: '#a',
      spreadMethod: 'reflect',
    });
    expect(attrsOf(out, 'radialGradient')[0]).toMatchObject({
      href: '#a',
      fr: '0.1',
    });
    expect(attrsOf(out, 'circle')[0]).toMatchObject({
      fill: 'url(#b)',
      'stroke-miterlimit': '10',
    });
    expect(attrsOf(out, 'use')[0]).toMatchObject({ href: '#d', x: '10' });
  });

  it('href wins over xlink:href', () => {
    const out = sanitizeSVGDocument(
      `<svg ${X}><use href="#a" xlink:href="#b"/></svg>`
    )!;
    expect(attrsOf(out, 'use')[0]).toEqual({ href: '#a' });
  });

  it('tspan attributes and the space between tspans survive', () => {
    const out = sanitizeSVGDocument(TEXT)!;
    expectSafe(out);
    expect(attrsOf(out, 'text')[0]).toMatchObject({
      'xml:space': 'preserve',
      textLength: '80',
    });
    expect(attrsOf(out, 'tspan')[0]).toMatchObject({
      'font-weight': 'bold',
      'font-size': '12',
    });
    expect(attrsOf(out, 'tspan')[1]).toMatchObject({ 'font-style': 'italic' });
    expect(out).toContain('</tspan> <tspan');
  });

  it('a root without xmlns gains the SVG namespace', () => {
    const out = sanitizeSVGDocument(NO_XMLNS)!;
    expect(attrsOf(out, 'svg')[0].xmlns).toBe(SVG_NS);
    expect(attrsOf(out, 'rect')[0]).toMatchObject({ width: '5', height: '5' });
  });

  it('feDropShadow is allowed', () => {
    const out = sanitizeSVGDocument(
      `<svg ${X}><filter id="s"><feDropShadow dx="1" dy="2" stdDeviation="3" flood-color="#000"/></filter></svg>`
    )!;
    expect(attrsOf(out, 'feDropShadow')[0]).toMatchObject({
      dx: '1',
      dy: '2',
      stdDeviation: '3',
      'flood-color': '#000',
    });
  });

  it('pattern and text attributes from item 8 survive', () => {
    const out = sanitizeSVGDocument(
      `<svg ${X}><pattern id="p" viewBox="0 0 4 4" preserveAspectRatio="none" patternContentUnits="objectBoundingBox"/><text lengthAdjust="spacing" rotate="10">a</text></svg>`
    )!;
    expect(attrsOf(out, 'pattern')[0]).toMatchObject({
      viewBox: '0 0 4 4',
      preserveAspectRatio: 'none',
      patternContentUnits: 'objectBoundingBox',
    });
    expect(attrsOf(out, 'text')[0]).toMatchObject({
      lengthAdjust: 'spacing',
      rotate: '10',
    });
  });

  it('a DOCTYPE internal subset leaves no text outside the root', () => {
    const out = sanitizeSVGDocument(
      `<!DOCTYPE svg [<!ENTITY a "b">]><svg ${X}><rect/></svg>`
    )!;
    expect(out.startsWith('<svg')).toBe(true);
    // bare sanitizeSVG keeps the stray text
    expect(
      sanitizeSVG(`<!DOCTYPE svg [<!ENTITY a "b">]><svg ${X}><rect/></svg>`)
    ).toContain(']&gt;');
  });

  it('returns null when there is no root or the input is over maxLength', () => {
    expect(sanitizeSVGDocument('<div>x</div>')).toBeNull();
    expect(sanitizeSVGDocument(TEXT, { maxLength: 10 })).toBeNull();
  });

  it('getImageURI keeps the space between tspans (no whitespace collapsing)', () => {
    const uri = getImageURI({ metadata: { image: TEXT } })!;
    const out = Buffer.from(uri.split(',')[1], 'base64').toString();
    expect(out).toContain('</tspan> <tspan');
  });
});

describe('CDATA in <style>', () => {
  it('unwraps a single CDATA section', () => {
    const out = sanitizeSVGDocument(
      `<svg ${X}><style> <![CDATA[.a{fill:red}]]> </style></svg>`
    )!;
    expect(out).toContain('<style>.a{fill:red}</style>');
  });

  it('still drops a style block with other markup or entities', () => {
    for (const css of [
      '<![CDATA[.a{fill:red}]]><![CDATA[.b{}]]>',
      '.a{fill:red}<x>',
      '.a{content:"&amp;"}',
    ]) {
      expect(
        sanitizeSVGDocument(`<svg ${X}><style>${css}</style></svg>`)
      ).not.toContain('<style>');
    }
  });
});

describe('linear-time scans for the new checks', () => {
  const MAX = 1024 * 1024;
  const fill = (head: string, unit: string, tail: string) =>
    head +
    unit.repeat(Math.floor((MAX - head.length - tail.length) / unit.length)) +
    tail;

  it.each([
    [
      'attribute with many "("',
      fill(`<svg ${X}><rect fill="`, '(', '"/></svg>'),
    ],
    [
      'attribute with many "name("',
      fill(`<svg ${X}><rect transform="`, 'matrix(', '"/></svg>'),
    ],
    [
      'style block with many "name("',
      fill(`<svg ${X}><style>a{fill:`, 'rgb(', '}</style></svg>'),
    ],
    [
      'many url(#a)',
      fill(`<svg ${X}><rect style="`, 'fill:url(#a);', '"/></svg>'),
    ],
  ])('%s at 1 MiB', (_name, input) => {
    expect(
      elapsed(() => sanitizeSVGDocument(input, { maxLength: MAX }))
    ).toBeLessThan(1500);
  });
});

describe('malformed "<" is rejected before parsing', () => {
  it.each([
    ['a tag', `<svg ${X}><rect/></svg>`],
    ['an end tag', '</g>'],
    ['a comment containing <', `<svg ${X}><!-- a < b --><rect/></svg>`],
    ['CDATA containing <', `<svg ${X}><style><![CDATA[a<b{}]]></style></svg>`],
    ['a processing instruction', `<?xml version="1.0"?><svg ${X}/>`],
    [
      'a DOCTYPE with an internal subset',
      `<!DOCTYPE svg [<!ENTITY a "b">]><svg ${X}/>`,
    ],
    ['a non-ASCII element name', '<ö/>'],
  ])('allows %s', (_label, svg) => {
    expect(hasWellFormedMarkupStarts(svg)).toBe(true);
  });

  it.each([
    ['a stray < in text', `<svg ${X}><text>a < b</text></svg>`],
    ['<< ', `<svg ${X}><<rect/></svg>`],
    ['< followed by a digit', `<svg ${X}><text>x<3</text></svg>`],
    ['an unterminated comment', `<svg ${X}><!-- open`],
    [
      'an unterminated CDATA section',
      `<svg ${X}><style><![CDATA[a{}</style></svg>`,
    ],
    [
      'an unterminated processing instruction',
      `<?xml version="1.0"<svg ${X}/>`,
    ],
  ])('rejects %s', (_label, svg) => {
    expect(hasWellFormedMarkupStarts(svg)).toBe(false);
    expect(sanitizeSVG(svg)).toBe('');
    expect(sanitizeSVGDocument(svg)).toBeNull();
  });

  it('rejects 1 MiB of bare "<" almost immediately (the former worst case)', () => {
    const svg = `<svg ${X}>` + '<'.repeat(1024 * 1024);
    expect(
      elapsed(() =>
        expect(sanitizeSVGDocument(svg, { maxLength: svg.length })).toBeNull()
      )
    ).toBeLessThan(200);
  });

  it('is linear on many comments and CDATA sections', () => {
    const svg =
      `<svg ${X}>` + '<!-- < --><![CDATA[<]]>'.repeat(40000) + '</svg>';
    expect(elapsed(() => hasWellFormedMarkupStarts(svg))).toBeLessThan(200);
  });
});

describe('case and CSS-escape obfuscation', () => {
  // CSS matches function names case-insensitively, and an escape can spell a
  // letter in either case: \55 \52 \4c is "URL".
  it.each([
    [
      'style attribute',
      `<svg ${X}><rect style="fill:\\55 \\52 \\4c (https://evil.example/p#g)"/></svg>`,
    ],
    [
      'presentation attribute',
      `<svg ${X}><rect fill="\\55 \\52 \\4c (https://evil.example/p#g)"/></svg>`,
    ],
    [
      '<style> block',
      `<svg ${X}><style>rect{fill:\\55 \\52 \\4c (https://evil.example/p#g)}</style></svg>`,
    ],
    [
      'mixed escapes',
      `<svg ${X}><rect style="fill:u\\52 l(https://evil.example/p#g)"/></svg>`,
    ],
    [
      'escaped src()',
      `<svg ${X}><style>rect{fill:\\53 RC("https://evil.example/p#g")}</style></svg>`,
    ],
    [
      'escaped @import',
      `<svg ${X}><style>@\\49 MPORT url(https://evil.example/x.css);a{fill:red}</style></svg>`,
    ],
    [
      'uppercase url()',
      `<svg ${X}><rect fill="URL(https://evil.example/p#g)"/></svg>`,
    ],
  ])('blocks %s', (_label, input) => {
    expectSafe(sanitizeSVGDocument(input));
  });

  it('keeps an escaped internal url()', () => {
    const out = sanitizeSVGDocument(
      `<svg ${X}><rect style="fill:\\55 RL(#g)"/></svg>`
    )!;
    expect(out).toContain('style=');
  });

  it.each([
    [
      '<STYLE>',
      `<svg ${X}><STYLE>rect{fill:url(https://evil.example/p#g)}</STYLE><rect/></svg>`,
    ],
    [
      '<Style>',
      `<svg ${X}><Style>rect{fill:src("https://evil.example/p#g")}</Style><rect/></svg>`,
    ],
    ['<SCRIPT>', `<svg ${X}><SCRIPT>alert(1)</SCRIPT><rect/></svg>`],
  ])('drops the content of %s and keeps its siblings', (_label, input) => {
    const out = sanitizeSVGDocument(input)!;
    expectSafe(out);
    expect(out).not.toMatch(/alert|evil|fill:/);
    expect(out).toContain('<rect>');
  });

  it('holds up under random case mutation and escaping', () => {
    let seed = 42;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const pick = <T>(items: T[]) => items[Math.floor(rnd() * items.length)];
    const encodeChar = (c: string) => {
      const options = [
        c.toLowerCase(),
        c.toUpperCase(),
        `\\${c
          .toLowerCase()
          .charCodeAt(0)
          .toString(16)} `,
        `\\${c
          .toUpperCase()
          .charCodeAt(0)
          .toString(16)} `,
      ];
      if (!'abcdef'.includes(c.toLowerCase()))
        options.push(`\\${pick([c.toLowerCase(), c.toUpperCase()])}`);
      return pick(options);
    };
    const encode = (word: string) => Array.from(word, encodeChar).join('');
    const makers = [
      () =>
        `<svg ${X}><rect style="fill:${encode(
          'url'
        )}(https://evil.example/p#g)"/></svg>`,
      () =>
        `<svg ${X}><rect fill="${encode(
          'url'
        )}(https://evil.example/p#g)"/></svg>`,
      () =>
        `<svg ${X}><style>rect{fill:${encode(
          'url'
        )}(https://evil.example/p#g)}</style></svg>`,
      () =>
        `<svg ${X}><style>rect{fill:${encode(
          'src'
        )}("https://evil.example/p#g")}</style></svg>`,
      () =>
        `<svg ${X}><style>@${encode(
          'import'
        )} url(https://evil.example/x.css);</style></svg>`,
      () =>
        VECTORS[Math.floor(rnd() * VECTORS.length)][1].replace(/[a-z]/gi, c =>
          rnd() < 0.5 ? c.toUpperCase() : c.toLowerCase()
        ),
    ];
    for (let i = 0; i < 600; i++) {
      const out = sanitizeSVGDocument(pick(makers)());
      if (out === null) continue;
      // decode CSS escapes the way a browser would, then check
      const css = out
        .replace(/\\([0-9a-fA-F]{1,6})[ \t\n]?/g, (_m, hex) =>
          String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff) || 0xfffd)
        )
        .replace(/\\(.)/g, '$1')
        .toLowerCase();
      expect(css).not.toMatch(
        /evil\.example|src\(|@import|javascript:|<script/
      );
      for (const target of urlTargets(css)) {
        expect(target.startsWith('#')).toBe(true);
      }
    }
  });
});

describe('review findings', () => {
  // Inside url(…) a /* */ is part of the URL, not a comment: url(/**/#a)
  // requests the path "/**/" (any path the attacker writes between the
  // markers) on the origin hosting the SVG.
  it.each([
    ['attribute', `<svg ${X}><rect fill="url(/**/#a)"/></svg>`],
    ['style attribute', `<svg ${X}><rect style="fill:url(/**/#a)"/></svg>`],
    ['<style> block', `<svg ${X}><style>rect{fill:url(/**/#a)}</style></svg>`],
    [
      'quoted',
      `<svg ${X}><style>rect{fill:url("/*/../api/x?y*/#a")}</style></svg>`,
    ],
  ])('drops url() with a comment before the fragment (%s)', (_label, input) => {
    const out = sanitizeSVGDocument(input)!;
    expect(out).not.toContain('url(');
  });

  it('keeps a comment outside url()', () => {
    const out = sanitizeSVGDocument(
      `<svg ${X}><style>rect{fill:/* note */url(#a)}</style></svg>`
    )!;
    expect(out).toContain('url(#a)');
  });

  // <desc>/<title> are HTML integration points: when inlined, their child
  // elements are parsed as HTML (an HTML <title>, page-wide <style>).
  it('drops elements inside <desc>/<title> and keeps their text', () => {
    const out = sanitizeSVGDocument(
      `<svg ${X}><desc>a<title>t</title><style>x{fill:red}</style><desc>b</desc>c</desc><rect/></svg>`
    )!;
    expect(out).toBe(
      `<svg ${X}><desc>atx{fill:red}bc</desc><rect></rect></svg>`
    );
    // parsed as a browser inlining it into a page: no HTML elements
    const htmlElements: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const walk = (node: any) => {
      if (node.tagName && node.namespaceURI !== SVG_NS)
        htmlElements.push(node.tagName);
      for (const child of node.childNodes || []) walk(child);
    };
    walk(parseFragment(out));
    expect(htmlElements).toEqual([]);
  });
});
