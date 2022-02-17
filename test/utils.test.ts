import { CID } from 'multiformats/cid';
import { isCID, resolveURI } from '../src/utils';

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

  const httpOrDataCases = [
    'https://i.imgur.com/yed5Zfk.gif',
    'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==',
    'http://i.imgur.com/yed5Zfk.gif',
  ];

  it('resolve different ipfs uri cases', async () => {
    for (let uri of ipfsCases) {
      const { uri: resolvedURI } = resolveURI(uri);
      expect(resolvedURI).toMatch(/^https:\/\/ipfs.io\/?/);
    }
  });

  it('resolve http and base64 cases', async () => {
    for (let uri of httpOrDataCases) {
      const { uri: resolvedURI } = resolveURI(uri);
      expect(resolvedURI).toMatch(/^(http(?:s)?:\/\/|data:).*$/);
    }
  });

  // we may want to raise an error for
  // any other protocol than http, ipfs, data
  it('resolve ftp as it is', async () => {
    const uri = 'ftp://user:password@host:port/path';
    const { uri: resolvedURI } = resolveURI(uri);
    expect(resolvedURI).toMatch(/^(ftp:\/\/).*$/);
  });

  it('check if given hash is CID', async () => {
    expect(
      isCID('QmZHKZDavkvNfA9gSAg7HALv8jF7BJaKjUc9U2LSuvUySB')
    ).toBeTruthy();
  });

  it('check if given hash is CID', async () => {
    const cid = CID.parse('QmZHKZDavkvNfA9gSAg7HALv8jF7BJaKjUc9U2LSuvUySB');
    expect(isCID(cid)).toBeTruthy();
  });

  it('fail if given hash is not CID', async () => {
    const cid = { something: 'unrelated' };
    expect(isCID(cid)).toBeFalsy();
  });
});
