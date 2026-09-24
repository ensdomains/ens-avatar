import http from 'http';
import { AddressInfo } from 'net';
import { AvatarResolver, ChainMismatch } from '../src';
import { ChainClient } from '../src/chain/client';
import { fromViem, ViemClientLike } from '../src/chain/viem';
import {
  createFetcher,
  getImageURI,
  isCID,
  isHostDenied,
  isImageURI,
  isPrivateHostname,
  sanitizeSVG,
  validateUrl,
} from '../src/utils';
import { collapseTagWhitespace } from '../src/utils/getImageURI';
import { DEFAULT_MAX_SVG_LENGTH } from '../src/utils/sanitize';
import { Fetcher } from '../src/types';
import { detectImageMimeType } from '../src/utils/sniffImage';
import { isSvgDocument } from '../src/utils/isImageURI';
import { MAX_CACHE_ENTRIES, TTLCache } from '../src/utils/fetch';
import { toHttpURL } from '../src/utils/url';
import { resolveURI } from '../src/utils/resolveURI';
import { BaseError, MetadataParsingError } from '../src/utils/error';
import { normalizeHostname } from '../src/utils/hostname';
import { assert } from '../src/utils/assert';
import { fromEthers } from '../src/chain/ethers';
import { Interface, JsonRpcProvider } from 'ethers';

const decodeDataURI = (uri: string | null) =>
  uri && Buffer.from(uri.split(',')[1], 'base64').toString();

const elapsed = (fn: () => void) => {
  const start = Date.now();
  fn();
  return Date.now() - start;
};

// ---------------------------------------------------------------------------
// Local HTTP server for fetcher tests
// ---------------------------------------------------------------------------

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

async function startServer(handler: Handler) {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    url: (path: string, host = '127.0.0.1') => `http://${host}:${port}${path}`,
    close: () =>
      new Promise<void>(resolve => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe('inline SVG processing is linear time', () => {
  const reference = (s: string) => s.replace(/\s*(<[^>]+>)\s*/g, '$1');

  it('collapseTagWhitespace matches the regex it replaces', () => {
    const samples = [
      '<svg>  <rect/>  </svg>',
      '  <svg>\n\t<g>  text  </g>\n</svg>  ',
      '<a<b> x <c>',
      '<> <b>  <>',
      'no tags at all  ',
      '<svg> <unterminated',
      '<svg>  <  <rect/>',
      '',
      '<',
      '>',
      ' < > < ',
    ];
    for (const s of samples) {
      expect(collapseTagWhitespace(s)).toBe(reference(s));
    }
  });

  it('collapseTagWhitespace matches the regex on random input', () => {
    const alphabet = ['<', '>', ' ', '\n', 'a', '/'];
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let i = 0; i < 2000; i++) {
      const len = Math.floor(rand() * 20);
      let s = '';
      for (let j = 0; j < len; j++) s += alphabet[Math.floor(rand() * 6)];
      expect(collapseTagWhitespace(s)).toBe(reference(s));
    }
  });

  it('handles 1 MiB of unterminated "<" quickly (was ~26 minutes)', () => {
    const svg = '<svg>' + '<'.repeat(1024 * 1024);
    expect(elapsed(() => collapseTagWhitespace(svg))).toBeLessThan(1000);
  });

  it('rejects inline SVGs above DEFAULT_MAX_SVG_LENGTH', () => {
    const svg = '<svg>' + ' '.repeat(DEFAULT_MAX_SVG_LENGTH) + '</svg>';
    expect(getImageURI({ metadata: { image: svg } })).toBeNull();
    const b64 = Buffer.from(svg).toString('base64');
    expect(
      getImageURI({ metadata: { image: `data:image/svg+xml;base64,${b64}` } })
    ).toBeNull();
  });

  it('sanitizeSVG handles many unterminated url( and /* quickly', () => {
    const urls = `<svg><rect style="fill:${'url('.repeat(100000)}"/></svg>`;
    const comments = `<svg><rect style="fill:${'/*'.repeat(100000)}"/></svg>`;
    expect(elapsed(() => sanitizeSVG(urls))).toBeLessThan(2000);
    expect(elapsed(() => sanitizeSVG(comments))).toBeLessThan(2000);
  });
});

describe('sanitizeSVG CSS checks after the linear rewrite', () => {
  const style = (css: string) =>
    sanitizeSVG(`<svg><rect style="${css}"/></svg>`);

  it('keeps internal url(#id) references', () => {
    expect(style('fill:url(#grad)')).toContain('fill:url(#grad)');
    expect(style("fill:url( '#grad' )")).toContain('url');
  });

  it('drops external and unterminated url(', () => {
    expect(style('fill:url(https://evil.example/x)')).not.toContain('url');
    expect(style('fill:url(#a')).not.toContain('url');
  });

  it('still sees through comment obfuscation', () => {
    expect(style('fill:ur/**/l(https://evil.example/x)')).not.toContain('evil');
  });

  it('checks the text of an unterminated comment (fail closed)', () => {
    expect(style('fill:red /* url(https://evil.example/x)')).not.toContain(
      'evil'
    );
  });
});

describe('SVG output keeps only the root element', () => {
  it('drops text before the root', () => {
    const out = getImageURI({
      metadata: {
        image:
          "<?xml version='1.0'?>GIF89a hello<svg xmlns='http://www.w3.org/2000/svg'><rect/></svg>",
      },
    });
    expect(decodeDataURI(out)).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg"><rect></rect></svg>'
    );
  });

  it('drops text after the root', () => {
    const out = getImageURI({ metadata: { image: '<svg><rect/></svg>trail' } });
    expect(decodeDataURI(out)).toBe('<svg><rect></rect></svg>');
  });

  it('returns null when sanitizing leaves no root <svg>', () => {
    expect(
      getImageURI({ metadata: { image: '<?xml version="1.0"?><div>x</div>' } })
    ).toBeNull();
  });
});

describe('hostname normalization', () => {
  it('deny list ignores trailing dots and case', () => {
    expect(
      isHostDenied('https://metadata.ens.domains./x', ['metadata.ens.domains'])
    ).toBe(true);
    expect(
      isHostDenied('https://sub.metadata.ens.domains../x', [
        'metadata.ens.domains',
      ])
    ).toBe(true);
    expect(
      isHostDenied('https://metadata.ens.domains/x', ['Metadata.ENS.Domains.'])
    ).toBe(true);
    expect(
      isHostDenied('https://notmetadata.ens.domains/x', [
        'metadata.ens.domains',
      ])
    ).toBe(false);
  });

  it('validateUrl applies the deny list to trailing-dot hosts', () => {
    expect(() =>
      validateUrl('https://metadata.ens.domains./x', ['metadata.ens.domains'])
    ).toThrow(/denied host/);
  });

  it('classifies trailing-dot loopback names as private', () => {
    expect(isPrivateHostname('localhost.')).toBe(true);
    expect(isPrivateHostname(new URL('http://127.0.0.1../').hostname)).toBe(
      true
    );
    expect(isPrivateHostname('foo.internal.')).toBe(true);
  });
});

