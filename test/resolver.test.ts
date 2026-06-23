import {
  AbiCoder,
  FetchRequest,
  Interface,
  JsonRpcProvider,
  dnsEncode,
  namehash,
} from 'ethers';
import {
  MockAgent,
  setGlobalDispatcher,
  getGlobalDispatcher,
  Dispatcher,
  fetch as undiciFetch,
} from 'undici';
import {
  AvatarResolver,
  AvatarResolverOpts,
  Gateways,
  MediaKey,
  NFTMetadata,
} from '../src';
import { fromEthers } from '../src/chain/ethers';
import { fromViem, ViemClientLike } from '../src/chain/viem';

require('dotenv').config();

// Route ethers' HTTP requests through undici so MockAgent can intercept them.
// By default ethers uses Node's http/https modules, which MockAgent doesn't intercept.
FetchRequest.registerGetUrl(async (req, signal) => {
  const abortController = new AbortController();
  if (signal) {
    signal.addListener(() => abortController.abort());
  }

  const response = await undiciFetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body || undefined,
    signal: abortController.signal,
    redirect: 'follow',
  });

  const body = new Uint8Array(await response.arrayBuffer());
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return {
    statusCode: response.status,
    statusMessage: response.statusText,
    headers,
    body: body.length > 0 ? body : null,
  };
});

const INFURA_URL = new URL(
  `https://mainnet.infura.io/v3/${process.env.INFURA_KEY}`
);
const CORS_HEADERS = {
  'access-control-allow-credentials': 'true',
  'access-control-allow-origin': 'http://localhost',
};

const UNIVERSAL_RESOLVER = '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe';

/**
 * Build the RPC mock entry for the Universal Resolver `resolve()` call that
 * fromEthers(...).getEnsRecord issues — it batches addr(node, 60) +
 * text(node, key) through multicall. Returns a single `eth_call:to:data` entry.
 */
function mockUniversalResolve(opts: {
  ens: string;
  key: string;
  resolver: string;
  resolvedAddress: string;
  mediaURI: string;
}): Record<string, string> {
  const abi = AbiCoder.defaultAbiCoder();
  const resolverIface = new Interface([
    'function addr(bytes32 node, uint256 coinType) view returns (bytes)',
    'function text(bytes32 node, string key) view returns (string)',
  ]);
  const multicallIface = new Interface([
    'function multicall(bytes[] data) view returns (bytes[])',
  ]);
  const urIface = new Interface([
    'function resolve(bytes name, bytes data) view returns (bytes, address)',
  ]);

  const node = namehash(opts.ens);
  const data = multicallIface.encodeFunctionData('multicall', [
    [
      resolverIface.encodeFunctionData('addr', [node, 60]),
      resolverIface.encodeFunctionData('text', [node, opts.key]),
    ],
  ]);
  const calldata = urIface.encodeFunctionData('resolve', [
    dnsEncode(opts.ens),
    data,
  ]);

  // resolve() returns (bytes response, address resolver); `response` decodes as
  // multicall's (bytes[]) = [addr return, text return].
  const addrReturn = abi.encode(['bytes'], [opts.resolvedAddress]);
  const textReturn = abi.encode(['string'], [opts.mediaURI]);
  const multicallResult = abi.encode(['bytes[]'], [[addrReturn, textReturn]]);
  const response = abi.encode(
    ['bytes', 'address'],
    [multicallResult, opts.resolver]
  );

  return {
    [`eth_call:${UNIVERSAL_RESOLVER.toLowerCase()}:${calldata}`]: response,
  };
}

/**
 * Mock entry for the text-only fallback resolve (used when a resolver doesn't
 * implement addr(bytes32,uint256) and the batched multicall reverts).
 */
