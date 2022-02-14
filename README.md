# ens-avatar-resolver

Avatar resolution library for both nodejs and browser.

## Getting started

Install the library, import into your project and good to go!

### Installation

```bash
# npm
npm i @ensdomains/avatar-resolver
# yarn
yarn add @ensdomains/avatar-resolver
```

### Usage

```js
import { StaticJsonRpcProvider } from '@ethersproject/providers';
import { AvatarResolver, utils: avtUtils } from '@ensdomains/avatar-resolver';

const provider = new StaticJsonRpcProvider(
    ...
  );
...
async function getAvatar() {
    const avt = new AvatarResolver(provider);
    const avatarURI = await avt.getAvatar({ ens: 'tanrikulu.eth' });
    // avatarURI = https://ipfs.io/ipfs/QmUShgfoZQSHK3TQyuTfUpsc8UfeNfD8KwPUvDBUdZ4nmR
}

async function getAvatarMetadata() {
    const avt = new AvatarResolver(provider);
    const avatarMetadata = await avt.getMetadata({ ens: 'tanrikulu.eth' });
    // avatarMetadata = { image: ... , uri: ... , name: ... , description: ... }
    const avatarURI = avtUtils.getImageURI(metadata);
    // avatarURI = https://ipfs.io/ipfs/QmUShgfoZQSHK3TQyuTfUpsc8UfeNfD8KwPUvDBUdZ4nmR
}
```

## Supported avatar specs

### NFTs
- ERC721
- ERC1155

### URIs
- HTTP
- Base64
- IPFS

## Options

### Cache _(Default: Disabled)_
```js
const avt = new AvatarResolver(provider, { ttl: 300 }); // 5 min response cache in memory
```

### Custom IPFS Gateway _(Default: https://ipfs.io)_
```js
const avt = new AvatarResolver(provider, { ipfs: 'https://dweb.link' });
```

## Demo
- Create .env file with INFURA_KEY env variable
- Build the library

- Node example
```bash
node example/node.js ENS_NAME
```

- Browser example
```bash
yarn build:demo
http-server example
```
