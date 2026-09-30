/**
 * @jest-environment node
 */
// Node environment: axios uses its http adapter (as ens-metadata-service
// does), which enforces maxContentLength; the browser XHR adapter does not.
import { AbiCoder, Interface } from 'ethers';
import nock from 'nock';
import { AvatarResolver } from '../src';
import ERC721 from '../src/specs/erc721';
import ERC1155 from '../src/specs/erc1155';
import {
  MAX_METADATA_BYTES,
  MAX_METADATA_PROPERTIES,
  METADATA_CALL_GAS_LIMIT,
  assertMetadataSize,
  assertPlainMetadata,
} from '../src/utils';

const CONTRACT = '0x31385d3520bced94f77aae104b406994d8f2168c';
const OWNER = '0x5a384227b65fa093dec03ec34e111db80a040615';
const TOKEN_ID = '9421';

const iface = new Interface([
  'function tokenURI(uint256) view returns (string)',
  'function uri(uint256) view returns (string)',
  'function ownerOf(uint256) view returns (address)',
  'function balanceOf(address, uint256) view returns (uint256)',
]);
const coder = AbiCoder.defaultAbiCoder();

/**
 * A minimal ethers ContractRunner / provider: answers the NFT calls, and the
 * ENS lookups AvatarResolver makes, and records each call's gas limit.
 */
function stubProvider(tokenURI: string, record?: string) {
  const gasLimits: Array<bigint | undefined> = [];
  const provider = {
    provider: null as unknown,
    async call(tx: { data: string; gasLimit?: bigint }) {
      const { name } = iface.parseTransaction({ data: tx.data })!;
      if (name === 'tokenURI' || name === 'uri') {
        gasLimits.push(tx.gasLimit);
        return coder.encode(['string'], [tokenURI]);
      }
      if (name === 'ownerOf') return coder.encode(['address'], [OWNER]);
      return coder.encode(['uint256'], [1]);
    },
    async resolveName() {
      return OWNER;
    },
    async getResolver() {
      return { getText: async () => record ?? null };
    },
  };
  provider.provider = provider;
  return { provider, gasLimits };
}

const jsonDataURI = (json: string) => `data:application/json,${json}`;
const base64DataURI = (json: string) =>
  `data:application/json;base64,${Buffer.from(json).toString('base64')}`;

// A realistic on-chain metadata object: name, description, attributes and an
// inline base64 SVG image.
const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 350 350"><rect width="100%" height="100%" fill="black"/><text x="10" y="20" fill="white">Bag #1</text></svg>'
).toString('base64');
const ONCHAIN_METADATA = {
  name: 'Bag #1',
  description: 'Loot is randomized adventurer gear.',
  image: `data:image/svg+xml;base64,${SVG}`,
  attributes: [{ trait_type: 'Weapon', value: 'Katana' }],
};

const specs = [
  ['erc721', ERC721],
  ['erc1155', ERC1155],
] as const;

afterEach(() => nock.cleanAll());

// Harmless in node; kept so the mocks also work under jsdom (XHR + CORS).
const CORS = { 'access-control-allow-origin': '*' };

describe('metadata guards', () => {
  it('assertPlainMetadata accepts objects up to MAX_METADATA_PROPERTIES', () => {
    const ok = Object.fromEntries(
      Array.from({ length: MAX_METADATA_PROPERTIES }, (_, i) => [`k${i}`, i])
    );
    expect(() => assertPlainMetadata(ok)).not.toThrow();
    expect(() => assertPlainMetadata({ ...ok, extra: 1 })).toThrow(
      'NFT metadata exceeds the maximum number of properties'
    );
  });

  it.each([['"AAAA"'], ['[1,2]'], ['null'], ['42'], ['true']])(
    'assertPlainMetadata rejects %s',
    json => {
      expect(() => assertPlainMetadata(JSON.parse(json))).toThrow(
        'NFT metadata must be a JSON object'
      );
    }
  );

  it('assertMetadataSize counts UTF-8 bytes, not characters', () => {
    // 1 character, 3 bytes each: under the cap in characters, over in bytes
    const cjk = '中'.repeat(Math.floor(MAX_METADATA_BYTES / 3) + 1);
    expect(cjk.length).toBeLessThan(MAX_METADATA_BYTES);
    expect(() => assertMetadataSize(cjk)).toThrow(
      'NFT metadata exceeds maximum allowed size'
    );
    expect(() =>
      assertMetadataSize('a'.repeat(MAX_METADATA_BYTES))
    ).not.toThrow();
  });
});

