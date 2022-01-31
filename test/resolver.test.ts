import { StaticJsonRpcProvider } from '@ethersproject/providers';
import { AvatarResolver } from '../src';

describe('get avatar', () => {
  const provider = new StaticJsonRpcProvider(
    'https://mainnet.infura.io/v3/372375d582d843c48a4eaee6aa5c1b3a'
  );
  const avt = new AvatarResolver(provider);
  it('retrieves image uri with erc1155 spec', async () => {
    expect(await avt.getAvatar({ ens: 'nick.eth' })).toEqual(
      'https://lh3.googleusercontent.com/hKHZTZSTmcznonu8I6xcVZio1IF76fq0XmcxnvUykC-FGuVJ75UPdLDlKJsfgVXH9wOSmkyHw0C39VAYtsGyxT7WNybjQ6s3fM3macE'
    );
  });
  it('retrieves image uri with erc721 spec', async () => {
    expect(await avt.getAvatar({ ens: 'brantly.eth' })).toEqual(
      'https://api.wrappedpunks.com/images/punks/2430.png'
    );
  });
  it('retrieves image uri with custom spec', async () => {
    expect(await avt.getAvatar({ ens: 'tanrikulu.eth' })).toEqual(
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