function mockUniversalResolveText(opts: {
  ens: string;
  key: string;
  resolver: string;
  mediaURI: string;
}): Record<string, string> {
  const abi = AbiCoder.defaultAbiCoder();
  const resolverIface = new Interface([
    'function text(bytes32 node, string key) view returns (string)',
  ]);
  const urIface = new Interface([
    'function resolve(bytes name, bytes data) view returns (bytes, address)',
  ]);

  const node = namehash(opts.ens);
  const textCalldata = resolverIface.encodeFunctionData('text', [
    node,
    opts.key,
  ]);
  const calldata = urIface.encodeFunctionData('resolve', [
    dnsEncode(opts.ens),
    textCalldata,
  ]);
  const textReturn = abi.encode(['string'], [opts.mediaURI]);
  const response = abi.encode(
    ['bytes', 'address'],
    [textReturn, opts.resolver]
  );

  return {
    [`eth_call:${UNIVERSAL_RESOLVER.toLowerCase()}:${calldata}`]: response,
  };
}

let mockAgent: MockAgent;
let originalDispatcher: Dispatcher;
let infuraPool: ReturnType<MockAgent['get']>;
let provider: JsonRpcProvider;
let avt: AvatarResolver;

/**
 * Sets up a table-driven RPC mock: given a map of `method` or `eth_call:to:data` → result,
 * intercept ALL POSTs to infura and respond with the correct result for each call.
 * Handles both single and batched JSON-RPC requests, matching ethers' batching behavior.
 */
function setupRpcMocks(rpcTable: Record<string, string>) {
  infuraPool
    .intercept({
      path: INFURA_URL.pathname,
      method: 'POST',
    })
    .reply(req => {
      const bodyStr =
        typeof req.body === 'string'
          ? req.body
          : Buffer.from(req.body as Uint8Array).toString();
      const body = JSON.parse(bodyStr);
      const isBatch = Array.isArray(body);
      const calls = isBatch ? body : [body];

      const results = calls.map(
        (call: {
          method: string;
          params?: Array<{ to: string; data: string } | string>;
          id: number;
        }) => {
          let result: string | undefined;

          if (call.method === 'eth_chainId') {
            result = rpcTable['eth_chainId'] || '0x1';
          } else if (call.method === 'eth_call' && call.params) {
            const param = call.params[0];
            if (typeof param === 'object' && param !== null) {
              const key = `eth_call:${param.to}:${param.data}`;
              result = rpcTable[key];
            }
          }

          if (result === undefined) {
            result = '0x';
          }

          return { jsonrpc: '2.0', id: call.id, result };
        }
      );

      return {
        statusCode: 200,
        data: JSON.stringify(isBatch ? results : results[0]),
        responseOptions: {
          headers: { 'content-type': 'application/json', ...CORS_HEADERS },
        },
      };
    })
    .persist();
}

beforeEach(() => {
  originalDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  infuraPool = mockAgent.get(INFURA_URL.origin);
});

afterEach(async () => {
  await mockAgent.close();
  setGlobalDispatcher(originalDispatcher);
});

function mockPool(origin: string) {
  return mockAgent.get(origin);
}

