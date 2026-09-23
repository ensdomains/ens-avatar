import http from 'http';
import { AddressInfo } from 'net';
import { AvatarResolver, ChainMismatch } from '../src';
import { ChainClient } from '../src/chain/client';
import { fromViem, ViemClientLike } from '../src/chain/viem';
import {
  createFetcher,
  getImageURI,
  isHostDenied,
  isImageURI,
  isPrivateHostname,
  sanitizeSVG,
  validateUrl,
} from '../src/utils';
import {
  collapseTagWhitespace,
  MAX_INLINE_SVG_LENGTH,
} from '../src/utils/getImageURI';
import { Fetcher } from '../src/types';
import { detectImageMimeType } from '../src/utils/sniffImage';
import { MetadataParsingError } from '../src/utils/error';

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
    expect(
      elapsed(() => getImageURI({ metadata: { image: svg } }))
    ).toBeLessThan(2000);
  });

  it('rejects inline SVGs above MAX_INLINE_SVG_LENGTH', () => {
    const svg = '<svg>' + ' '.repeat(MAX_INLINE_SVG_LENGTH) + '</svg>';
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
    expect(Date.now() - start).toBeLessThan(2000);
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

  it('fromViem propagates getEnsAddress errors', async () => {
    const client = viemClient({
      getEnsAddress: async () => {
        throw new Error('RPC down');
      },
    });
    await expect(
      fromViem(client).getEnsRecord('nick.eth', 'avatar')
    ).rejects.toThrow('RPC down');
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
    ['image/bmp', bytes('BM', [0, 0])],
    ['image/webp', bytes('RIFF', [0x24, 0, 0, 0], 'WEBPVP8 ')],
    ['image/avif', bytes(size, 'ftypavif')],
    ['image/heic', bytes(size, 'ftypheic')],
    ['image/heif', bytes(size, 'ftypmif1')],
    ['image/jxl', bytes([0xff, 0x0a])],
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
