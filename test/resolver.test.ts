import { StaticJsonRpcProvider } from '@ethersproject/providers';
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

function nockInfura(method: string, params: any[], response: any) {
  nock(INFURA_URL.origin)
    .persist()
    .post(INFURA_URL.pathname, {
      method,
      params,
      id: /[0-9]/,
      jsonrpc: '2.0',
    })
    .reply(200, response);
}

beforeAll(() => {
  nockInfura('eth_chainId', [], {
    id: 1,
    jsonrpc: '2.0',
    result: '0x01', // mainnet
  });
  nockInfura('net_version', [], {
    jsonrpc: '2.0',
    id: 1,
    result: '1',
  });
  nockInfura(
    'eth_call',
    [
      {
        to: ENSRegistryWithFallback,
        data: /^.*$/,
      },
      'latest',
    ],
    {
      result: `0x${PublicResolver.replace('0x', '').padStart(64, '0')}`,
    }
  );
});

describe('get avatar', () => {
  const provider = new StaticJsonRpcProvider(
    'https://mainnet.infura.io/v3/372375d582d843c48a4eaee6aa5c1b3a'
  );
  const avt = new AvatarResolver(provider);
  it('retrieves image uri with erc1155 spec', async () => {
    nockInfura(
      'eth_call',
      [
        {
          to: PublicResolver.toLowerCase(),
          data:
            '0x3b3b57de05a67c0ee82964c4f7394cdd47fee7f4d9503a23c09c38341779ea012afe6e00',
        },
        'latest',
      ],
      {
        result:
          '0x000000000000000000000000b8c2c29ee19d8307cb7255e1cd9cbde883a267d5',
      }
    );
    nockInfura(
      'eth_call',
      [
        {
          to: PublicResolver.toLowerCase(),
          data:
            '0x59d1d43c05a67c0ee82964c4f7394cdd47fee7f4d9503a23c09c38341779ea012afe6e00000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000066176617461720000000000000000000000000000000000000000000000000000',
        },
        'latest',
      ],
      {
        result:
          '0x000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000886569703135353a312f657263313135353a3078343935663934373237363734396365363436663638616338633234383432303034356362376235652f38313132333136303235383733393237373337353035393337383938393135313533373332353830313033393133373034333334303438353132333830343930373937303038353531393337000000000000000000000000000000000000000000000000',
      }
    );
    nockInfura(
      'eth_call',
      [
        {
          to: '0x495f947276749ce646f68ac8c248420045cb7b5e',
          data:
            '0x0e89341c11ef687cfeb2e353670479f2dcc76af2bc6b3935000000000002c40000000001',
        },
        'latest',
      ],
      {
        result:
          '0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000005868747470733a2f2f6170692e6f70656e7365612e696f2f6170692f76312f6d657461646174612f3078343935663934373237363734394365363436663638414338633234383432303034356362376235652f30787b69647d0000000000000000',
      }
    );
    nockInfura(
      'eth_call',
      [
        {
          to: '0x495f947276749ce646f68ac8c248420045cb7b5e',
          data:
            '0x00fdd58e000000000000000000000000b8c2c29ee19d8307cb7255e1cd9cbde883a267d511ef687cfeb2e353670479f2dcc76af2bc6b3935000000000002c40000000001',
        },
        'latest',
      ],
      {
        result:
          '0x0000000000000000000000000000000000000000000000000000000000000001',
      }
    );
    const MANIFEST_URI_NICK = new URL(
      'https://api.opensea.io/api/v1/metadata/0x495f947276749Ce646f68AC8c248420045cb7b5e/8112316025873927737505937898915153732580103913704334048512380490797008551937'
    );
    nock(MANIFEST_URI_NICK.origin)
      .get(MANIFEST_URI_NICK.pathname)
      .reply(
        200,
        {
          name: 'Nick Johnson',
          description: null,
          external_link: null,
          image:
            'https://lh3.googleusercontent.com/hKHZTZSTmcznonu8I6xcVZio1IF76fq0XmcxnvUykC-FGuVJ75UPdLDlKJsfgVXH9wOSmkyHw0C39VAYtsGyxT7WNybjQ6s3fM3macE',
          animation_url: null,
        },
        CORS_HEADERS as any
      );
    expect(await avt.getAvatar('nick.eth')).toEqual(
      'https://lh3.googleusercontent.com/hKHZTZSTmcznonu8I6xcVZio1IF76fq0XmcxnvUykC-FGuVJ75UPdLDlKJsfgVXH9wOSmkyHw0C39VAYtsGyxT7WNybjQ6s3fM3macE'
    );
  });
  it('retrieves image uri with erc721 spec', async () => {
    nockInfura(
      'eth_call',
      [
        {
          to: PublicResolver.toLowerCase(),
          data:
            '0x3b3b57de43fcd34d8589090581e1d2bdcf5dc17feb05b2006401fb1c3fdded335a465b51',
        },
        'latest',
      ],
      {
        result:
          '0x000000000000000000000000983110309620d911731ac0932219af06091b6744',
      }
    );
    nockInfura(
      'eth_call',
      [
        {
          to: PublicResolver.toLowerCase(),
          data:
            '0x59d1d43c43fcd34d8589090581e1d2bdcf5dc17feb05b2006401fb1c3fdded335a465b51000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000066176617461720000000000000000000000000000000000000000000000000000',
        },
        'latest',
      ],
      {
        result:
          '0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000003f6569703135353a312f6572633732313a3078623746374636433532463265326664623139363345616233303433383032343836346333313346362f3234333000',
      }
    );
    nockInfura(
      'eth_call',
      [
        {
          to: '0xb7f7f6c52f2e2fdb1963eab30438024864c313f6',
          data:
            '0xc87b56dd000000000000000000000000000000000000000000000000000000000000097e',
        },
        'latest',
      ],
      {
        result:
          '0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000003568747470733a2f2f7772617070656470756e6b732e636f6d3a333030302f6170692f70756e6b732f6d657461646174612f323433300000000000000000000000',
      }
    );
    nockInfura(
      'eth_call',
      [
        {
          to: '0xb7f7f6c52f2e2fdb1963eab30438024864c313f6',
          data:
            '0x6352211e000000000000000000000000000000000000000000000000000000000000097e',
        },
        'latest',
      ],
      {
        result:
          '0x000000000000000000000000983110309620d911731ac0932219af06091b6744',
      }
    );
    const MANIFEST_URI_BRANTLY = new URL(
      'https://wrappedpunks.com:3000/api/punks/metadata/2430'
    );
    nock(MANIFEST_URI_BRANTLY.origin)
      .get(MANIFEST_URI_BRANTLY.pathname)
      .reply(
        200,
        {
          title: 'W#2430',
          name: 'W#2430',
          description:
            'This Punk was wrapped using Wrapped Punks contract, accessible from https://wrappedpunks.com',
          image: 'https://api.wrappedpunks.com/images/punks/2430.png',
          external_url: 'https://wrappedpunks.com',
        },
        CORS_HEADERS as any
      );
    expect(await avt.getAvatar('brantly.eth')).toEqual(
      'https://api.wrappedpunks.com/images/punks/2430.png'
    );
  });
  it('retrieves image uri with custom spec', async () => {
    nockInfura(
      'eth_call',
      [
        {
          to: PublicResolver.toLowerCase(),
          data:
            '0x3b3b57deb47a0edaf3c702800c923ca4c44a113d0d718cb1f42ecdce70c5fd05fa36a63f',
        },
        'latest',
      ],
      {
        result:
          '0x0000000000000000000000000d59d0f7dcc0fbf0a3305ce0261863aaf7ab685c',
      }
    );
    nockInfura(
      'eth_call',
      [
        {
          to: PublicResolver.toLowerCase(),
          data:
            '0x59d1d43cb47a0edaf3c702800c923ca4c44a113d0d718cb1f42ecdce70c5fd05fa36a63f000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000066176617461720000000000000000000000000000000000000000000000000000',
        },
        'latest',
      ],
      {
        result:
          '0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000004368747470733a2f2f697066732e696f2f697066732f516d55536867666f5a5153484b3354517975546655707363385566654e6644384b77505576444255645a346e6d520000000000000000000000000000000000000000000000000000000000',
      }
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