describe('get avatar', () => {
  it('retrieves image uri with erc721 spec', async () => {
    const PublicResolver = '0x4976fb03c32e5b8cfe2b6ccb31c09ba78ebaba41';

    setupRpcMocks({
      eth_chainId: '0x1',
      ...mockUniversalResolve({
        ens: 'matoken.eth',
        key: 'avatar',
        resolver: PublicResolver,
        resolvedAddress: '0x5a384227b65fa093dec03ec34e111db80a040615',
        mediaURI:
          'eip155:1/erc721:0x31385d3520bced94f77aae104b406994d8f2168c/9421',
      }),
      [`eth_call:0x31385d3520bced94f77aae104b406994d8f2168c:0xc87b56dd00000000000000000000000000000000000000000000000000000000000024cd`]: '0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000002568747470733a2f2f6170692e6261737461726467616e70756e6b732e636c75622f39343231000000000000000000000000000000000000000000000000000000',
      [`eth_call:0x31385d3520bced94f77aae104b406994d8f2168c:0x6352211e00000000000000000000000000000000000000000000000000000000000024cd`]: '0x0000000000000000000000005a384227b65fa093dec03ec34e111db80a040615',
    });

    provider = new JsonRpcProvider(INFURA_URL.toString(), 'mainnet');
    avt = new AvatarResolver(fromEthers(provider), {
      apiKey: { opensea: 'api-key' },
      dispatcher: mockAgent,
    });

    const MANIFEST_URI_MATOKEN = new URL(
      'https://api.bastardganpunks.club/9421'
    );
    const NFT_URI_MATOKEN = new URL(
      'https://ipfs.io/ipfs/QmRagxjj2No4T8gNCjpM42mLZGQE3ZwMYdTFUYe6e6LMBG'
    );

    const manifestPool = mockPool(MANIFEST_URI_MATOKEN.origin);
    manifestPool
      .intercept({
        path: MANIFEST_URI_MATOKEN.pathname,
        method: 'GET',
      })
      .reply(
        200,
        {
          tokenId: 9421,
          name: 'BASTARD GAN PUNK V2 #9421',
          description:
            "FOR THE CHANCES\nI HAVEN'T GOT A BURIAL IN MY ARMS\nAND I'VE HAD ENOUGH\nTIME IS NOW\nIT'S TIME\nI'VE GOT NOTHING TO PROVE\nI'VE GOT NOTHING TO LOSE\n",
          image:
            'https://ipfs.io/ipfs/QmRagxjj2No4T8gNCjpM42mLZGQE3ZwMYdTFUYe6e6LMBG',
          imageArweave:
            'https://arweave.net/ve7z_TcSos6nJpjGyuT423B9yyalq5GR4s7CQWGXHpk',
          external_url: 'https://www.bastardganpunks.club/v2/9421',
        },
        {
          headers: {
            'content-type': 'application/json',
            ...CORS_HEADERS,
          },
        }
      );

    const nftPool = mockPool(NFT_URI_MATOKEN.origin);
    nftPool
      .intercept({
        path: NFT_URI_MATOKEN.pathname,
        method: 'HEAD',
      })
      .reply(200, '', {
        headers: {
          ...CORS_HEADERS,
          'content-type': 'image/png',
        },
      });

    expect(await avt.getAvatar('matoken.eth')).toEqual(
      'https://ipfs.io/ipfs/QmRagxjj2No4T8gNCjpM42mLZGQE3ZwMYdTFUYe6e6LMBG'
    );
  });

  it('retrieves image uri with custom spec', async () => {
    const PublicResolver = '0x4976fb03c32e5b8cfe2b6ccb31c09ba78ebaba41';

    setupRpcMocks({
      eth_chainId: '0x1',
      ...mockUniversalResolve({
        ens: 'tanrikulu.eth',
        key: 'avatar',
        resolver: PublicResolver,
        resolvedAddress: '0x0d59d0f7dcc0fbf0a3305ce0261863aaf7ab685c',
        mediaURI:
          'https://ipfs.io/ipfs/QmUShgfoZQSHK3TQyuTfUpsc8UfeNfD8KwPUvDBUdZ4nmR',
      }),
    });

    provider = new JsonRpcProvider(INFURA_URL.toString(), 'mainnet');
    avt = new AvatarResolver(fromEthers(provider), {
      apiKey: { opensea: 'api-key' },
      dispatcher: mockAgent,
    });

    const MANIFEST_URI_TANRIKULU = new URL(
      'https://ipfs.io/ipfs/QmUShgfoZQSHK3TQyuTfUpsc8UfeNfD8KwPUvDBUdZ4nmR'
    );
    const ipfsPool = mockPool(MANIFEST_URI_TANRIKULU.origin);
    ipfsPool
      .intercept({
        path: MANIFEST_URI_TANRIKULU.pathname,
        method: 'HEAD',
      })
      .reply(200, '', {
        headers: {
          ...CORS_HEADERS,
          'content-type': 'image/png',
        },
      });
    ipfsPool
      .intercept({
        path: MANIFEST_URI_TANRIKULU.pathname,
        method: 'GET',
      })
      .reply(
        200,
        {},
        {
          headers: {
            'content-type': 'application/json',
            ...CORS_HEADERS,
          },
        }
      );
    expect(await avt.getAvatar('tanrikulu.eth')).toEqual(
      'https://ipfs.io/ipfs/QmUShgfoZQSHK3TQyuTfUpsc8UfeNfD8KwPUvDBUdZ4nmR'
    );
  });

  it('retrieves image uri with erc1155 spec', async () => {
    setupRpcMocks({
      eth_chainId: '0x1',
      ...mockUniversalResolve({
        ens: 'nick.eth',
        key: 'avatar',
        resolver: '0x4976fb03c32e5b8cfe2b6ccb31c09ba78ebaba41',
        resolvedAddress: '0xb8c2c29ee19d8307cb7255e1cd9cbde883a267d5',
        mediaURI:
          'eip155:1/erc1155:0x495f947276749ce646f68ac8c248420045cb7b5e/8112316025873927737505937898915153732580103913704334048512380490797008551937',
      }),
      [`eth_call:0x495f947276749ce646f68ac8c248420045cb7b5e:0x0e89341c11ef687cfeb2e353670479f2dcc76af2bc6b3935000000000002c40000000001`]: '0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000005868747470733a2f2f6170692e6f70656e7365612e696f2f6170692f76312f6d657461646174612f3078343935663934373237363734394365363436663638414338633234383432303034356362376235652f30787b69647d0000000000000000',
      [`eth_call:0x495f947276749ce646f68ac8c248420045cb7b5e:0x00fdd58e000000000000000000000000b8c2c29ee19d8307cb7255e1cd9cbde883a267d511ef687cfeb2e353670479f2dcc76af2bc6b3935000000000002c40000000001`]: '0x0000000000000000000000000000000000000000000000000000000000000001',
    });

    provider = new JsonRpcProvider(INFURA_URL.toString(), 'mainnet');
    avt = new AvatarResolver(fromEthers(provider), {
      apiKey: { opensea: 'api-key' },
      dispatcher: mockAgent,
    });

    const MANIFEST_URI_NICK = new URL(
      'https://api.opensea.io/api/v1/metadata/0x495f947276749Ce646f68AC8c248420045cb7b5e/8112316025873927737505937898915153732580103913704334048512380490797008551937'
    );
    const NFT_URI_NICK = new URL(
      'https://i.seadn.io/gae/hKHZTZSTmcznonu8I6xcVZio1IF76fq0XmcxnvUykC-FGuVJ75UPdLDlKJsfgVXH9wOSmkyHw0C39VAYtsGyxT7WNybjQ6s3fM3macE?w=500&auto=format'
    );

    const openseaPool = mockPool(MANIFEST_URI_NICK.origin);
    openseaPool
      .intercept({
        path: MANIFEST_URI_NICK.pathname,
        method: 'GET',
      })
      .reply(
        200,
        {
          name: 'Nick Johnson',
          description: null,
          external_link: null,
          image: NFT_URI_NICK.toString(),
          animation_url: null,
        },
        {
          headers: {
            'content-type': 'application/json',
            ...CORS_HEADERS,
          },
        }
      );

    const seadnPool = mockPool(NFT_URI_NICK.origin);
    seadnPool
      .intercept({
        path: NFT_URI_NICK.pathname + '?' + NFT_URI_NICK.searchParams,
        method: 'HEAD',
      })
      .reply(200, '', {
        headers: {
          'accept-ranges': 'bytes',
          'access-control-allow-origin': '*',
          'content-length': '7229',
          'content-type': 'image/png',
        },
      });

    expect(await avt.getAvatar('nick.eth')).toEqual(NFT_URI_NICK.toString());
  });

  it('falls back to a text-only resolve when the batched multicall reverts', async () => {
    // Only the text-only resolve is mocked; the batched addr+text multicall is
    // left unmocked (returns empty), simulating a resolver that doesn't support
    // addr(bytes32,uint256). The avatar should still resolve via the fallback.
    setupRpcMocks({
      eth_chainId: '0x1',
      ...mockUniversalResolveText({
        ens: 'legacy.eth',
        key: 'avatar',
        resolver: '0x4976fb03c32e5b8cfe2b6ccb31c09ba78ebaba41',
        mediaURI:
          'https://ipfs.io/ipfs/QmUShgfoZQSHK3TQyuTfUpsc8UfeNfD8KwPUvDBUdZ4nmR',
      }),
    });
    provider = new JsonRpcProvider(INFURA_URL.toString(), 'mainnet');

    const result = await fromEthers(provider).getEnsRecord(
      'legacy.eth',
      'avatar'
    );
    expect(result.record).toEqual(
      'https://ipfs.io/ipfs/QmUShgfoZQSHK3TQyuTfUpsc8UfeNfD8KwPUvDBUdZ4nmR'
    );
    // ownership check is skipped in the fallback (no address resolved)
    expect(result.address).toBeNull();
  });

  it('returns null (does not throw) when the name cannot be resolved', async () => {
    // No Universal Resolver mock — resolve() returns empty, which the resolver
    // treats as unresolved and returns null rather than throwing.
    setupRpcMocks({ eth_chainId: '0x1' });
    provider = new JsonRpcProvider(INFURA_URL.toString(), 'mainnet');
    avt = new AvatarResolver(fromEthers(provider), { dispatcher: mockAgent });
    await expect(avt.getAvatar('does-not-resolve.eth')).resolves.toBeNull();
  });

  it('sets cache to 1 sec', async () => {
    setupRpcMocks({ eth_chainId: '0x1' });
    provider = new JsonRpcProvider(INFURA_URL.toString(), 'mainnet');
    const avt = new AvatarResolver(fromEthers(provider), {
      cache: 1,
      dispatcher: mockAgent,
    });
    expect(avt?.options?.cache).toEqual(1);
  });
});

