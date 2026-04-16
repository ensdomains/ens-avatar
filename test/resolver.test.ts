import { JsonRpcProvider, FetchRequest } from 'ethers';
import {
  MockAgent,
  setGlobalDispatcher,
  getGlobalDispatcher,
  Dispatcher,
  fetch as undiciFetch,
} from 'undici';
import { AvatarResolver } from '../src';

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
    const ENSRegistryWithFallback =
      '0x00000000000c2e074ec69a0dfb2997ba6c7d2e1e';
    const PublicResolver = '0x4976fb03c32e5b8cfe2b6ccb31c09ba78ebaba41';

    setupRpcMocks({
      eth_chainId: '0x1',
      [`eth_call:${ENSRegistryWithFallback}:0x0178b8bf80ee077a908dffcf32972ba13c2df16b42688e1de21bcf17d3469a8507895eae`]: '0x0000000000000000000000004976fb03c32e5b8cfe2b6ccb31c09ba78ebaba41',
      [`eth_call:${PublicResolver}:0x01ffc9a79061b92300000000000000000000000000000000000000000000000000000000`]: '0x0000000000000000000000000000000000000000000000000000000000000000',
      [`eth_call:${PublicResolver}:0x3b3b57de80ee077a908dffcf32972ba13c2df16b42688e1de21bcf17d3469a8507895eae`]: '0x0000000000000000000000005a384227b65fa093dec03ec34e111db80a040615',
      [`eth_call:${PublicResolver}:0x59d1d43c80ee077a908dffcf32972ba13c2df16b42688e1de21bcf17d3469a8507895eae000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000066176617461720000000000000000000000000000000000000000000000000000`]: '0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000003f6569703135353a312f6572633732313a3078333133383564333532306263656439346637376161653130346234303639393464386632313638632f3934323100',
      [`eth_call:0x31385d3520bced94f77aae104b406994d8f2168c:0xc87b56dd00000000000000000000000000000000000000000000000000000000000024cd`]: '0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000002568747470733a2f2f6170692e6261737461726467616e70756e6b732e636c75622f39343231000000000000000000000000000000000000000000000000000000',
      [`eth_call:0x31385d3520bced94f77aae104b406994d8f2168c:0x6352211e00000000000000000000000000000000000000000000000000000000000024cd`]: '0x0000000000000000000000005a384227b65fa093dec03ec34e111db80a040615',
    });

    provider = new JsonRpcProvider(INFURA_URL.toString(), 'mainnet');
    avt = new AvatarResolver(provider, {
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
    const ENSRegistryWithFallback =
      '0x00000000000c2e074ec69a0dfb2997ba6c7d2e1e';
    const PublicResolver = '0x4976fb03c32e5b8cfe2b6ccb31c09ba78ebaba41';

    setupRpcMocks({
      eth_chainId: '0x1',
      [`eth_call:${ENSRegistryWithFallback}:0x0178b8bfb47a0edaf3c702800c923ca4c44a113d0d718cb1f42ecdce70c5fd05fa36a63f`]: '0x0000000000000000000000004976fb03c32e5b8cfe2b6ccb31c09ba78ebaba41',
      [`eth_call:${PublicResolver}:0x01ffc9a79061b92300000000000000000000000000000000000000000000000000000000`]: '0x0000000000000000000000000000000000000000000000000000000000000000',
      [`eth_call:${PublicResolver}:0x3b3b57deb47a0edaf3c702800c923ca4c44a113d0d718cb1f42ecdce70c5fd05fa36a63f`]: '0x0000000000000000000000000d59d0f7dcc0fbf0a3305ce0261863aaf7ab685c',
      [`eth_call:${PublicResolver}:0x59d1d43cb47a0edaf3c702800c923ca4c44a113d0d718cb1f42ecdce70c5fd05fa36a63f000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000066176617461720000000000000000000000000000000000000000000000000000`]: '0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000004368747470733a2f2f697066732e696f2f697066732f516d55536867666f5a5153484b3354517975546655707363385566654e6644384b77505576444255645a346e6d520000000000000000000000000000000000000000000000000000000000',
    });

    provider = new JsonRpcProvider(INFURA_URL.toString(), 'mainnet');
    avt = new AvatarResolver(provider, {
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
    const ENSRegistryWithFallback =
      '0x00000000000c2e074ec69a0dfb2997ba6c7d2e1e';
    const PublicResolver = '0x4976fb03c32e5b8cfe2b6ccb31c09ba78ebaba41';

    setupRpcMocks({
      eth_chainId: '0x1',
      [`eth_call:${ENSRegistryWithFallback}:0x0178b8bf05a67c0ee82964c4f7394cdd47fee7f4d9503a23c09c38341779ea012afe6e00`]: '0x0000000000000000000000004976fb03c32e5b8cfe2b6ccb31c09ba78ebaba41',
      [`eth_call:${PublicResolver}:0x01ffc9a79061b92300000000000000000000000000000000000000000000000000000000`]: '0x0000000000000000000000000000000000000000000000000000000000000000',
      [`eth_call:${PublicResolver}:0x3b3b57de05a67c0ee82964c4f7394cdd47fee7f4d9503a23c09c38341779ea012afe6e00`]: '0x000000000000000000000000b8c2c29ee19d8307cb7255e1cd9cbde883a267d5',
      [`eth_call:${PublicResolver}:0x59d1d43c05a67c0ee82964c4f7394cdd47fee7f4d9503a23c09c38341779ea012afe6e00000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000066176617461720000000000000000000000000000000000000000000000000000`]: '0x000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000886569703135353a312f657263313135353a3078343935663934373237363734396365363436663638616338633234383432303034356362376235652f38313132333136303235383733393237373337353035393337383938393135313533373332353830313033393133373034333334303438353132333830343930373937303038353531393337000000000000000000000000000000000000000000000000',
      [`eth_call:0x495f947276749ce646f68ac8c248420045cb7b5e:0x0e89341c11ef687cfeb2e353670479f2dcc76af2bc6b3935000000000002c40000000001`]: '0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000005868747470733a2f2f6170692e6f70656e7365612e696f2f6170692f76312f6d657461646174612f3078343935663934373237363734394365363436663638414338633234383432303034356362376235652f30787b69647d0000000000000000',
      [`eth_call:0x495f947276749ce646f68ac8c248420045cb7b5e:0x00fdd58e000000000000000000000000b8c2c29ee19d8307cb7255e1cd9cbde883a267d511ef687cfeb2e353670479f2dcc76af2bc6b3935000000000002c40000000001`]: '0x0000000000000000000000000000000000000000000000000000000000000001',
    });

    provider = new JsonRpcProvider(INFURA_URL.toString(), 'mainnet');
    avt = new AvatarResolver(provider, {
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

  it('sets cache to 1 sec', async () => {
    setupRpcMocks({ eth_chainId: '0x1' });
    provider = new JsonRpcProvider(INFURA_URL.toString(), 'mainnet');
    const avt = new AvatarResolver(provider, {
      cache: 1,
      dispatcher: mockAgent,
    });
    expect(avt?.options?.cache).toEqual(1);
  });
});

describe('get banner/header', () => {
  it('retrieves image uri with custom spec', async () => {
    const ENSRegistryWithFallback =
      '0x00000000000c2e074ec69a0dfb2997ba6c7d2e1e';
    const PublicResolver = '0x4976fb03c32e5b8cfe2b6ccb31c09ba78ebaba41';

    setupRpcMocks({
      eth_chainId: '0x1',
      [`eth_call:${ENSRegistryWithFallback}:0x0178b8bfb47a0edaf3c702800c923ca4c44a113d0d718cb1f42ecdce70c5fd05fa36a63f`]: '0x0000000000000000000000004976fb03c32e5b8cfe2b6ccb31c09ba78ebaba41',
      [`eth_call:${PublicResolver}:0x01ffc9a79061b92300000000000000000000000000000000000000000000000000000000`]: '0x0000000000000000000000000000000000000000000000000000000000000000',
      [`eth_call:${PublicResolver}:0x3b3b57deb47a0edaf3c702800c923ca4c44a113d0d718cb1f42ecdce70c5fd05fa36a63f`]: '0x0000000000000000000000000d59d0f7dcc0fbf0a3305ce0261863aaf7ab685c',
      [`eth_call:${PublicResolver}:0x59d1d43cb47a0edaf3c702800c923ca4c44a113d0d718cb1f42ecdce70c5fd05fa36a63f000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000066865616465720000000000000000000000000000000000000000000000000000`]: '0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000004368747470733a2f2f697066732e696f2f697066732f516d55536867666f5a5153484b3354517975546655707363385566654e6644384b77505576444255645a346e6d520000000000000000000000000000000000000000000000000000000000',
    });

    provider = new JsonRpcProvider(INFURA_URL.toString(), 'mainnet');
    avt = new AvatarResolver(provider, {
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