describe('only http(s) URLs', () => {
  it.each(['httpx://example.com/', 'ftp://example.com/', 'file:///etc/passwd'])(
    'validateUrl rejects %s',
    url => {
      expect(() => validateUrl(url)).toThrow();
    }
  );

  it('getImageURI no longer returns look-alike schemes', () => {
    expect(
      getImageURI({ metadata: { image: 'httpx://example.com/a.png' } })
    ).toBeNull();
  });
});

describe('only globally routable unicast addresses are public', () => {
  it.each([
    // IPv4 special-purpose
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.0.0.1',
    '192.0.2.1',
    '192.88.99.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '239.255.255.250',
    '240.0.0.1',
    '255.255.255.255',
    // IPv6
    '[::]',
    '[::1]',
    '[::127.0.0.1]', // IPv4-compatible
    '[::ffff:127.0.0.1]',
    '[::ffff:0:7f00:1]', // IPv4-translated
    '[64:ff9b::7f00:1]',
    '[64:ff9b:1::8.8.8.8]', // local-use NAT64
    '[100::1]',
    '[2001::1]', // Teredo
    '[2001:2::1]', // benchmarking (2001::/23)
    '[2001:db8::1]',
    '[2002:7f00:1::]', // 6to4
    '[3fff::1]',
    '[5f00::1]',
    '[fc00::1]',
    '[fe80::1]',
    '[fec0::1]',
    '[ff02::1]',
  ])('%s is not public', ip => {
    expect(isPrivateHostname(ip)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '[2606:4700:4700::1111]',
    '[2001:4860:4860::8888]',
    '[::ffff:8.8.8.8]',
    '[64:ff9b::8.8.8.8]',
  ])('%s is public', ip => {
    expect(isPrivateHostname(ip)).toBe(false);
  });
});

describe('fetcher deadline, body cap and redirects', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let received: http.IncomingHttpHeaders[] = [];
  let redirectClosed: Promise<void>;
  let markRedirectClosed: () => void;

  beforeAll(async () => {
    server = await startServer((req, res) => {
      received.push(req.headers);
      switch (req.url) {
        case '/stall':
          res.writeHead(200, { 'content-type': 'application/json' });
          res.write('{"a":'); // never finishes
          return;
        case '/big-declared':
          res.writeHead(200, {
            'content-type': 'application/json',
            'content-length': String(2048),
          });
          res.end('{"a":"' + 'x'.repeat(2040) + '"}');
          return;
        case '/big-chunked':
          res.writeHead(200, { 'content-type': 'application/json' });
          res.write('{"a":"' + 'x'.repeat(1500));
          res.end('"}');
          return;
        case '/json':
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"ok":true}');
          return;
        case '/redirect-endless-body':
          res.on('close', () => markRedirectClosed());
          res.writeHead(302, { location: '/json' });
          res.write('x'.repeat(1024)); // keeps streaming until cancelled
          return;
        case '/redirect-same-origin':
          res.writeHead(302, { location: '/json' });
          res.end();
          return;
        case '/redirect-cross-origin':
          res.writeHead(302, {
            location: server.url('/json', 'localhost'),
          });
          res.end();
          return;
        default:
          res.writeHead(404);
          res.end();
      }
    });
  });

  afterAll(() => server.close());

  beforeEach(() => {
    received = [];
    redirectClosed = new Promise(resolve => (markRedirectClosed = resolve));
  });

  it('the timeout also covers a stalled body', async () => {
    const fetcher = createFetcher({ allowPrivateIPs: true, timeout: 300 });
    const start = Date.now();
    await expect(fetcher.get(server.url('/stall'))).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(5000); // hangs forever without the fix
  });

  it('rejects bodies above maxContentLength (declared length)', async () => {
    const fetcher = createFetcher({
      allowPrivateIPs: true,
      maxContentLength: 1024,
    });
    await expect(fetcher.get(server.url('/big-declared'))).rejects.toThrow(
      /exceeds 1024 bytes/
    );
  });

  it('rejects bodies above maxContentLength (streamed, no length)', async () => {
    const fetcher = createFetcher({
      allowPrivateIPs: true,
      maxContentLength: 1024,
    });
    await expect(fetcher.get(server.url('/big-chunked'))).rejects.toThrow(
      /exceeds 1024 bytes/
    );
  });

  it('reads bodies within the limit', async () => {
    const fetcher = createFetcher({ allowPrivateIPs: true });
    const res = await fetcher.get(server.url('/json'));
    expect(res.data).toEqual({ ok: true });
  });

  it('cancels the body of a redirect response', async () => {
    const fetcher = createFetcher({ allowPrivateIPs: true });
    const res = await fetcher.get(server.url('/redirect-endless-body'));
    expect(res.data).toEqual({ ok: true });
    await expect(
      Promise.race([
        redirectClosed,
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('redirect body not cancelled')),
            2000
          )
        ),
      ])
    ).resolves.toBeUndefined();
  });

  it('keeps headers on same-origin redirects', async () => {
    const fetcher = createFetcher({ allowPrivateIPs: true });
    await fetcher.get(server.url('/redirect-same-origin'), {
      headers: { 'X-API-KEY': 'secret' },
    });
    expect(received.map(h => h['x-api-key'])).toEqual(['secret', 'secret']);
  });

  it('drops credentials on cross-origin redirects', async () => {
    const fetcher = createFetcher({ allowPrivateIPs: true });
    await fetcher.get(server.url('/redirect-cross-origin'), {
      headers: {
        'X-API-KEY': 'secret',
        Authorization: 'Bearer t',
        Accept: 'application/json',
      },
    });
    expect(received).toHaveLength(2);
    expect(received[0]['x-api-key']).toBe('secret');
    expect(received[1]['x-api-key']).toBeUndefined();
    expect(received[1].authorization).toBeUndefined();
    expect(received[1].accept).toBe('application/json');
  });
});

describe('returned image URLs are the checked URLs', () => {
  const recordingFetcher = (contentType: string) => {
    const heads: string[] = [];
    const fetcher: Fetcher = {
      get: jest.fn(),
      head: jest.fn(async (url: string) => {
        heads.push(url);
        return {
          status: 200,
          headers: { 'content-type': contentType },
          data: undefined,
        };
      }),
      getArrayBuffer: jest.fn(),
    };
    return { fetcher, heads };
  };

  it('isImageURI checks the host the URL actually targets', async () => {
    const { fetcher, heads } = recordingFetcher('image/png');
    await isImageURI('http://127.0.0.1\\@attacker.example/a.png', fetcher);
    expect(new URL(heads[0]).hostname).toBe('127.0.0.1');
  });

  it('getImageURI returns the parsed URL', () => {
    expect(
      getImageURI({
        metadata: { image: 'http://127.0.0.1\\@attacker.example/a.png' },
      })
    ).toBe('http://127.0.0.1/@attacker.example/a.png');
  });

  it('isImageURI rejects non-http(s) URLs without fetching', async () => {
    const { fetcher, heads } = recordingFetcher('image/png');
    expect(await isImageURI('httpx://example.com/a.png', fetcher)).toBe(false);
    expect(heads).toHaveLength(0);
  });
});

