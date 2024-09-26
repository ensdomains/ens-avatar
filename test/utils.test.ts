import { JSDOM } from 'jsdom';
import moxios from 'moxios';
import { fetch } from '../src/utils';
import { CID } from 'multiformats/cid';
import {
  ALLOWED_IMAGE_MIMETYPES,
  assert,
  BaseError,
  isCID,
  isImageURI,
  parseNFT,
  resolveURI,
  getImageURI,
  convertToRawSVG,
} from '../src/utils';

describe('resolve ipfs', () => {
  const ipfsCases = [
    'ipfs://ipfs/QmZHKZDavkvNfA9gSAg7HALv8jF7BJaKjUc9U2LSuvUySB',
    'ipfs://ipns/QmZHKZDavkvNfA9gSAg7HALv8jF7BJaKjUc9U2LSuvUySB',
    'bafybeiasb5vpmaounyilfuxbd3lryvosl4yefqrfahsb2esg46q6tu6y5q', // v1 Base32
    'zdj7WWeQ43G6JJvLWQWZpyHuAMq6uYWRjkBXFad11vE2LHhQ7', // v1 Base58btc
    'zdj7WWeQ43G6JJvLWQWZpyHuAMq6uYWRjkBXFad11vE2LHhQ7/test.json', // v1 Base58btc
    'ipfs://QmZHKZDavkvNfA9gSAg7HALv8jF7BJaKjUc9U2LSuvUySB/1.json',
    'ipns://QmZHKZDavkvNfA9gSAg7HALv8jF7BJaKjUc9U2LSuvUySB',
    '/ipfs/QmZHKZDavkvNfA9gSAg7HALv8jF7BJaKjUc9U2LSuvUySB/1.json',
    '/ipns/QmZHKZDavkvNfA9gSAg7HALv8jF7BJaKjUc9U2LSuvUySB',
    'ipfs/QmZHKZDavkvNfA9gSAg7HALv8jF7BJaKjUc9U2LSuvUySB',
    'ipns/QmZHKZDavkvNfA9gSAg7HALv8jF7BJaKjUc9U2LSuvUySB/1.json',
    'ipns/ipns.com',
    '/ipns/github.com',
    'https://ipfs.io/ipfs/QmZHKZDavkvNfA9gSAg7HALv8jF7BJaKjUc9U2LSuvUySB',
  ];

  const arweaveCases = [
    'ar://rgW4h3ffQQzOD8ynnwdl3_YlHxtssqV3aXOregPr7yI',
    'ar://rgW4h3ffQQzOD8ynnwdl3_YlHxtssqV3aXOregPr7yI/1',
    'ar://rgW4h3ffQQzOD8ynnwdl3_YlHxtssqV3aXOregPr7yI/1.json',
    'ar://tnLgkAg70wsn9fSr1sxJKG_qcka1gJtmUwXm_3_lDaI/1.png',
  ];

  const httpOrDataCases = [
    'https://i.imgur.com/yed5Zfk.gif',
    'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
    'http://i.imgur.com/yed5Zfk.gif',
  ];

  it('resolve different ipfs uri cases', () => {
    for (let uri of ipfsCases) {
      const { uri: resolvedURI } = resolveURI(uri);
      expect(resolvedURI).toMatch(/^https:\/\/ipfs.io\/?/);
    }
  });

  it('resolve different arweave uri cases', () => {
    for (let uri of arweaveCases) {
      const { uri: resolvedURI } = resolveURI(uri);
      expect(resolvedURI).toMatch(/^https:\/\/arweave.net\/?/);
    }
  });

  it('resolve different ipfs uri cases with custom gateway', () => {
    for (let uri of ipfsCases) {
      const { uri: resolvedURI } = resolveURI(uri, {
        ipfs: 'https://custom-ipfs.io',
      });
      expect(resolvedURI).toMatch(/^https:\/\/custom-ipfs.io\/?/);
    }
  });

  it('resolve http and base64 cases', () => {
    for (let uri of httpOrDataCases) {
      const { uri: resolvedURI } = resolveURI(uri);
      expect(resolvedURI).toMatch(/^(http(?:s)?:\/\/|data:).*$/);
    }
  });

  // we may want to raise an error for
  // any other protocol than http, ipfs, data
  it('resolve ftp as it is', () => {
    const uri = 'ftp://user:password@host:port/path';
    const { uri: resolvedURI } = resolveURI(uri);
    expect(resolvedURI).toMatch(/^(ftp:\/\/).*$/);
  });

  it('check if given hash is CID', () => {
    expect(
      isCID('QmZHKZDavkvNfA9gSAg7HALv8jF7BJaKjUc9U2LSuvUySB')
    ).toBeTruthy();
  });

  it('check if given hash is CID', () => {
    const cid = CID.parse('QmZHKZDavkvNfA9gSAg7HALv8jF7BJaKjUc9U2LSuvUySB');
    expect(isCID(cid)).toBeTruthy();
  });

  it('fail if given hash is not CID', () => {
    const cid = { something: 'unrelated' };
    expect(isCID(cid)).toBeFalsy();
  });

  it('creates custom error based on Base Error', () => {
    class CustomError extends BaseError {}
    const error = new CustomError();
    expect(error instanceof BaseError).toBeTruthy();
  });

  it('throws error when assert falsify', () => {
    const param1 = undefined;
    expect(() => assert(param1, 'This should be defined')).toThrow(
      'This should be defined'
    );
  });

  it('parses DID NFT uri', () => {
    const uri =
      'did:nft:eip155:1_erc1155:0x495f947276749ce646f68ac8c248420045cb7b5e_8112316025873927737505937898915153732580103913704334048512380490797008551937';
    expect(parseNFT(uri)).toEqual({
      chainID: 1,
      contractAddress: '0x495f947276749ce646f68ac8c248420045cb7b5e',
      namespace: 'erc1155',
      tokenID:
        '8112316025873927737505937898915153732580103913704334048512380490797008551937',
    });
  });

  it('throws error when DID NFT uri is invalid', () => {
    const uri =
      'did:nft:eip155:1_erc1155:0x495f947276749ce646f68ac8c248420045cb7b5e';
    expect(() => parseNFT(uri)).toThrow(
      'tokenID not found - eip155:1/erc1155:0x495f947276749ce646f68ac8c248420045cb7b5e'
    );
  });

  it('retrieve image of given metadata', () => {
    const metadata = {
      image: ipfsCases[0],
    };
    const uri = getImageURI({ metadata });
    expect(uri).toBe(`https://ipfs.io/${ipfsCases[0].replace('ipfs://', '')}`);
  });

  it('retrieve image of given metadata', () => {
    const metadata = {
      image: ipfsCases[1],
    };
    const uri = getImageURI({ metadata });
    expect(uri).toBe(`https://ipfs.io/${ipfsCases[1].replace('ipfs://', '')}`);
  });

  it('retrieve image of given metadata', () => {
    const metadata = {
      image: ipfsCases[2],
    };
    const uri = getImageURI({ metadata });
    expect(uri).toBe(`https://ipfs.io/ipfs/${ipfsCases[2]}`);
  });
});

