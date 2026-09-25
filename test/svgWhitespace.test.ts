import { JSDOM } from 'jsdom';
import { getImageURI } from '../src/utils';
import { collapseTagWhitespace } from '../src/utils/getImageURI';

// The regex collapseTagWhitespace replaces (quadratic on long runs).
const reference = (s: string) => s.replace(/\s*(<[^>]+>)\s*/g, '$1');

const elapsed = (fn: () => void) => {
  const start = Date.now();
  fn();
  return Date.now() - start;
};

const decode = (uri: string | null) =>
  uri && Buffer.from(uri.split(',')[1], 'base64').toString();

describe('getImageURI whitespace normalization', () => {
  const jsdomWindow = new JSDOM().window;

  it('produces exactly the output of the old regex', () => {
    const samples = [
      '<svg>  <rect/>  </svg>',
      '  <svg>\n\t<g>  text  </g>\n</svg>  ',
      '<svg><text>a   b</text><path d="M0 0   L1 1"/></svg>',
      '<a<b> x <c>',
      '<> <b>  <>',
      'no tags at all  ',
      '<svg> <unterminated',
      '',
      '<',
      '>',
    ];
    for (const s of samples)
      expect(collapseTagWhitespace(s)).toBe(reference(s));
  });

  it('matches the old regex on random input', () => {
    const alphabet = ['<', '>', ' ', '\n', '\t', 'a', '/', '"'];
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 5000; i++) {
      let s = '';
      const len = Math.floor(rand() * 24);
      for (let j = 0; j < len; j++) {
        s += alphabet[Math.floor(rand() * alphabet.length)];
      }
      expect(collapseTagWhitespace(s)).toBe(reference(s));
    }
  });

  it('collapses whitespace between tags and keeps it inside text and attributes', () => {
    expect(collapseTagWhitespace('<g>   <rect/>\n  </g>')).toBe(
      '<g><rect/></g>'
    );
    expect(collapseTagWhitespace('<text>a   b</text>')).toBe(
      '<text>a   b</text>'
    );
    expect(collapseTagWhitespace('<path d="M0 0   L1 1"/>')).toBe(
      '<path d="M0 0   L1 1"/>'
    );
  });

  it('is linear on a long whitespace run followed by text (was quadratic)', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg">x' +
      ' '.repeat(200000) +
      'y</svg>';
    expect(elapsed(() => collapseTagWhitespace(svg))).toBeLessThan(200);
  });

  it('is linear on a long run of unterminated "<" (was quadratic)', () => {
    const svg = '<svg>' + '<'.repeat(200000);
    expect(elapsed(() => collapseTagWhitespace(svg))).toBeLessThan(200);
  });

  it('getImageURI on the long-whitespace SVG returns promptly', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg"><text>x' +
      ' '.repeat(200000) +
      'y</text></svg>';
    expect(
      elapsed(() => getImageURI({ metadata: { image: svg }, jsdomWindow }))
    ).toBeLessThan(2000);
  });

  it('a normal small SVG round-trips as before', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">\n  <rect width="10" height="10" fill="red"/>\n  <text x="1" y="5">hi there</text>\n</svg>';
    // Same input to the sanitizer as the old regex produced …
    expect(collapseTagWhitespace(svg)).toBe(reference(svg));
    // … and the sanitized image keeps its content.
    const out = decode(getImageURI({ metadata: { image: svg }, jsdomWindow }));
    const doc = new JSDOM(out!, { contentType: 'image/svg+xml' }).window
      .document;
    const rect = doc.querySelector('rect')!;
    expect(rect.getAttribute('fill')).toBe('red');
    expect(rect.getAttribute('width')).toBe('10');
    expect(doc.querySelector('text')!.textContent).toBe('hi there');
    expect(out).not.toMatch(/>\s+</);
  });
});