describe('get banner/header', () => {
  it('retrieves image uri with custom spec', async () => {
    const PublicResolver = '0x4976fb03c32e5b8cfe2b6ccb31c09ba78ebaba41';

    setupRpcMocks({
      eth_chainId: '0x1',
      ...mockUniversalResolve({
        ens: 'tanrikulu.eth',
        key: 'header',
        resolver: PublicResolver,
        resolvedAddress: '0x0d59d0f7dcc0fbf0a3305ce0261863aaf7ab685c',
        mediaURI:
          'https://ipfs.io/ipfs/QmUShgfoZQSHK3TQyuTfUpsc8UfeNfD8KwPUvDBUdZ4nmR',
      }),
    });

    provider = new JsonRpcProvider(INFURA_URL.toString(), 'mainnet');
    avt = new AvatarResolver(fromEthers(provider), {
      apiKey: { opensea: 'api-key' },
      dispatcher: mockAgent,
    });

    const HEADER_URI_TANRIKULU = new URL(
      'https://ipfs.io/ipfs/QmUShgfoZQSHK3TQyuTfUpsc8UfeNfD8KwPUvDBUdZ4nmR'
    );

    const ipfsPool = mockPool(HEADER_URI_TANRIKULU.origin);
    ipfsPool
      .intercept({
        path: HEADER_URI_TANRIKULU.pathname,
        method: 'HEAD',
      })
      .reply(200, '', {
        headers: {
          ...CORS_HEADERS,
          'content-type': 'image/png',
        },
      });
    ipfsPool
      .intercept({
        path: HEADER_URI_TANRIKULU.pathname,
        method: 'GET',
      })
      .reply(
        200,
        {},
        {
          headers: {
            'content-type': 'application/json',
            ...CORS_HEADERS,
          },
        }
      );
    expect(await avt.getHeader('tanrikulu.eth')).toEqual(
      'https://ipfs.io/ipfs/QmUShgfoZQSHK3TQyuTfUpsc8UfeNfD8KwPUvDBUdZ4nmR'
    );
  });
});

