import { JSDOM } from 'jsdom';
import { getImageURI } from '../src/utils';
import {
  MAX_SVG_ATTRIBUTES,
  MAX_SVG_BYTES,
  MAX_SVG_ELEMENTS,
  exceedsSVGLimits,
} from '../src/utils/getImageURI';

const jsdomWindow = new JSDOM().window;
const svgOf = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${body}</svg>`;

describe('inline SVG limits', () => {
  it('uses the documented defaults', () => {
    expect(MAX_SVG_BYTES).toBe(1_000_000);
    expect(MAX_SVG_ELEMENTS).toBe(20_000);
    expect(MAX_SVG_ATTRIBUTES).toBe(40_000);
  });

  it('accepts a dense pixel-art SVG (64x64 rects) with the defaults', () => {
    let rects = '';
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="#${(
          (x * 4096 + y * 64) %
          0xffffff
        )
          .toString(16)
          .padStart(6, '0')}"/>`;
      }
    }
    const out = getImageURI({ metadata: { image: svgOf(rects) }, jsdomWindow });
    expect(out).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it('counts elements and attributes from the parser', () => {
    const svg = svgOf('<rect x="1" y="2"/><g><circle r="3"/></g>');
    // 4 elements (svg, rect, g, circle), 5 attributes (xmlns, viewBox, x, y, r)
    expect(exceedsSVGLimits(svg, 4, 5)).toBe(false);
    expect(exceedsSVGLimits(svg, 3, 5)).toBe(true);
    expect(exceedsSVGLimits(svg, 4, 4)).toBe(true);
  });

  it('rejects an SVG over maxSvgElements before sanitizing', () => {
    const svg = svgOf('<g/><g/><g/>');
    expect(
      getImageURI({ metadata: { image: svg }, jsdomWindow, maxSvgElements: 3 })
    ).toBeNull();
    expect(
      getImageURI({ metadata: { image: svg }, jsdomWindow, maxSvgElements: 4 })
    ).not.toBeNull();
  });

  it('rejects an SVG over maxSvgAttributes before sanitizing', () => {
    const svg = svgOf('<rect a="1" b="2" c="3"/>');
    expect(
      getImageURI({
        metadata: { image: svg },
        jsdomWindow,
        maxSvgAttributes: 4,
      })
    ).toBeNull();
    expect(
      getImageURI({
        metadata: { image: svg },
        jsdomWindow,
        maxSvgAttributes: 5,
      })
    ).not.toBeNull();
  });

  it('rejects an SVG over maxSvgBytes (UTF-8 bytes) before decoding further', () => {
    const svg = svgOf('<text>中中中</text>');
    const bytes = Buffer.byteLength(svg, 'utf8');
    expect(
      getImageURI({
        metadata: { image: svg },
        jsdomWindow,
        maxSvgBytes: bytes - 1,
      })
    ).toBeNull();
    expect(
      getImageURI({ metadata: { image: svg }, jsdomWindow, maxSvgBytes: bytes })
    ).not.toBeNull();
  });

  it('applies the byte limit to base64 SVG data URIs after decoding', () => {
    const svg = svgOf('<rect/>');
    const uri = `data:image/svg+xml;base64,${Buffer.from(svg).toString(
      'base64'
    )}`;
    const bytes = Buffer.byteLength(svg, 'utf8');
    expect(
      getImageURI({
        metadata: { image: uri },
        jsdomWindow,
        maxSvgBytes: bytes - 1,
      })
    ).toBeNull();
    expect(
      getImageURI({ metadata: { image: uri }, jsdomWindow, maxSvgBytes: bytes })
    ).not.toBeNull();
  });

  it('does not reject an SVG at the limit because sanitizing expands it', () => {
    const svg = svgOf('<rect/><rect/><rect/>');
    const out = getImageURI({
      metadata: { image: svg },
      jsdomWindow,
      maxSvgBytes: Buffer.byteLength(svg, 'utf8'),
    });
    expect(out).not.toBeNull();
    // the returned markup is larger than the input (self-closing tags expanded)
    expect(Buffer.from(out!.split(',')[1], 'base64').length).toBeGreaterThan(
      Buffer.byteLength(svg, 'utf8')
    );
  });

  it('entity-encoded text does not count as elements', () => {
    const svg = svgOf('<text>&lt;g/&gt;&lt;g/&gt;&lt;g/&gt;</text>');
    // svg + text only: the encoded "tags" are text, not elements
    expect(exceedsSVGLimits(svg, 2, 10)).toBe(false);
  });
});
