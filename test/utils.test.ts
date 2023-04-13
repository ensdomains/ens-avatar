import { CID } from 'multiformats/cid';
import {
  assert,
  BaseError,
  isCID,
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
