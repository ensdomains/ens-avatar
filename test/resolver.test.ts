import { JsonRpcProvider } from 'ethers';
import nock from 'nock';
import { AvatarResolver } from '../src';

require('dotenv').config();

const ENSRegistryWithFallback = '0x00000000000c2e074ec69a0dfb2997ba6c7d2e1e';
const PublicResolver = '0x4976fb03C32e5B8cfe2b6cCB31c09Ba78EBaBa41';
const INFURA_URL = new URL(
  `https://mainnet.infura.io/v3/${process.env.INFURA_KEY}`
);
const CORS_HEADERS = {
  'access-control-allow-credentials': true,
  'access-control-allow-origin': 'http://localhost',
};

function nockInfuraBatch(body: any[], response: any) {
  nock(INFURA_URL.origin)
    .persist(false)
    .post(INFURA_URL.pathname, body)
    .reply(200, response);
}

function mockInfuraChainId(id: number) {
  nock(INFURA_URL.origin)
    .post(INFURA_URL.pathname, {
      method: 'eth_chainId',
      params: [],
      id: /[0-9]/,
      jsonrpc: '2.0',
    })
    .reply(
      200,
      {
        jsonrpc: '2.0',
        id: id,
        result: '0x1',
      },
      CORS_HEADERS as any
    );
}

function ethCallParams(to: string, data: string, id: number) {
  return {
    method: 'eth_call',
    params: [{ to, data }, 'latest'],
    id,
    jsonrpc: '2.0',
  };
}

function chainIdParams(id: number) {
  return {
    method: 'eth_chainId',
    params: [],
    id,
    jsonrpc: '2.0',
  };
}