describe('every remote avatar URL is content-checked', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  const heads: string[] = [];

  beforeAll(async () => {
    server = await startServer((req, res) => {
      if (req.method === 'HEAD') heads.push(req.url || '');
      const json = (body: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
      };
      switch (req.url) {
        case '/meta-html':
          return json({ image: server.url('/page.html') });
        case '/meta-png':
          return json({ image: server.url('/a.png') });
        case '/page.html':
          res.writeHead(200, { 'content-type': 'text/html' });
          return res.end();
        case '/a.png':
          res.writeHead(200, { 'content-type': 'image/png' });
          return res.end();
        default:
          res.writeHead(404);
          res.end();
      }
    });
  });

  afterAll(() => server.close());
  beforeEach(() => (heads.length = 0));

  const resolverFor = (record: string) =>
    new AvatarResolver(
      {
        getEnsRecord: async () => ({ record, address: null }),
        readContract: async () => {
          throw new Error('unused');
        },
      },
      { allowPrivateIPs: true }
    );

  it('rejects a metadata record whose image is not an image', async () => {
    expect(
      await resolverFor(server.url('/meta-html')).getAvatar('x.eth')
    ).toBeNull();
  });

  it('accepts a metadata record whose image is an image', async () => {
    expect(await resolverFor(server.url('/meta-png')).getAvatar('x.eth')).toBe(
      server.url('/a.png')
    );
  });

  it('checks a direct image record once', async () => {
    expect(await resolverFor(server.url('/a.png')).getAvatar('x.eth')).toBe(
      server.url('/a.png')
    );
    expect(heads).toEqual(['/a.png']);
  });
});

describe('chain adapters surface failures', () => {
  const viemClient = (overrides: Partial<ViemClientLike>): ViemClientLike => ({
    getEnsText: async () => 'https://example.com/a.png',
    getEnsAddress: async () => '0x5a384227b65fa093dec03ec34e111db80a040615',
    readContract: async () => {
      throw new Error('unused');
    },
    ...overrides,
  });

  it('fromViem propagates getEnsText errors', async () => {
    const client = viemClient({
      getEnsText: async () => {
        throw new Error('RPC down');
      },
    });
    await expect(
      fromViem(client).getEnsRecord('nick.eth', 'avatar')
    ).rejects.toThrow('RPC down');
  });

  it('fromViem keeps the record when only the address lookup fails', async () => {
    const client = viemClient({
      getEnsAddress: async () => {
        throw new Error('RPC down');
      },
    });
    expect(await fromViem(client).getEnsRecord('nick.eth', 'avatar')).toEqual({
      record: 'https://example.com/a.png',
      address: null,
    });
  });

  it('fromViem still returns nulls when viem does', async () => {
    const client = viemClient({
      getEnsText: async () => null,
      getEnsAddress: async () => null,
    });
    expect(await fromViem(client).getEnsRecord('nick.eth', 'avatar')).toEqual({
      record: null,
      address: null,
    });
  });
});

describe('NFT chain id is enforced', () => {
  const nftClient = (chainId?: number): ChainClient => ({
    getEnsRecord: async () => ({
      record: 'eip155:1/erc721:0x31385d3520bced94f77aae104b406994d8f2168c/1',
      address: null,
    }),
    readContract: jest.fn(
      async () => 'data:application/json,{"image":""}'
    ) as ChainClient['readContract'],
    ...(chainId === undefined ? {} : { getChainId: async () => chainId }),
  });

  it('rejects an NFT on another chain without reading the contract', async () => {
    const client = nftClient(137);
    await expect(
      new AvatarResolver(client).getMetadata('x.eth')
    ).rejects.toBeInstanceOf(ChainMismatch);
    expect(client.readContract).not.toHaveBeenCalled();
  });

  it('reads the contract when the chain matches', async () => {
    const client = nftClient(1);
    await new AvatarResolver(client).getMetadata('x.eth').catch(() => {});
    expect(client.readContract).toHaveBeenCalled();
  });

  it('skips the check for clients without getChainId', async () => {
    const client = nftClient();
    await new AvatarResolver(client).getMetadata('x.eth').catch(() => {});
    expect(client.readContract).toHaveBeenCalled();
  });

  it('fromViem exposes and caches getChainId', async () => {
    const getChainId = jest.fn(async () => 1);
    const client = fromViem({
      getEnsText: async () => null,
      getEnsAddress: async () => null,
      readContract: async () => null,
      getChainId,
    });
    expect(await client.getChainId!()).toBe(1);
    expect(await client.getChainId!()).toBe(1);
    expect(getChainId).toHaveBeenCalledTimes(1);
  });

  it('fromViem omits getChainId when the client lacks it', () => {
    const client = fromViem({
      getEnsText: async () => null,
      getEnsAddress: async () => null,
      readContract: async () => null,
    });
    expect(client.getChainId).toBeUndefined();
  });
});

describe('runtime detection', () => {
  const load = () => {
    let mod: typeof import('../src/utils/detectPlatform') | undefined;
    jest.isolateModules(() => {
      mod = require('../src/utils/detectPlatform');
    });
    return mod!;
  };

  it('treats Cloudflare Workers as edge even with a Node-like process', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'Cloudflare-Workers' },
      configurable: true,
    });
    try {
      const { isNode, isCloudflareWorker } = load();
      expect(isNode).toBe(false);
      expect(isCloudflareWorker).toBe(true);
    } finally {
      if (original) Object.defineProperty(globalThis, 'navigator', original);
      else delete (globalThis as { navigator?: unknown }).navigator;
    }
  });

  it('detects Node.js', () => {
    expect(load().isNode).toBe(true);
  });
});

const bytes = (...parts: Array<string | number[]>) =>
  new Uint8Array(
    parts.flatMap(p =>
      typeof p === 'string' ? Array.from(p, c => c.charCodeAt(0)) : p
    )
  );
const toBase64 = (b: Uint8Array) => Buffer.from(b).toString('base64');

// 1x1 PNG
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==';

describe('nested data: URIs are validated', () => {
  const html = toBase64(bytes('<html><script>alert(1)</script>'));

  it.each([
    ['non-image bytes', `data:text/plain,data:image/png;base64,${html}`],
    ['invalid base64', 'data:,data:image/gif;base64,!!!notbase64!!!'],
    ['mismatched type', `data:,data:image/gif;base64,${PNG_B64}`],
    ['non-base64 raster', 'data:,data:image/png,rawbytes'],
  ])('rejects a nested URI with %s', (_label, image) => {
    expect(getImageURI({ metadata: { image } })).toBeNull();
  });

  it('accepts a nested URI whose bytes match its type', () => {
    expect(
      getImageURI({
        metadata: { image: `data:,data:image/png;base64,${PNG_B64}` },
      })
    ).toBe(`data:image/png;base64,${PNG_B64}`);
  });

  it('still accepts a plain valid data URI', () => {
    const uri = `data:image/png;base64,${PNG_B64}`;
    expect(getImageURI({ metadata: { image: uri } })).toBe(uri);
  });
});