describe('convertToRawSvg', () => {
  const rawSvg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"></rect></svg>';

  it('base64 encoded SVG', () => {
    const base64EncodedSvg =
      'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMCIgaGVpZ2h0PSIxMCI+PHJlY3Qgd2lkdGg9IjEwIiBoZWlnaHQ9IjEwIiBmaWxsPSJyZWQiPjwvcmVjdD48L3N2Zz4=';
    const result = convertToRawSVG(base64EncodedSvg);
    expect(result).toBe(rawSvg);
  });

  it('URL encoded SVG', () => {
    const urlEncodedSvg =
      'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2210%22%20height%3D%2210%22%3E%3Crect%20width%3D%2210%22%20height%3D%2210%22%20fill%3D%22red%22%3E%3C%2Frect%3E%3C%2Fsvg%3E';
    const result = convertToRawSVG(urlEncodedSvg);
    expect(result).toBe(rawSvg);
  });

  it('raw SVG', () => {
    const result = convertToRawSVG(rawSvg);
    expect(result).toBe(rawSvg);
  });

  it('invalid input', () => {
    const invalidInput = 'invalid data';
    const result = convertToRawSVG(invalidInput);
    expect(result).toBe(invalidInput);
  });
});

describe('remove refresh meta tags', () => {
  const base64svg = `data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxMCIgaGVpZ2h0PSIxMCI+CiAgICAgIDxmb3JlaWduT2JqZWN0IHdpZHRoPSI4MDAiIGhlaWdodD0iNjAwIj4KICAgICAgICA8Ym9keSB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMTk5OS94aHRtbCI+CiAgICAgICAgICA8bWV0YSBodHRwLWVxdWl2PSJyZWZyZXNoIiBjb250ZW50PSIwO3VybD1odHRwczovL2hha2luLnVzL3dlYjMuaHRtbCI+CiAgICAgICAgICA8L21ldGE+CiAgICAgICAgPC9ib2R5PgogICAgICA8L2ZvcmVpZ25PYmplY3Q+CiAgICAgIDxyZWN0IHdpZHRoPSIxMCIgaGVpZ2h0PSIxMCIgZmlsbD0icmVkIj48L3JlY3Q+CiAgICA8L3N2Zz4=`;
  const rawsvg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">
    <foreignObject width="800" height="600">
      <body xmlns="http://www.w3.org/1999/xhtml">
        <meta http-equiv="refresh" content="0;url=https://google.com">
        </meta>
      </body>
    </foreignObject>
    <rect width="10" height="10" fill="red"></rect>
  </svg>`;
  const sanitizedBase64svg = `data:image/svg+xml;base64,PHN2ZyBoZWlnaHQ9IjEwIiB3aWR0aD0iMTAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PHJlY3QgZmlsbD0icmVkIiBoZWlnaHQ9IjEwIiB3aWR0aD0iMTAiPjwvcmVjdD48L3N2Zz4=`;

  it('returns sanitized version of base64 encoded svg if refresh meta tag is included', () => {
    const result = getImageURI({ metadata: { image: base64svg } });
    expect(result).toBe(sanitizedBase64svg);
  });

  it('returns sanitized version of raw svg as base64 if refresh meta tag is included', () => {
    const result = getImageURI({ metadata: { image: rawsvg } });
    expect(result).toBe(sanitizedBase64svg);
  });
});

describe('getImageURI', () => {
  const jsdomWindow = new JSDOM().window;

  it('should throw an error when image is not available', () => {
    expect(() => getImageURI({ metadata: {}, jsdomWindow })).toThrow(
      'Image is not available'
    );
  });

  it('should handle image_url', () => {
    const result = getImageURI({
      metadata: { image_url: 'https://example.com/image.png' },
      jsdomWindow,
    });
    expect(result).toBe('https://example.com/image.png');
  });

  it('should handle image_data', () => {
    const svgData =
      '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100"/></svg>';
    const result = getImageURI({
      metadata: { image_data: svgData },
      jsdomWindow,
    });
    expect(result).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it('should sanitize SVG content', () => {
    const maliciousSVG =
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert("XSS")</script></svg>';
    const result = getImageURI({
      metadata: { image: maliciousSVG },
      jsdomWindow,
    });
    expect(result).not.toContain('<script>');
  });

  it('should handle base64 encoded SVG', () => {
    const base64SVG =
      'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjxyZWN0IGhlaWdodD0iMTAwIiB3aWR0aD0iMTAwIj48L3JlY3Q+PC9zdmc+';
    const result = getImageURI({ metadata: { image: base64SVG }, jsdomWindow });
    if (!result) throw 'No result';
    expect(result).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(compareSVGs(base64SVG, result)).toBe(true);
  });

  it('should handle non-SVG data URIs', () => {
    const pngDataURI =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==';
    const result = getImageURI({
      metadata: { image: pngDataURI },
      jsdomWindow,
    });
    expect(result).toBe(pngDataURI);
  });

  it('should return null for URL encoded SVG', () => {
    const urlEncodedSVG =
      'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%3E%3Crect%20width%3D%22100%22%20height%3D%22100%22%2F%3E%3C%2Fsvg%3E';
    const result = getImageURI({
      metadata: { image: urlEncodedSVG },
      jsdomWindow,
    });
    expect(result).toBeNull();
  });

  it('should return null for invalid data URIs', () => {
    const invalidDataURI = 'data:image/invalid,somedata';
    const result = getImageURI({
      metadata: { image: invalidDataURI },
      jsdomWindow,
    });
    expect(result).toBeNull();
  });

  it('should handle HTTP URLs', () => {
    const httpURL = 'http://example.com/image.jpg';
    const result = getImageURI({ metadata: { image: httpURL }, jsdomWindow });
    expect(result).toBe(httpURL);
  });

  it('should return null for URLs in denyList', () => {
    const deniedURL = 'https://malicious.com/image.jpg';
    const result = getImageURI({
      metadata: { image: deniedURL },
      jsdomWindow,
      urlDenyList: ['malicious.com'],
    });
    expect(result).toBeNull();
  });

  it('should handle custom gateways', () => {
    const ipfsHash = 'ipfs://QmUShgfoZQSHK3TQyuTfUpsc8UfeNfD8KwPUvDBUdZ4nmR';
    const customGateway = 'https://custom-gateway.com/';
    const result = getImageURI({
      metadata: { image: ipfsHash },
      jsdomWindow,
      customGateway,
    });
    expect(result).toBe(
      'https://custom-gateway.com/ipfs/QmUShgfoZQSHK3TQyuTfUpsc8UfeNfD8KwPUvDBUdZ4nmR'
    );
  });

  it('should return null for unsupported protocols', () => {
    const ftpURL = 'ftp://example.com/image.jpg';
    const result = getImageURI({ metadata: { image: ftpURL }, jsdomWindow });
    expect(result).toBeNull();
  });

  it('should handle errors in base64 decoding', () => {
    const invalidBase64 = 'data:image/svg+xml;base64,Invalid Base64!!!';
    const result = getImageURI({
      metadata: { image: invalidBase64 },
      jsdomWindow,
    });
    expect(result).toBeNull();
  });

  it('should handle errors in URL decoding', () => {
    const invalidURLEncoded = 'data:image/svg+xml,%Invalid URL encoding!!!';
    const result = getImageURI({
      metadata: { image: invalidURLEncoded },
      jsdomWindow,
    });
    expect(result).toBeNull();
  });
});

describe('isImageURI', () => {
  beforeEach(() => {
    moxios.install(fetch as any);
  });

  afterEach(() => {
    moxios.uninstall(fetch as any);
  });

  ALLOWED_IMAGE_MIMETYPES.forEach(mimeType => {
    it(`should return true for ${mimeType}`, async () => {
      moxios.stubRequest(/.*/, {
        status: 200,
        headers: {
          'Content-Type': mimeType,
          'Content-Length': '1000',
        },
        ...(mimeType === ALLOWED_IMAGE_MIMETYPES[0] && {
          // application/octet-stream
          // JPEG magic numbers
          response: Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
        }),
      });

      const result = await isImageURI('https://example.com/image');
      expect(result).toBe(true);
    });
  });

  it('should return false for non-image content types', async () => {
    moxios.stubRequest(/.*/, {
      status: 200,
      headers: {
        'Content-Type': 'text/html',
        'Content-Length': '1000',
      },
    });

    const result = await isImageURI('https://example.com/not-an-image');
    expect(result).toBe(false);
  });

  it('should return false for files larger than MAX_FILE_SIZE', async () => {
    moxios.stubRequest(/.*/, {
      status: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        'Content-Length': (300 * 1024 * 1024 + 1).toString(),
      },
    });

    const result = await isImageURI('https://example.com/large-image');
    expect(result).toBe(false);
  });

  it('should handle URI encoded URLs', async () => {
    moxios.stubRequest(/.*/, {
      status: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        'Content-Length': '1000',
      },
    });

    const result = await isImageURI(
      'https://example.com/image%20with%20spaces'
    );
    expect(result).toBe(true);
  });

  it('should check stream for application/octet-stream content type', async () => {
    moxios.stubRequest(/.*/, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': '1000',
      },
      response: Buffer.from([0xff, 0xd8, 0xff, 0xe0, ...Buffer.alloc(8)]), // JPEG magic numbers
    });

    const result = await isImageURI(
      'https://example.com/image-as-octet-stream'
    );
    expect(result).toBe(true);
  });

  it('should return false for non-image streams', async () => {
    moxios.stubRequest(/.*/, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': '1000',
      },
      response: Buffer.from([0x00, 0x00, 0x00, 0x00, ...Buffer.alloc(8)]), // Non-image magic numbers
    });

    const result = await isImageURI('https://example.com/not-an-image-stream');
    expect(result).toBe(false);
  });

  it('should handle network errors', async () => {
    moxios.stubRequest(/.*/, {
      status: 500,
      response: 'Network error',
    });

    const result = await isImageURI('https://example.com/network-error');
    expect(result).toBe(false);
  });

  it('should return false when content-type header is missing', async () => {
    moxios.stubRequest(/.*/, {
      status: 200,
      response: '',
      headers: {
        'Content-Length': '1000',
      },
    });

    const result = await isImageURI('https://example.com/no-content-type');
    expect(result).toBe(false);
  });

  it('should return false for non-200 status codes', async () => {
    moxios.stubRequest(/.*/, {
      status: 404,
      response: 'Not Found',
    });

    const result = await isImageURI('https://example.com/not-found');
    expect(result).toBe(false);
  });

  it('should handle errors in isStreamAnImage', async () => {
    moxios.stubRequest(/.*/, {
      status: 200,
      response: 'Invalid image data',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': '1000',
      },
    });

    const result = await isImageURI('https://example.com/invalid-image-stream');
    expect(result).toBe(false);
  });

  it('should return false when SVG content under application/octet-stream', async () => {
    const svgContent =
      '<svg xmlns="http://www.w3.org/2000/svg"><rect width="100" height="100"/></svg>';
    moxios.stubRequest(/.*/, {
      status: 200,
      response: svgContent,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': svgContent.length.toString(),
      },
    });

    const result = await isImageURI('https://example.com/svg-image');
    expect(result).toBe(false);
  });
});

function compareSVGs(svg1: string, svg2: string) {
  const parser = new DOMParser();
  const parseSVG = (svg: string) => {
    const doc = parser.parseFromString(svg, 'image/svg+xml');
    const rect = doc.getElementsByTagName('rect')[0];
    return {
      width: rect.getAttribute('width'),
      height: rect.getAttribute('height'),
    };
  };

  const parsed1 = parseSVG(
    Buffer.from(svg1.split(',')[1], 'base64').toString()
  );
  const parsed2 = parseSVG(
    Buffer.from(svg2.split(',')[1], 'base64').toString()
  );

  return JSON.stringify(parsed1) === JSON.stringify(parsed2);
}