function jsonRPCresult(result: string, id: number) {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

describe('get avatar', () => {
  const provider = new JsonRpcProvider(INFURA_URL.toString(), 'mainnet');
  const avt = new AvatarResolver(provider, {
    apiKey: {
      opensea: 'a2b184238ee8460d9d2f58b0d3177c23',
    },
  });
  it('retrieves image uri with erc721 spec', async () => {
    mockInfuraChainId(1);

    nockInfuraBatch(
      [
        chainIdParams(2),
        ethCallParams(
          ENSRegistryWithFallback,
          '0x0178b8bf80ee077a908dffcf32972ba13c2df16b42688e1de21bcf17d3469a8507895eae',
          3
        ),
        ethCallParams(
          ENSRegistryWithFallback,
          '0x0178b8bf80ee077a908dffcf32972ba13c2df16b42688e1de21bcf17d3469a8507895eae',
          4
        ),
      ],
      [
        jsonRPCresult('0x1', 2),
        jsonRPCresult(
          '0x0000000000000000000000004976fb03c32e5b8cfe2b6ccb31c09ba78ebaba41',
          3
        ),
        jsonRPCresult(
          '0x0000000000000000000000004976fb03c32e5b8cfe2b6ccb31c09ba78ebaba41',
          4
        ),
      ]
    );
    nockInfuraBatch(
      [
        ethCallParams(
          PublicResolver.toLowerCase(),
          '0x01ffc9a79061b92300000000000000000000000000000000000000000000000000000000',
          5
        ),
        chainIdParams(6),
      ],
      [
        jsonRPCresult(
          '0x0000000000000000000000000000000000000000000000000000000000000000',
          5
        ),
        jsonRPCresult('0x1', 6),
      ]
    );
    nockInfuraBatch(
      [
        ethCallParams(
          PublicResolver.toLowerCase(),
          '0x3b3b57de80ee077a908dffcf32972ba13c2df16b42688e1de21bcf17d3469a8507895eae',
          7
        ),
        chainIdParams(8),
      ],
      [
        jsonRPCresult(
          '0x0000000000000000000000005a384227b65fa093dec03ec34e111db80a040615',
          7
        ),
        jsonRPCresult('0x1', 8),
      ]
    );
    nockInfuraBatch(
      [
        ethCallParams(
          PublicResolver.toLowerCase(),
          '0x01ffc9a79061b92300000000000000000000000000000000000000000000000000000000',
          9
        ),
        chainIdParams(10),
      ],
      [
        jsonRPCresult(
          '0x0000000000000000000000000000000000000000000000000000000000000000',
          9
        ),
        jsonRPCresult('0x1', 10),
      ]
    );
    nockInfuraBatch(
      [
        ethCallParams(
          PublicResolver.toLowerCase(),
          '0x59d1d43c80ee077a908dffcf32972ba13c2df16b42688e1de21bcf17d3469a8507895eae000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000066176617461720000000000000000000000000000000000000000000000000000',
          11
        ),
        chainIdParams(12),
      ],
      [
        jsonRPCresult(
          '0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000003f6569703135353a312f6572633732313a3078333133383564333532306263656439346637376161653130346234303639393464386632313638632f3934323100',
          11
        ),
        jsonRPCresult('0x1', 12),
      ]
    );
    nockInfuraBatch(
      [
        ethCallParams(
          '0x31385d3520bced94f77aae104b406994d8f2168c',
          '0xc87b56dd00000000000000000000000000000000000000000000000000000000000024cd',
          13
        ),
        chainIdParams(14),
        ethCallParams(
          '0x31385d3520bced94f77aae104b406994d8f2168c',
          '0x6352211e00000000000000000000000000000000000000000000000000000000000024cd',
          15
        ),
      ],
      [
        jsonRPCresult(
          '0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000002568747470733a2f2f6170692e6261737461726467616e70756e6b732e636c75622f39343231000000000000000000000000000000000000000000000000000000',
          13
        ),
        jsonRPCresult('0x1', 14),
        jsonRPCresult(
          '0x0000000000000000000000005a384227b65fa093dec03ec34e111db80a040615',
          15
        ),
      ]
    );

    const MANIFEST_URI_MATOKEN = new URL(
      'https://api.bastardganpunks.club/9421'
    );
    const NFT_URI_MATOKEN = new URL(
      'https://ipfs.io/ipfs/QmRagxjj2No4T8gNCjpM42mLZGQE3ZwMYdTFUYe6e6LMBG'
    );
    nock(MANIFEST_URI_MATOKEN.origin)
      .get(MANIFEST_URI_MATOKEN.pathname)
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
        CORS_HEADERS as any
      );
    nock(NFT_URI_MATOKEN.origin)
      .head(NFT_URI_MATOKEN.pathname)
      .reply(200, {}, {
        ...CORS_HEADERS,
        'content-type': 'image/png',
      } as any);
    expect(await avt.getAvatar('matoken.eth')).toEqual(
      'https://ipfs.io/ipfs/QmRagxjj2No4T8gNCjpM42mLZGQE3ZwMYdTFUYe6e6LMBG'
    );
  });
  it('retrieves image uri with custom spec', async () => {
    mockInfuraChainId(16);

    nockInfuraBatch(
      [
        ethCallParams(
          ENSRegistryWithFallback.toString(),
          '0x0178b8bfb47a0edaf3c702800c923ca4c44a113d0d718cb1f42ecdce70c5fd05fa36a63f',
          17
        ),
        chainIdParams(18),
        ethCallParams(
          ENSRegistryWithFallback.toString(),
          '0x0178b8bfb47a0edaf3c702800c923ca4c44a113d0d718cb1f42ecdce70c5fd05fa36a63f',
          19
        ),
      ],
      [
        jsonRPCresult(
          '0x0000000000000000000000004976fb03c32e5b8cfe2b6ccb31c09ba78ebaba41',
          17
        ),
        jsonRPCresult('0x1', 18),
        jsonRPCresult(
          '0x0000000000000000000000004976fb03c32e5b8cfe2b6ccb31c09ba78ebaba41',
          19
        ),
      ]
    );
    nockInfuraBatch(
      [
        ethCallParams(
          PublicResolver.toLowerCase(),
          '0x01ffc9a79061b92300000000000000000000000000000000000000000000000000000000',
          20
        ),
        chainIdParams(21),
      ],
      [
        jsonRPCresult(
          '0x0000000000000000000000000000000000000000000000000000000000000000',
          20
        ),
        jsonRPCresult('0x1', 21),
      ]
    );
    nockInfuraBatch(
      [
        ethCallParams(
          PublicResolver.toLowerCase(),
          '0x3b3b57deb47a0edaf3c702800c923ca4c44a113d0d718cb1f42ecdce70c5fd05fa36a63f',
          22
        ),
        chainIdParams(23),
      ],
      [
        jsonRPCresult(
          '0x0000000000000000000000000d59d0f7dcc0fbf0a3305ce0261863aaf7ab685c',
          22
        ),
        jsonRPCresult('0x1', 23),
      ]
    );
    nockInfuraBatch(
      [
        ethCallParams(
          PublicResolver.toLowerCase(),
          '0x01ffc9a79061b92300000000000000000000000000000000000000000000000000000000',
          24
        ),
        chainIdParams(25),
      ],
      [
        jsonRPCresult(
          '0x0000000000000000000000000000000000000000000000000000000000000000',
          24
        ),
        jsonRPCresult('0x1', 25),
      ]
    );
    nockInfuraBatch(
      [
        ethCallParams(
          PublicResolver.toLowerCase(),
          '0x59d1d43cb47a0edaf3c702800c923ca4c44a113d0d718cb1f42ecdce70c5fd05fa36a63f000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000066176617461720000000000000000000000000000000000000000000000000000',
          26
        ),
        chainIdParams(27),
      ],
      [
        jsonRPCresult(
          '0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000004368747470733a2f2f697066732e696f2f697066732f516d55536867666f5a5153484b3354517975546655707363385566654e6644384b77505576444255645a346e6d520000000000000000000000000000000000000000000000000000000000',
          26
        ),
        jsonRPCresult('0x1', 27),
      ]
    );
    const MANIFEST_URI_TANRIKULU = new URL(
      'https://ipfs.io/ipfs/QmUShgfoZQSHK3TQyuTfUpsc8UfeNfD8KwPUvDBUdZ4nmR'
    );
    /* mock head call */
    nock(MANIFEST_URI_TANRIKULU.origin)
      .head(MANIFEST_URI_TANRIKULU.pathname)
      .reply(200, {}, {
        ...CORS_HEADERS,
        'content-type': 'image/png',
      } as any);
    /* mock get call */
    nock(MANIFEST_URI_TANRIKULU.origin)
      .get(MANIFEST_URI_TANRIKULU.pathname)
      .reply(200, {}, {
        ...CORS_HEADERS,
        'content-type': 'image/png',
      } as any);
    expect(await avt.getAvatar('tanrikulu.eth')).toEqual(
      'https://ipfs.io/ipfs/QmUShgfoZQSHK3TQyuTfUpsc8UfeNfD8KwPUvDBUdZ4nmR'
    );
  });
  it('retrieves image uri with erc1155 spec', async () => {
    mockInfuraChainId(28);

    nockInfuraBatch(
      [
        ethCallParams(
          ENSRegistryWithFallback.toLowerCase(),
          '0x0178b8bf05a67c0ee82964c4f7394cdd47fee7f4d9503a23c09c38341779ea012afe6e00',
          29
        ),
        chainIdParams(30),
        ethCallParams(
          ENSRegistryWithFallback.toLowerCase(),
          '0x0178b8bf05a67c0ee82964c4f7394cdd47fee7f4d9503a23c09c38341779ea012afe6e00',
          31
        ),
      ],
      [
        jsonRPCresult(
          '0x0000000000000000000000004976fb03c32e5b8cfe2b6ccb31c09ba78ebaba41',
          29
        ),
        jsonRPCresult('0x1', 30),
        jsonRPCresult(
          '0x0000000000000000000000004976fb03c32e5b8cfe2b6ccb31c09ba78ebaba41',
          31
        ),
      ]
    );
    nockInfuraBatch(
      [
        ethCallParams(
          PublicResolver.toLowerCase(),
          '0x01ffc9a79061b92300000000000000000000000000000000000000000000000000000000',
          32
        ),
        chainIdParams(33),
      ],
      [
        jsonRPCresult(
          '0x0000000000000000000000000000000000000000000000000000000000000000',
          32
        ),
        jsonRPCresult('0x1', 33),
      ]
    );
    nockInfuraBatch(
      [
        ethCallParams(
          PublicResolver.toLowerCase(),
          '0x3b3b57de05a67c0ee82964c4f7394cdd47fee7f4d9503a23c09c38341779ea012afe6e00',
          34
        ),
        chainIdParams(35),
      ],
      [
        jsonRPCresult(
          '0x000000000000000000000000b8c2c29ee19d8307cb7255e1cd9cbde883a267d5',
          34
        ),
        jsonRPCresult('0x1', 35),
      ]
    );
    nockInfuraBatch(
      [
        ethCallParams(
          PublicResolver.toLowerCase(),
          '0x01ffc9a79061b92300000000000000000000000000000000000000000000000000000000',
          36
        ),
        chainIdParams(37),
      ],
      [
        jsonRPCresult(
          '0x0000000000000000000000000000000000000000000000000000000000000000',
          36
        ),
        jsonRPCresult('0x1', 37),
      ]
    );
    nockInfuraBatch(
      [
        ethCallParams(
          PublicResolver.toLowerCase(),
          '0x59d1d43c05a67c0ee82964c4f7394cdd47fee7f4d9503a23c09c38341779ea012afe6e00000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000066176617461720000000000000000000000000000000000000000000000000000',
          38
        ),
        chainIdParams(39),
      ],
      [
        jsonRPCresult(
          '0x000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000886569703135353a312f657263313135353a3078343935663934373237363734396365363436663638616338633234383432303034356362376235652f38313132333136303235383733393237373337353035393337383938393135313533373332353830313033393133373034333334303438353132333830343930373937303038353531393337000000000000000000000000000000000000000000000000',
          38
        ),
        jsonRPCresult('0x1', 39),
      ]
    );
    nockInfuraBatch(
      [
        ethCallParams(
          '0x495f947276749ce646f68ac8c248420045cb7b5e',
          '0x0e89341c11ef687cfeb2e353670479f2dcc76af2bc6b3935000000000002c40000000001',
          40
        ),
        chainIdParams(41),
        ethCallParams(
          '0x495f947276749ce646f68ac8c248420045cb7b5e',
          '0x00fdd58e000000000000000000000000b8c2c29ee19d8307cb7255e1cd9cbde883a267d511ef687cfeb2e353670479f2dcc76af2bc6b3935000000000002c40000000001',
          42
        ),
      ],
      [
        jsonRPCresult(
          '0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000005868747470733a2f2f6170692e6f70656e7365612e696f2f6170692f76312f6d657461646174612f3078343935663934373237363734394365363436663638414338633234383432303034356362376235652f30787b69647d0000000000000000',
          40
        ),
        jsonRPCresult('0x1', 41),
        jsonRPCresult(
          '0x0000000000000000000000000000000000000000000000000000000000000001',
          42
        ),
      ]
    );
    const MANIFEST_URI_NICK = new URL(
      'https://api.opensea.io/api/v1/metadata/0x495f947276749Ce646f68AC8c248420045cb7b5e/8112316025873927737505937898915153732580103913704334048512380490797008551937'
    );
    const NFT_URI_NICK = new URL(
      'https://i.seadn.io/gae/hKHZTZSTmcznonu8I6xcVZio1IF76fq0XmcxnvUykC-FGuVJ75UPdLDlKJsfgVXH9wOSmkyHw0C39VAYtsGyxT7WNybjQ6s3fM3macE?w=500&auto=format'
    );
    nock(MANIFEST_URI_NICK.origin)
      .options(MANIFEST_URI_NICK.pathname)
      .reply(200, {}, {
        ...CORS_HEADERS,
        'access-control-allow-headers':
          'accept, authorization, content-type, user-agent, x-csrftoken, x-requested-with, x-datadog-origin, x-datadog-parent-id, x-datadog-sampled, x-datadog-sampling-priority, x-datadog-trace-id, i196zqqsyk-a0, i196zqqsyk-a1, i196zqqsyk-a2, i196zqqsyk-a, i196zqqsyk-b, i196zqqsyk-c, i196zqqsyk-d, i196zqqsyk-f, i196zqqsyk-z, x-readme-api-explorer, x-api-key, x-build-id, x-signed-query, x-cache-skip, x-app-id, solana-client',
        'access-control-allow-methods':
          'DELETE, GET, OPTIONS, PATCH, POST, PUT',
        'access-control-max-age': '86400',
        'content-type': 'text/html; charset=utf-8',
        'transfer-encoding': 'chunked',
        vary: 'origin',
        'x-content-type-options': 'nosniff',
      } as any);
    nock(NFT_URI_NICK.origin)
      .head(NFT_URI_NICK.pathname + '?' + NFT_URI_NICK.searchParams)
      .reply(
        200,
        {},
        {
          'accept-ranges': 'bytes',
          'access-control-allow-origin': '*',
          'access-control-expose-headers': '*',
          'content-length': '7229',
          'content-type': 'image/png',
        }
      );
    nock(MANIFEST_URI_NICK.origin)
      .get(MANIFEST_URI_NICK.pathname)
      .reply(
        200,
        {
          name: 'Nick Johnson',
          description: null,
          external_link: null,
          image: NFT_URI_NICK.toString(),
          animation_url: null,
        },
        CORS_HEADERS as any
      );
    expect(await avt.getAvatar('nick.eth')).toEqual(NFT_URI_NICK.toString());
  });

  it('sets cache to 1 sec', async () => {
    const avt = new AvatarResolver(provider, { cache: 1 });
    expect(avt?.options?.cache).toEqual(1);
  });

  // it('retrieves image uri with custom nested uri', async () => {
  //   expect(await avt.getAvatar({ ens: 'testname.eth' })).toEqual(
  //     ''
  //   );
  // });

  // on chain svg example
  // it('retrieves image uri with custom nested uri', async () => {
  //   expect(await avt.getAvatar({ ens: 'testname.eth' })).toMatch(/^(data:image\/svg\+xml;base64,).*$/);
  // });
});