describe('detectImageMimeType', () => {
  const size = [0, 0, 0, 0x1c];
  it.each([
    ['image/jpeg', bytes([0xff, 0xd8, 0xff, 0xe0])],
    ['image/png', bytes([0x89], 'PNG', [0x0d, 0x0a, 0x1a, 0x0a])],
    ['image/gif', bytes('GIF89a')],
    ['image/gif', bytes('GIF87a')],
    [
      'image/bmp',
      bytes(
        'BM',
        [0x46, 0, 0, 0],
        [0, 0, 0, 0],
        [0x36, 0, 0, 0],
        [40, 0, 0, 0]
      ),
    ],
    ['image/webp', bytes('RIFF', [0x24, 0, 0, 0], 'WEBPVP8 ')],
    ['image/avif', bytes(size, 'ftypavif')],
    ['image/heic', bytes(size, 'ftypheic')],
    ['image/heif', bytes(size, 'ftypmif1')],
    ['image/jxl', bytes([0, 0, 0, 0x0c], 'JXL ', [0x0d, 0x0a, 0x87, 0x0a])],
  ])('detects %s', (mime, input) => {
    expect(detectImageMimeType(input)).toBe(mime);
  });

  it.each([
    ['empty', bytes()],
    ['text', bytes('<html>')],
    ['RIFF audio', bytes('RIFF', [0, 0, 0, 0], 'WAVE')],
    ['MP4 video', bytes(size, 'ftypisom')],
    ['truncated PNG', bytes([0x89], 'PNG')],
    ['text starting with BM', bytes('BMW is a car brand, not a bitmap')],
    ['bare JPEG XL codestream marker', bytes([0xff, 0x0a], '<html>')],
  ])('returns null for %s', (_label, input) => {
    expect(detectImageMimeType(input)).toBeNull();
  });
});

describe('octet-stream images are sniffed for every allowed format', () => {
  const octetFetcher = (body: Uint8Array): Fetcher => ({
    get: jest.fn(),
    head: jest.fn(async () => ({
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
      data: undefined,
    })),
    getArrayBuffer: jest.fn(async () => ({
      status: 206,
      headers: {},
      data: body.slice().buffer as ArrayBuffer,
    })),
  });
  const size = [0, 0, 0, 0x1c];

  it.each([
    ['webp', bytes('RIFF', [0x24, 0, 0, 0], 'WEBPVP8 ')],
    ['avif', bytes(size, 'ftypavif')],
    ['heic', bytes(size, 'ftypheic')],
  ])('accepts %s', async (_label, body) => {
    expect(
      await isImageURI('https://example.com/img', octetFetcher(body))
    ).toBe(true);
  });

  it('rejects unknown bytes', async () => {
    expect(
      await isImageURI(
        'https://example.com/img',
        octetFetcher(bytes(size, 'ftypisom'))
      )
    ).toBe(false);
  });
});

describe('on-chain JSON avatar records', () => {
  let server: Awaited<ReturnType<typeof startServer>>;

  beforeAll(async () => {
    server = await startServer((req, res) => {
      res.writeHead(req.url === '/a.png' ? 200 : 404, {
        'content-type': 'image/png',
      });
      res.end();
    });
  });
  afterAll(() => server.close());

  const resolverFor = (record: string) =>
    new AvatarResolver(
      {
        getEnsRecord: async () => ({ record, address: null }),
        readContract: async () => {
          throw new Error('unused');
        },
      },
      { allowPrivateIPs: true }
    );
  const jsonB64 = (value: unknown) =>
    `data:application/json;base64,${toBase64(bytes(JSON.stringify(value)))}`;

  it('resolves the image of a base64 JSON record', async () => {
    const record = jsonB64({ name: 'x', image: server.url('/a.png') });
    const avt = resolverFor(record);
    expect(await avt.getAvatar('x.eth')).toBe(server.url('/a.png'));
    expect(await avt.getMetadata('x.eth')).toEqual({
      name: 'x',
      image: server.url('/a.png'),
      uri: 'x.eth',
    });
  });

  it('still content-checks the image of a JSON record', async () => {
    const record = jsonB64({ image: server.url('/missing.png') });
    expect(await resolverFor(record).getAvatar('x.eth')).toBeNull();
  });

  it('resolves a non-base64 JSON record with an inline SVG', async () => {
    const record =
      'data:application/json,{"image":"<svg><rect onclick=\'x()\'/></svg>"}';
    const out = await resolverFor(record).getAvatar('x.eth');
    expect(decodeDataURI(out)).toBe('<svg><rect></rect></svg>');
  });

  it('throws MetadataParsingError for malformed JSON', async () => {
    await expect(
      resolverFor('data:application/json,{not json').getMetadata('x.eth')
    ).rejects.toBeInstanceOf(MetadataParsingError);
  });

  it('still treats a data:image record as the image itself', async () => {
    const uri = `data:image/png;base64,${PNG_B64}`;
    expect(await resolverFor(uri).getAvatar('x.eth')).toBe(uri);
  });
});

// ---------------------------------------------------------------------------
// Round 2
// ---------------------------------------------------------------------------

describe('sanitizeSVG resource limits', () => {
  it('returns "" above maxLength (default 256 KiB) and honours the option', () => {
    const big = '<svg>' + ' '.repeat(DEFAULT_MAX_SVG_LENGTH) + '</svg>';
    expect(sanitizeSVG(big)).toBe('');
    expect(sanitizeSVG('<svg><rect/></svg>', { maxLength: 10 })).toBe('');
    expect(sanitizeSVG('<svg><rect/></svg>', { maxLength: 100 })).toBe(
      '<svg><rect></rect></svg>'
    );
  });

  it('returns "" for nesting deeper than 256 and keeps ordinary depth', () => {
    const nested = (n: number) =>
      '<svg>' + '<g>'.repeat(n) + '</g>'.repeat(n) + '</svg>';
    expect(sanitizeSVG(nested(300))).toBe('');
    expect(sanitizeSVG(nested(200))).toContain('<g><g>');
  });

  it('flat siblings do not count as nesting', () => {
    const flat = '<svg>' + '<rect/>'.repeat(5000) + '</svg>';
    expect(sanitizeSVG(flat)).toContain('<rect></rect>');
  });

  it('drops oversized <style> blocks and style attributes', () => {
    const block = `<svg><style>a{fill:red}${' '.repeat(
      65 * 1024
    )}</style></svg>`;
    expect(sanitizeSVG(block)).toBe('<svg></svg>');
    const attr = `<svg><rect style="fill:red;${' '.repeat(17 * 1024)}"/></svg>`;
    expect(sanitizeSVG(attr)).toBe('<svg><rect></rect></svg>');
  });

  it('worst cases within the limits stay fast', () => {
    const max = DEFAULT_MAX_SVG_LENGTH - 100;
    const cases = [
      ('<svg>' + '<g>'.repeat(254) + '<rect/>'.repeat(max / 7)).slice(0, max),
      '<svg>' +
        ('<style>a{fill:red' + ' important'.repeat(6300) + '}</style>').repeat(
          4
        ) +
        '</svg>',
      '<svg><style>' + 'a/**/'.repeat(12600) + '{fill:red}</style></svg>',
      '<svg>' + '<g>'.repeat(max / 3),
    ];
    for (const svg of cases) {
      expect(elapsed(() => sanitizeSVG(svg))).toBeLessThan(1500);
    }
  });

  it('getImageURI honours maxSvgLength', () => {
    const svg = '<svg><rect/></svg>';
    expect(
      getImageURI({ metadata: { image: svg }, maxSvgLength: 10 })
    ).toBeNull();
    expect(
      getImageURI({ metadata: { image: svg }, maxSvgLength: 1000 })
    ).not.toBeNull();
  });
});