describe('fromViem adapter', () => {
  it('maps getEnsRecord to the viem client (getEnsText + getEnsAddress)', async () => {
    const client: ViemClientLike = {
      async getEnsText({ name, key }) {
        return name === 'tanrikulu.eth' && key === 'avatar'
          ? 'https://example.com/a.png'
          : null;
      },
      async getEnsAddress({ name }) {
        return name === 'tanrikulu.eth'
          ? '0x5a384227b65fa093dec03ec34e111db80a040615'
          : null;
      },
      async readContract() {
        throw new Error('not used in this test');
      },
    };

    const record = await fromViem(client).getEnsRecord(
      'tanrikulu.eth',
      'avatar'
    );
    expect(record).toEqual({
      record: 'https://example.com/a.png',
      address: '0x5a384227b65fa093dec03ec34e111db80a040615',
    });
  });

  it('resolves an erc721 NFT avatar through a viem-style client (readContract path)', async () => {
    const NFT_URI = new URL(
      'https://ipfs.io/ipfs/QmRagxjj2No4T8gNCjpM42mLZGQE3ZwMYdTFUYe6e6LMBG'
    );
    const MANIFEST = new URL('https://api.bastardganpunks.club/9421');

    const client: ViemClientLike = {
      async getEnsText() {
        return 'eip155:1/erc721:0x31385d3520bced94f77aae104b406994d8f2168c/9421';
      },
      async getEnsAddress() {
        return '0x5a384227b65fa093dec03ec34e111db80a040615';
      },
      async readContract({ functionName }) {
        if (functionName === 'tokenURI') return MANIFEST.toString();
        if (functionName === 'ownerOf')
          return '0x5a384227b65fa093dec03ec34e111db80a040615';
        throw new Error(`unexpected function ${functionName}`);
      },
    };

    const avt = new AvatarResolver(fromViem(client), { dispatcher: mockAgent });

    const manifestPool = mockPool(MANIFEST.origin);
    manifestPool
      .intercept({ path: MANIFEST.pathname, method: 'GET' })
      .reply(
        200,
        { image: NFT_URI.toString() },
        { headers: { 'content-type': 'application/json', ...CORS_HEADERS } }
      );

    const nftPool = mockPool(NFT_URI.origin);
    nftPool
      .intercept({ path: NFT_URI.pathname, method: 'HEAD' })
      .reply(200, '', {
        headers: { ...CORS_HEADERS, 'content-type': 'image/png' },
      });

    expect(await avt.getAvatar('matoken.eth')).toEqual(NFT_URI.toString());
  });

  it('resolves an erc1155 NFT avatar through a viem-style client (readContract path)', async () => {
    const MANIFEST = new URL('https://nft.example/meta/erc1155.json');
    const NFT_URI = new URL('https://img.example/erc1155.png');
    const owner = '0xb8c2c29ee19d8307cb7255e1cd9cbde883a267d5';

    const client: ViemClientLike = {
      async getEnsText() {
        return 'eip155:1/erc1155:0x495f947276749ce646f68ac8c248420045cb7b5e/8112316025873927737505937898915153732580103913704334048512380490797008551937';
      },
      async getEnsAddress() {
        return owner;
      },
      async readContract({ functionName }) {
        if (functionName === 'uri') return MANIFEST.toString();
        if (functionName === 'balanceOf') return BigInt(1);
        throw new Error(`unexpected function ${functionName}`);
      },
    };

    const avt = new AvatarResolver(fromViem(client), { dispatcher: mockAgent });

    mockPool(MANIFEST.origin)
      .intercept({ path: MANIFEST.pathname, method: 'GET' })
      .reply(
        200,
        { image: NFT_URI.toString() },
        { headers: { 'content-type': 'application/json', ...CORS_HEADERS } }
      );
    mockPool(NFT_URI.origin)
      .intercept({ path: NFT_URI.pathname, method: 'HEAD' })
      .reply(200, '', {
        headers: { ...CORS_HEADERS, 'content-type': 'image/png' },
      });

    expect(await avt.getAvatar('nick.eth')).toEqual(NFT_URI.toString());
  });
});