describe.each(specs)('%s getMetadata', (_name, Spec) => {
  const run = (tokenURI: string, owner: string | null = OWNER) => {
    const { provider, gasLimits } = stubProvider(tokenURI);
    const result = new Spec().getMetadata(
      provider as never,
      owner,
      CONTRACT,
      TOKEN_ID
    );
    return { result, gasLimits };
  };

  describe('on-chain data: branch', () => {
    it('resolves realistic base64 metadata unchanged', async () => {
      const { result } = run(base64DataURI(JSON.stringify(ONCHAIN_METADATA)));
      expect(await result).toEqual({ ...ONCHAIN_METADATA, is_owner: true });
    });

    it('resolves plain (non-base64) JSON metadata', async () => {
      const { result } = run(jsonDataURI('{"name":"n","image":"x"}'));
      expect(await result).toEqual({ name: 'n', image: 'x', is_owner: true });
    });

    it.each([['"AAAA"'], ['[1,2,3]'], ['null'], ['42'], ['false']])(
      'rejects %s (not an object) instead of spreading it',
      async json => {
        await expect(run(jsonDataURI(json)).result).rejects.toThrow(
          'NFT metadata must be a JSON object'
        );
      }
    );

    it('rejects a string primitive in base64 form too', async () => {
      await expect(run(base64DataURI('"AAAA"')).result).rejects.toThrow(
        'NFT metadata must be a JSON object'
      );
    });

    it('rejects an object with too many properties', async () => {
      const big = Object.fromEntries(
        Array.from({ length: MAX_METADATA_PROPERTIES + 1 }, (_, i) => [
          `k${i}`,
          0,
        ])
      );
      await expect(
        run(jsonDataURI(JSON.stringify(big))).result
      ).rejects.toThrow(
        'NFT metadata exceeds the maximum number of properties'
      );
    });

    it('rejects metadata over MAX_METADATA_BYTES before parsing', async () => {
      const parse = jest.spyOn(JSON, 'parse');
      const json = `{"pad":"${'a'.repeat(MAX_METADATA_BYTES)}"}`;
      await expect(run(jsonDataURI(json)).result).rejects.toThrow(
        'NFT metadata exceeds maximum allowed size'
      );
      await expect(run(base64DataURI(json)).result).rejects.toThrow(
        'NFT metadata exceeds maximum allowed size'
      );
      // (ethers parses its ABI strings with JSON.parse; only the metadata matters)
      expect(
        parse.mock.calls.some(([text]) => String(text).startsWith('{"pad"'))
      ).toBe(false);
      parse.mockRestore();
    });

    it('keeps is_owner resolver-set', async () => {
      const { result } = run(
        jsonDataURI('{"image":"x","is_owner":true}'),
        null // no owner address, so not the owner
      );
      expect((await result).is_owner).toBe(false);
    });
  });

  describe('HTTP branch', () => {
    const META = new URL('https://meta.example/token');

    it('resolves a normal metadata object', async () => {
      nock(META.origin)
        .get(/.*/)
        .reply(200, { name: 'n', image: 'https://img.example/a.png' }, CORS);
      const { result } = run(META.toString());
      expect(await result).toEqual({
        name: 'n',
        image: 'https://img.example/a.png',
        is_owner: true,
      });
    });

    it.each([['"AAAA"'], ['[1,2,3]'], ['42'], ['not json at all']])(
      'rejects a %s response instead of spreading it',
      async body => {
        nock(META.origin)
          .get(/.*/)
          .reply(200, body, { ...CORS, 'content-type': 'application/json' });
        await expect(run(META.toString()).result).rejects.toThrow(
          'NFT metadata must be a JSON object'
        );
      }
    );

    it('honours maxContentLength', async () => {
      nock(META.origin)
        .get(/.*/)
        .reply(200, `{"pad":"${'a'.repeat(MAX_METADATA_BYTES)}"}`, {
          ...CORS,
          'content-type': 'application/json',
        });
      await expect(run(META.toString()).result).rejects.toThrow(
        /maxContentLength/
      );
    });
  });

  it(`calls the metadata function with gasLimit ${METADATA_CALL_GAS_LIMIT} by default`, async () => {
    const { result, gasLimits } = run(jsonDataURI('{"image":"x"}'));
    await result;
    expect(gasLimits).toEqual([BigInt(METADATA_CALL_GAS_LIMIT)]);
  });

  it('honours the metadataGasLimit option', async () => {
    const { provider, gasLimits } = stubProvider(jsonDataURI('{"image":"x"}'));
    await new Spec().getMetadata(provider as never, OWNER, CONTRACT, TOKEN_ID, {
      metadataGasLimit: 2_000_000,
    });
    expect(gasLimits).toEqual([BigInt(2_000_000)]);
  });
});