describe('<style> content cannot become markup when inlined', () => {
  const style = (css: string) =>
    sanitizeSVG(`<svg><style>${css}</style></svg>`);

  it('drops style blocks containing "<" or "&"', () => {
    expect(style('a{fill:"<img src=x onerror=alert(1)>"}')).toBe('<svg></svg>');
    expect(style('a{fill:"&lt;img src=x&gt;"}')).toBe('<svg></svg>');
  });

  it('keeps ordinary style blocks (">" combinator included)', () => {
    expect(style('g > rect{fill:red}')).toBe(
      '<svg><style>g > rect{fill:red}</style></svg>'
    );
  });
});

describe('CSS at-rules are allowlisted after unescaping', () => {
  const style = (css: string) =>
    sanitizeSVG(`<svg><style>${css}</style></svg>`);

  it.each([
    '@i\\mport url(https://evil.example/x.css);',
    '@IMPORT url(https://evil.example/x.css);',
    '@font-face{font-family:x}',
    '@namespace svg url(http://www.w3.org/2000/svg);',
  ])('removes %s', rule => {
    expect(style(`${rule}a{fill:red}`)).toBe(
      '<svg><style>a{fill:red}</style></svg>'
    );
  });

  it('drops hex-escaped at-rules (postcss rejects the block)', () => {
    const out = style('@\\69mport url(https://evil.example/x.css);a{fill:red}');
    expect(out).not.toMatch(/mport|evil/);
  });

  it('keeps @media, @supports and @keyframes', () => {
    for (const css of [
      '@media (min-width:10px){a{fill:red}}',
      '@supports (fill:red){a{fill:red}}',
      '@keyframes spin{from{opacity:0}to{opacity:1}}',
    ]) {
      expect(style(css)).toContain(css.slice(0, 6));
    }
  });
});

describe('linear-time string handling', () => {
  it('isCID rejects long strings quickly', () => {
    const long = 'Qm' + '1'.repeat(100000);
    expect(elapsed(() => expect(isCID(long)).toBe(false))).toBeLessThan(100);
  });

  it('normalizeHostname handles long runs of dots quickly', () => {
    const host = '.'.repeat(100000) + 'a' + '.'.repeat(100000);
    expect(elapsed(() => normalizeHostname(host))).toBeLessThan(100);
    expect(normalizeHostname('Example.COM...')).toBe('example.com');
  });

  it('overlong hostnames fail closed', () => {
    const host = 'a'.repeat(250) + '.com';
    expect(isPrivateHostname(host)).toBe(true);
    expect(isHostDenied(`https://${host}/`, ['other.example'])).toBe(true);
    expect(() => validateUrl(`https://${host}/`)).toThrow();
    expect(isPrivateHostname('a'.repeat(249) + '.com')).toBe(false);
  });
});

describe('limit options are validated', () => {
  it.each([NaN, Infinity, -1, 0, 1.5])('createFetcher rejects %s', value => {
    expect(() => createFetcher({ timeout: value })).toThrow(TypeError);
    expect(() => createFetcher({ maxContentLength: value })).toThrow(TypeError);
    expect(() => sanitizeSVG('<svg/>', { maxLength: value })).toThrow(
      TypeError
    );
  });

  it('maxRedirects accepts 0 but not more than 20', () => {
    expect(() => createFetcher({ maxRedirects: 0 })).not.toThrow();
    expect(() => createFetcher({ maxRedirects: 21 })).toThrow(TypeError);
  });

  it('AvatarResolver validates its options up front', () => {
    const client = {
      getEnsRecord: async () => ({ record: null, address: null }),
      readContract: async () => null as never,
    };
    expect(() => new AvatarResolver(client, { maxSvgLength: NaN })).toThrow(
      TypeError
    );
    expect(() => new AvatarResolver(client, { timeout: Infinity })).toThrow(
      TypeError
    );
  });
});

describe('fetcher defaults', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let hits = 0;

  beforeAll(async () => {
    server = await startServer((req, res) => {
      hits++;
      const url = new URL(req.url || '/', 'http://x');
      const hop = Number(url.searchParams.get('hop') || 0);
      const hops = Number(url.searchParams.get('hops') || 0);
      if (hop < hops) {
        res.writeHead(302, {
          location: `${url.pathname}?hops=${hops}&hop=${hop + 1}`,
        });
        return res.end();
      }
      if (url.pathname === '/big') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('"' + 'x'.repeat(1024 * 1024 + 10) + '"');
      }
      if (url.pathname === '/record') {
        // octet-stream, not an image: forces HEAD + ranged GET, then GET
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        return res.end(
          req.method === 'HEAD'
            ? undefined
            : JSON.stringify({ image: server.url(`/img?hops=${hops}`) })
        );
      }
      if (url.pathname === '/img') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        return res.end(
          req.method === 'HEAD'
            ? undefined
            : Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0])
        );
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{}');
    });
  });
  afterAll(() => server.close());
  beforeEach(() => (hits = 0));

  it('caps bodies at 1 MiB by default', async () => {
    const fetcher = createFetcher({ allowPrivateIPs: true });
    await expect(fetcher.get(server.url('/big'))).rejects.toThrow(
      /exceeds 1048576 bytes/
    );
  });

  it('follows 5 redirects by default, and maxRedirects overrides it', async () => {
    const fetcher = createFetcher({ allowPrivateIPs: true });
    await expect(fetcher.get(server.url('/ok?hops=5'))).resolves.toBeTruthy();
    await expect(fetcher.get(server.url('/ok?hops=6'))).rejects.toThrow(
      /Too many redirects \(max 5\)/
    );
    const strict = createFetcher({ allowPrivateIPs: true, maxRedirects: 0 });
    await expect(strict.get(server.url('/ok?hops=1'))).rejects.toThrow(/max 0/);
  });

  it('keeps a worst-case resolution under 50 HTTP requests', async () => {
    const avt = new AvatarResolver(
      {
        getEnsRecord: async () => ({
          record: server.url('/record?hops=5'),
          address: null,
        }),
        readContract: async () => null as never,
      },
      { allowPrivateIPs: true }
    );
    expect(await avt.getAvatar('x.eth')).toBe(server.url('/img?hops=5'));
    // record: HEAD + ranged GET + GET; image: HEAD + ranged GET; 6 hops each
    expect(hits).toBeLessThanOrEqual(30);
  });
});