describe('SVG avatars (end to end)', () => {
  it('sanitizes an inline data: URI SVG avatar via getAvatar (viem adapter)', async () => {
    const hostileSVG =
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script><rect width="10" height="10" fill="red"/></svg>';
    const dataUri =
      'data:image/svg+xml;base64,' + Buffer.from(hostileSVG).toString('base64');

    const client: ViemClientLike = {
      async getEnsText() {
        return dataUri;
      },
      async getEnsAddress() {
        return null;
      },
      async readContract() {
        throw new Error('not used');
      },
    };

    const avt = new AvatarResolver(fromViem(client), { dispatcher: mockAgent });
    const result = await avt.getAvatar('svg-data.eth');
    expect(result).toBeTruthy();
    expect(result!.startsWith('data:image/svg+xml;base64,')).toBe(true);
    const decoded = Buffer.from(
      result!.replace('data:image/svg+xml;base64,', ''),
      'base64'
    ).toString();
    expect(decoded).not.toMatch(/<script|alert/i);
    expect(decoded).toContain('fill="red"');
  });

  it('passes through an http(s) SVG avatar URL unchanged via getAvatar (ethers adapter)', async () => {
    // NOTE: remote (http/https) SVGs are returned as the raw URL — the library
    // does NOT fetch and sanitize them (only inline data:/on-chain SVGs are
    // sanitized). The content-type check + SSRF protection are the safeguards;
    // the consumer is responsible for sanitizing remote SVG bytes at render time.
    const SVG_URL = new URL('https://svg.example/avatar.svg');

    setupRpcMocks({
      eth_chainId: '0x1',
      ...mockUniversalResolve({
        ens: 'svg-http.eth',
        key: 'avatar',
        resolver: '0x4976fb03c32e5b8cfe2b6ccb31c09ba78ebaba41',
        resolvedAddress: '0x0d59d0f7dcc0fbf0a3305ce0261863aaf7ab685c',
        mediaURI: SVG_URL.toString(),
      }),
    });
    provider = new JsonRpcProvider(INFURA_URL.toString(), 'mainnet');
    avt = new AvatarResolver(fromEthers(provider), { dispatcher: mockAgent });

    mockPool(SVG_URL.origin)
      .intercept({ path: SVG_URL.pathname, method: 'HEAD' })
      .reply(200, '', {
        headers: { ...CORS_HEADERS, 'content-type': 'image/svg+xml' },
      });

    expect(await avt.getAvatar('svg-http.eth')).toEqual(SVG_URL.toString());
  });
});