describe('AvatarResolver.getMetadata keeps resolver-set fields', () => {
  const NFT_RECORD = `eip155:1/erc721:${CONTRACT}/${TOKEN_ID}`;

  it('token metadata cannot override uri or host_meta', async () => {
    const { provider } = stubProvider(
      jsonDataURI(
        JSON.stringify({
          image: 'x',
          uri: 'spoofed.eth',
          host_meta: { contract_address: '0xspoofed' },
        })
      ),
      NFT_RECORD
    );
    const meta = await new AvatarResolver(provider as never).getMetadata(
      'nick.eth'
    );
    expect(meta.uri).toBe('nick.eth');
    expect(meta.host_meta.contract_address).toBe(CONTRACT);
    expect(Object.keys(meta).slice(0, 2)).toEqual(['uri', 'host_meta']);
  });

  it('an on-chain avatar record is returned as the image, not spread', async () => {
    const record = `data:image/svg+xml;base64,${SVG}`;
    const { provider } = stubProvider('', record);
    expect(
      await new AvatarResolver(provider as never).getMetadata('nick.eth')
    ).toEqual({ uri: 'nick.eth', image: record });
  });

  it('record JSON cannot claim is_owner or host_meta', async () => {
    const META = new URL('https://meta.example/record');
    nock(META.origin)
      .head(/.*/)
      .reply(200, '', { ...CORS, 'content-type': 'application/json' })
      .get(/.*/)
      .reply(
        200,
        {
          image: 'https://img.example/a.png',
          is_owner: true,
          host_meta: { contract_address: '0xspoofed' },
        },
        CORS
      );
    const { provider } = stubProvider('', META.toString());
    expect(
      await new AvatarResolver(provider as never).getMetadata('nick.eth')
    ).toEqual({ uri: 'nick.eth', image: 'https://img.example/a.png' });
  });

  it('record JSON must be an object', async () => {
    const META = new URL('https://meta.example/record');
    nock(META.origin)
      .head(/.*/)
      .reply(200, '', { ...CORS, 'content-type': 'application/json' })
      .get(/.*/)
      .reply(200, '"AAAA"', { ...CORS, 'content-type': 'application/json' });
    const { provider } = stubProvider('', META.toString());
    await expect(
      new AvatarResolver(provider as never).getMetadata('nick.eth')
    ).rejects.toThrow('NFT metadata must be a JSON object');
  });
});