describe('isImageURI fallbacks', () => {
  const fetcherWith = (
    headStatus: number,
    contentType: string,
    getStatus = 206
  ): Fetcher => ({
    get: jest.fn(),
    head: jest.fn(async () => ({
      status: headStatus,
      headers: { 'content-type': contentType },
      data: undefined,
    })),
    getArrayBuffer: jest.fn(async () => ({
      status: getStatus,
      headers: {},
      data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]).buffer,
    })),
  });

  it.each([403, 405, 501])(
    'sniffs with a ranged GET when HEAD returns %i',
    async status => {
      expect(
        await isImageURI(
          'https://example.com/a',
          fetcherWith(status, 'text/html')
        )
      ).toBe(true);
    }
  );

  it('does not sniff on other HEAD errors', async () => {
    const fetcher = fetcherWith(404, 'text/html');
    expect(await isImageURI('https://example.com/a', fetcher)).toBe(false);
    expect(fetcher.getArrayBuffer).not.toHaveBeenCalled();
  });

  it('requires a successful ranged GET', async () => {
    expect(
      await isImageURI(
        'https://example.com/a',
        fetcherWith(405, 'text/html', 404)
      )
    ).toBe(false);
  });

  it.each(['image/jpg', 'image/pjpeg', 'image/x-png', 'IMAGE/JPG; q=1'])(
    'accepts the %s alias',
    async type => {
      expect(
        await isImageURI('https://example.com/a', fetcherWith(200, type))
      ).toBe(true);
    }
  );
});

describe('octet-stream SVG sniffing', () => {
  const octet = (text: string): Fetcher => ({
    get: jest.fn(),
    head: jest.fn(async () => ({
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
      data: undefined,
    })),
    getArrayBuffer: jest.fn(async () => ({
      status: 200,
      headers: {},
      data: new TextEncoder().encode(text).buffer as ArrayBuffer,
    })),
  });

  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
    '<?xml version="1.0"?>\n<!-- hi -->\n<!DOCTYPE svg>\n<svg>',
  ])('accepts an SVG document: %s', async text => {
    expect(await isImageURI('https://example.com/a', octet(text))).toBe(true);
  });

  it('rejects an XML document whose root is not <svg>', async () => {
    const xhtml =
      '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><script>x</script></html>';
    expect(await isImageURI('https://example.com/a', octet(xhtml))).toBe(false);
  });
});

describe('record metadata cannot spoof resolver fields', () => {
  const resolverFor = (record: string) =>
    new AvatarResolver({
      getEnsRecord: async () => ({ record, address: null }),
      readContract: async () => null as never,
    });
  const jsonRecord = (value: unknown) =>
    `data:application/json;base64,${toBase64(bytes(JSON.stringify(value)))}`;

  it('strips is_owner, host_meta and uri from a JSON record', async () => {
    const record = jsonRecord({
      name: 'n',
      image: `data:image/png;base64,${PNG_B64}`,
      is_owner: true,
      host_meta: { contract_address: '0xfake' },
      uri: 'other.eth',
    });
    expect(await resolverFor(record).getMetadata('x.eth')).toEqual({
      name: 'n',
      image: `data:image/png;base64,${PNG_B64}`,
      uri: 'x.eth',
    });
  });

  it.each([[[1, 2]], ['"just a string"'], [42], [null]])(
    'rejects non-object JSON %p',
    async value => {
      const record = `data:application/json,${
        typeof value === 'string' ? value : JSON.stringify(value)
      }`;
      await expect(
        resolverFor(record).getMetadata('x.eth')
      ).rejects.toBeInstanceOf(MetadataParsingError);
    }
  );
});

describe('NFT records are recognised by prefix only', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  beforeAll(async () => {
    server = await startServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'image/png' });
      res.end();
    });
  });
  afterAll(() => server.close());

  const resolverFor = (record: string) =>
    new AvatarResolver(
      {
        getEnsRecord: async () => ({ record, address: null }),
        readContract: jest.fn(async () => {
          throw new Error('should not read a contract');
        }) as ChainClient['readContract'],
      },
      { allowPrivateIPs: true }
    );

  it('treats a URL containing "eip155:" as a URL', async () => {
    const url = server.url('/eip155:1/erc721:0xabc/1.png');
    expect(await resolverFor(url).getAvatar('x.eth')).toBe(url);
  });

  it('treats JSON mentioning "eip155:" as JSON', async () => {
    const record = `data:application/json,{"description":"eip155:1/erc721:0xabc/1","image":"data:image/png;base64,${PNG_B64}"}`;
    expect(await resolverFor(record).getAvatar('x.eth')).toBe(
      `data:image/png;base64,${PNG_B64}`
    );
  });
});

describe('chain id caching', () => {
  it('fromViem prefers client.chain.id', async () => {
    const getChainId = jest.fn(async () => 5);
    const client = fromViem({
      getEnsText: async () => null,
      getEnsAddress: async () => null,
      readContract: async () => null,
      chain: { id: 1 },
      getChainId,
    });
    expect(await client.getChainId!()).toBe(1);
    expect(getChainId).not.toHaveBeenCalled();
  });

  it('fromViem retries getChainId after a failure', async () => {
    const getChainId = jest
      .fn<Promise<number>, []>()
      .mockRejectedValueOnce(new Error('RPC down'))
      .mockResolvedValue(1);
    const client = fromViem({
      getEnsText: async () => null,
      getEnsAddress: async () => null,
      readContract: async () => null,
      getChainId,
    });
    await expect(client.getChainId!()).rejects.toThrow('RPC down');
    expect(await client.getChainId!()).toBe(1);
    expect(await client.getChainId!()).toBe(1);
    expect(getChainId).toHaveBeenCalledTimes(2);
  });

  it('fromEthers reports the provider network', async () => {
    const provider = new JsonRpcProvider('http://127.0.0.1:1', 'mainnet', {
      staticNetwork: true,
    });
    expect(await fromEthers(provider).getChainId!()).toBe(1);
    provider.destroy();
  });
});

describe('fromEthers tells reverts from outages', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let callError: Record<string, unknown>;

  beforeAll(async () => {
    server = await startServer((req, res) => {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        const payload = JSON.parse(body);
        const reply = (p: { id: number; method: string }) =>
          p.method === 'eth_chainId'
            ? { jsonrpc: '2.0', id: p.id, result: '0x1' }
            : { jsonrpc: '2.0', id: p.id, error: callError };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify(
            Array.isArray(payload) ? payload.map(reply) : reply(payload)
          )
        );
      });
    });
  });
  afterAll(() => server.close());

  const resolve = () => {
    const provider = new JsonRpcProvider(server.url('/'), 'mainnet', {
      staticNetwork: true,
    });
    return fromEthers(provider)
      .getEnsRecord('nick.eth', 'avatar')
      .finally(() => provider.destroy());
  };

  it('returns null for a revert with data (e.g. ResolverNotFound)', async () => {
    callError = {
      code: 3,
      message: 'execution reverted',
      data: '0x77209fe8' + '0'.repeat(64),
    };
    expect(await resolve()).toEqual({ record: null, address: null });
  });

  it.each([
    ['a revert without data', { code: -32000, message: 'execution reverted' }],
    [
      'a CCIP gateway HttpError',
      {
        code: 3,
        message: 'execution reverted',
        data: new Interface([
          'error HttpError(uint16 status, string message)',
        ]).encodeErrorResult('HttpError', [502, 'Bad Gateway']),
      },
    ],
  ])('throws for %s', async (_label, error) => {
    callError = error;
    await expect(resolve()).rejects.toThrow();
  });

  it.each([
    { code: -32000, message: 'header not found' },
    {
      code: -32005,
      message: 'daily request count exceeded, request rate limited',
    },
  ])('throws on an RPC outage: $message', async error => {
    callError = error;
    await expect(resolve()).rejects.toThrow();
  });
});