describe('ERC-1155 {id} substitution (spec-compliant hex)', () => {
  it('replaces {id} with 64-char lowercase hex of the uint256 id', async () => {
    const tokenId = '1234';
    const idHex = BigInt(tokenId)
      .toString(16)
      .padStart(64, '0');
    const META = new URL(`https://erc1155.example/${idHex}.json`);
    const IMG = new URL('https://img.example/erc1155-id.png');

    const client: ViemClientLike = {
      async getEnsText() {
        return `eip155:1/erc1155:0x495f947276749ce646f68ac8c248420045cb7b5e/${tokenId}`;
      },
      async getEnsAddress() {
        return '0xb8c2c29ee19d8307cb7255e1cd9cbde883a267d5';
      },
      async readContract({ functionName }) {
        if (functionName === 'uri') return 'https://erc1155.example/{id}.json';
        if (functionName === 'balanceOf') return BigInt(1);
        throw new Error(`unexpected function ${functionName}`);
      },
    };

    const avt = new AvatarResolver(fromViem(client), { dispatcher: mockAgent });

    // The mock only matches the spec-correct hex path; a decimal-padded {id}
    // would request a different path and the request would not be intercepted.
    mockPool(META.origin)
      .intercept({ path: META.pathname, method: 'GET' })
      .reply(
        200,
        { image: IMG.toString() },
        { headers: { 'content-type': 'application/json', ...CORS_HEADERS } }
      );
    mockPool(IMG.origin)
      .intercept({ path: IMG.pathname, method: 'HEAD' })
      .reply(200, '', {
        headers: { ...CORS_HEADERS, 'content-type': 'image/png' },
      });

    expect(await avt.getAvatar('erc1155-id.eth')).toEqual(IMG.toString());
  });
});

describe('public type exports', () => {
  it('exposes option/return types from the package entry point', () => {
    // Compile-time check: these names must be importable from '../src'.
    const opts: AvatarResolverOpts = { cache: 1, allowPrivateIPs: false };
    const meta: NFTMetadata = { image: 'x' };
    const key: MediaKey = 'avatar';
    const gw: Gateways = { ipfs: 'https://ipfs.io' };
    expect(opts.cache).toBe(1);
    expect(meta.image).toBe('x');
    expect(key).toBe('avatar');
    expect(gw.ipfs).toContain('ipfs');
  });
});