describe('assert', () => {
  it('throws an Error, not a bare string', () => {
    expect(() => assert(false, 'boom')).toThrow(BaseError);
    expect(() => assert(false, 'boom')).toThrow('boom');
  });
});

// ---------------------------------------------------------------------------
// Round 3
// ---------------------------------------------------------------------------

describe('isSvgDocument is linear and accepts real prologs', () => {
  it('rejects many empty comments quickly (the regex was exponential)', () => {
    const input = '<!---->'.repeat(100000) + 'X';
    expect(
      elapsed(() => expect(isSvgDocument(input)).toBe(false))
    ).toBeLessThan(500);
  });

  it.each([
    '<svg>',
    '<svg/>',
    '\n  <svg xmlns="http://www.w3.org/2000/svg">',
    '<?xml version="1.0"?><?xml-stylesheet href="a.css"?><svg>',
    '<!-- c1 --><!-- c2 --><!DOCTYPE svg><svg>',
    '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd" [\n<!ENTITY ns "http://x">\n]>\n<svg>',
  ])('accepts %p', text => {
    expect(isSvgDocument(text)).toBe(true);
  });

  it.each([
    '<?xml version="1.0"?><html>',
    '<!-- unterminated <svg>',
    '<?xml unterminated <svg>',
    '<svgx>',
    'GIF89a<svg>',
  ])('rejects %p', text => {
    expect(isSvgDocument(text)).toBe(false);
  });
});

describe('<style/> in HTML-context elements cannot smuggle markup', () => {
  it.each([
    '<svg><desc><style/>&lt;/style&gt;&lt;img src=x onerror=alert(1)&gt;</desc></svg>',
    '<svg><title><style/>&lt;img src=x onerror=alert(1)&gt;</title></svg>',
    '<svg><title></title></desc><style/>&lt;img src=x onerror=alert(1)&gt;</svg>',
    '<svg><desc><style/>&lt;/desc&gt;&lt;img src=x onerror=alert(1)&gt;</desc></svg>',
    '<svg><foreignObject><style/>&lt;img src=x onerror=alert(1)&gt;</foreignObject></svg>',
  ])('%s', payload => {
    const out = sanitizeSVG(payload);
    // Parse the output as a browser inlining it into HTML would.
    const tags: string[] = [];
    const { Parser } = require('htmlparser2');
    const parser = new Parser({ onopentag: (name: string) => tags.push(name) });
    parser.write(out);
    parser.end();
    expect(tags).not.toContain('img');
    expect(out).not.toMatch(/<img/i);
  });

  it('keeps a normal <style> block', () => {
    expect(sanitizeSVG('<svg><style>a{fill:red}</style><rect/></svg>')).toBe(
      '<svg><style>a{fill:red}</style><rect></rect></svg>'
    );
  });
});

describe('CSS work per SVG is bounded', () => {
  it('four 64 KiB blocks of empty rules are fast (was ~4 s)', () => {
    const svg =
      '<svg>' +
      ('<style>' + 'a{}'.repeat(21000) + '</style>').repeat(4) +
      '</svg>';
    expect(elapsed(() => sanitizeSVG(svg))).toBeLessThan(1000);
  });

  it('caps total <style> bytes per SVG, not per block', () => {
    const block = `<style>a{fill:red}${' '.repeat(40 * 1024)}</style>`;
    const out = sanitizeSVG(`<svg>${block}${block}</svg>`);
    expect(out.match(/<style>/g)).toHaveLength(1);
  });

  it('drops a block with more than 2000 CSS nodes', () => {
    const many = 'a{fill:red}'.repeat(1500); // 3000 nodes (rule + decl)
    expect(sanitizeSVG(`<svg><style>${many}</style></svg>`)).toBe(
      '<svg></svg>'
    );
    const few = 'a{fill:red}'.repeat(100);
    expect(sanitizeSVG(`<svg><style>${few}</style></svg>`)).toContain(
      '<style>'
    );
  });

  it('keeps @layer and @container', () => {
    const css =
      '@layer base{a{fill:red}}@container (min-width:1px){a{fill:red}}';
    expect(sanitizeSVG(`<svg><style>${css}</style></svg>`)).toContain(
      '@layer base'
    );
    expect(sanitizeSVG(`<svg><style>${css}</style></svg>`)).toContain(
      '@container'
    );
  });
});

describe('inline JSON metadata is size-capped', () => {
  const resolverFor = (record: string, maxContentLength?: number) =>
    new AvatarResolver(
      {
        getEnsRecord: async () => ({ record, address: null }),
        readContract: async () => null as never,
      },
      { maxContentLength }
    );

  it('rejects JSON records above maxContentLength', async () => {
    const big = `data:application/json,{"image":"x","pad":"${'x'.repeat(
      2000
    )}"}`;
    await expect(resolverFor(big, 1024).getMetadata('x.eth')).rejects.toThrow(
      /exceeds 1024 bytes/
    );
    const b64 = `data:application/json;base64,${toBase64(
      bytes(JSON.stringify({ image: 'x', pad: 'x'.repeat(2000) }))
    )}`;
    await expect(resolverFor(b64, 1024).getMetadata('x.eth')).rejects.toThrow(
      /exceeds 1024 bytes/
    );
  });

  it('accepts JSON records within the limit', async () => {
    const small = `data:application/json,{"name":"n","image":"x"}`;
    expect(await resolverFor(small, 1024).getMetadata('x.eth')).toEqual({
      name: 'n',
      image: 'x',
      uri: 'x.eth',
    });
  });
});

describe('option types are validated', () => {
  it('allowPrivateIPs must be a real boolean', () => {
    expect(() =>
      createFetcher({ allowPrivateIPs: ('false' as unknown) as boolean })
    ).toThrow(TypeError);
    // validateUrl treats anything but `true` as false
    expect(() =>
      validateUrl('http://127.0.0.1/', [], ('false' as unknown) as boolean)
    ).toThrow(/private address/);
  });

  it('urlDenyList must be an array of strings', () => {
    expect(() =>
      createFetcher({ urlDenyList: ('evil.com' as unknown) as string[] })
    ).toThrow(TypeError);
  });

  it('cache must be a non-negative integer (0 disables it)', () => {
    expect(() => createFetcher({ ttl: NaN })).toThrow(TypeError);
    expect(() => createFetcher({ ttl: 0 })).not.toThrow();
  });

  it('gateways must be http(s) URLs', () => {
    const client = {
      getEnsRecord: async () => ({ record: null, address: null }),
      readContract: async () => null as never,
    };
    // eslint-disable-next-line no-script-url
    expect(() => new AvatarResolver(client, { ipfs: 'javascript:x' })).toThrow(
      TypeError
    );
    expect(
      () => new AvatarResolver(client, { arweave: 'https://ar.example' })
    ).not.toThrow();
  });

  it('getImageURI rejects maxSvgLength: null instead of nulling every SVG', () => {
    expect(() =>
      getImageURI({
        metadata: { image: '<svg/>' },
        maxSvgLength: (null as unknown) as number,
      })
    ).toThrow(TypeError);
  });
});

describe('TTLCache is bounded', () => {
  it(`keeps at most ${MAX_CACHE_ENTRIES} entries, evicting the least recent`, () => {
    const cache = new TTLCache(60);
    for (let i = 0; i < MAX_CACHE_ENTRIES; i++) cache.set(`k${i}`, i);
    cache.get('k0'); // touch: k0 becomes most recent
    cache.set('new', 'x');
    expect(cache.get('k0')).toBe(0);
    expect(cache.get('k1')).toBeUndefined(); // evicted
    expect(cache.get('new')).toBe('x');
  });
});

describe('fromViem chain id without a chain', () => {
  it('asks eth_chainId with dedupe off and shares no in-flight promise', async () => {
    const request = jest.fn(async () => '0x89');
    const getChainId = jest.fn(async () => 1);
    const client = fromViem({
      getEnsText: async () => null,
      getEnsAddress: async () => null,
      readContract: async () => null,
      request,
      getChainId,
    });
    // two concurrent first calls: each makes its own request
    const [a, b] = await Promise.all([
      client.getChainId!(),
      client.getChainId!(),
    ]);
    expect([a, b]).toEqual([137, 137]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledWith(
      { method: 'eth_chainId' },
      { dedupe: false }
    );
    expect(getChainId).not.toHaveBeenCalled();
    // later calls use the settled number
    await client.getChainId!();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('times out instead of hanging', async () => {
    jest.useFakeTimers();
    try {
      const client = fromViem({
        getEnsText: async () => null,
        getEnsAddress: async () => null,
        readContract: async () => null,
        request: () => new Promise(() => {}), // never settles
      });
      const result = client.getChainId!();
      jest.advanceTimersByTime(10000);
      await expect(result).rejects.toThrow(/timed out/);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('fromViem classifies Universal Resolver errors', () => {
  const viemError = (errorName: string) => {
    const cause = { data: { errorName } };
    return Object.assign(new Error(`reverted: ${errorName}`), {
      walk: (fn: (e: unknown) => boolean) => (fn(cause) ? cause : undefined),
    });
  };
  const clientThrowing = (error: unknown) => {
    const getEnsText = jest.fn(async () => {
      throw error;
    });
    return {
      getEnsText,
      client: fromViem({
        getEnsText,
        getEnsAddress: async () => null,
        readContract: async () => null,
      }),
    };
  };

  it.each([
    'ResolverNotFound',
    'ResolverNotContract',
    'ResolverError',
    'UnsupportedResolverProfile',
  ])('%s → null', async name => {
    const { client, getEnsText } = clientThrowing(viemError(name));
    expect(await client.getEnsRecord('x.eth', 'avatar')).toEqual({
      record: null,
      address: null,
    });
    expect(getEnsText).toHaveBeenCalledWith(
      expect.objectContaining({ strict: true })
    );
  });

  it.each([
    ['a gateway HttpError', viemError('HttpError')],
    ['an RPC error', new Error('header not found')],
  ])('%s throws', async (_label, error) => {
    const { client } = clientThrowing(error);
    await expect(client.getEnsRecord('x.eth', 'avatar')).rejects.toBe(error);
  });
});

describe('record metadata: prototype keys and non-string images', () => {
  it('drops an own "__proto__" key', async () => {
    const record =
      'data:application/json,{"__proto__":{"is_owner":true,"host_meta":{}},"image":"x"}';
    const meta = await new AvatarResolver({
      getEnsRecord: async () => ({ record, address: null }),
      readContract: async () => null as never,
    }).getMetadata('x.eth');
    const copy = Object.assign({}, meta) as Record<string, unknown>;
    expect(copy.is_owner).toBeUndefined();
    expect(copy.host_meta).toBeUndefined();
  });

  it('a non-string image resolves to null, not a TypeError', () => {
    expect(
      getImageURI({ metadata: { image: (123 as unknown) as string } })
    ).toBeNull();
    expect(
      getImageURI({ metadata: { image_data: ({} as unknown) as string } })
    ).toBeNull();
  });
});

describe('CJK SVGs fit the pre-decode bound', () => {
  it('accepts a base64 SVG within maxSvgLength whose encoding is ~4x larger', () => {
    const svg = `<svg><text>${'中'.repeat(1000)}</text></svg>`;
    const uri = `data:image/svg+xml;base64,${Buffer.from(svg).toString(
      'base64'
    )}`;
    expect(svg.length).toBeLessThanOrEqual(1100);
    expect(uri.length).toBeGreaterThan(1100 * 3); // over the old 3x bound
    expect(
      getImageURI({ metadata: { image: uri }, maxSvgLength: 1100 })
    ).not.toBeNull();
  });
});

describe('overlong hostnames are rejected everywhere', () => {
  const host = 'a'.repeat(250) + '.com';

  it('toHttpURL returns null', () => {
    expect(toHttpURL(`https://${host}/`)).toBeNull();
    expect(toHttpURL(`https://${'a'.repeat(249)}.com/`)).not.toBeNull();
  });

  it('isHostDenied is true even without a deny list', () => {
    expect(isHostDenied(`https://${host}/`)).toBe(true);
    expect(isHostDenied('https://example.com/')).toBe(false);
  });
});

describe('IPFS/Arweave path joining is linear', () => {
  it('handles long runs of slashes quickly (url-join was quadratic)', () => {
    const cid = 'QmUShgfoZQSHK3TQyuTfUpsc8UfeNfD8KwPUvDBUdZ4nmR';
    const path = '/a' + '/'.repeat(80000) + 'b';
    expect(elapsed(() => resolveURI(`ipfs://${cid}${path}`))).toBeLessThan(200);
    expect(elapsed(() => resolveURI(`ar://abc${path}`))).toBeLessThan(200);
  });

  it.each([
    [
      'ipfs://QmUShgfoZQSHK3TQyuTfUpsc8UfeNfD8KwPUvDBUdZ4nmR',
      'https://ipfs.io/ipfs/QmUShgfoZQSHK3TQyuTfUpsc8UfeNfD8KwPUvDBUdZ4nmR',
    ],
    [
      'ipfs://QmUShgfoZQSHK3TQyuTfUpsc8UfeNfD8KwPUvDBUdZ4nmR/a/b.png',
      'https://ipfs.io/ipfs/QmUShgfoZQSHK3TQyuTfUpsc8UfeNfD8KwPUvDBUdZ4nmR/a/b.png',
    ],
    [
      'ipfs://QmUShgfoZQSHK3TQyuTfUpsc8UfeNfD8KwPUvDBUdZ4nmR/dir/',
      'https://ipfs.io/ipfs/QmUShgfoZQSHK3TQyuTfUpsc8UfeNfD8KwPUvDBUdZ4nmR/dir/',
    ],
    ['ipns://example.eth/?x=1', 'https://ipfs.io/ipns/example.eth?x=1'],
    ['ar://abc/def', 'https://arweave.net/abc/def'],
  ])('%s → %s', (input, expected) => {
    expect(resolveURI(input).uri).toBe(expected);
  });
});
