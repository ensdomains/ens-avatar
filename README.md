# ens-avatar

Avatar resolver library for both nodejs and browser.

## Note!: ENS-Avatar >= 1.0.0 is only compatible with ethers v6. If your project is using v5, keep your ens-avatar on latest 0.x version.

## Getting started

### Prerequisites

- Have your web3 provider ready (web3.js, ethers.js)
- [Only for node env] Have jsdom installed.

And good to go!

### Installation

```bash
# npm
npm i @ensdomains/ens-avatar
# yarn
yarn add @ensdomains/ens-avatar
```

### Usage

```js
import { StaticJsonRpcProvider } from '@ethersproject/providers';
import { AvatarResolver, utils as avtUtils } from '@ensdomains/ens-avatar';

// const { JSDOM } = require('jsdom'); on nodejs
// const jsdom = new JSDOM().window; on nodejs

const provider = new StaticJsonRpcProvider(
    ...
  );
...
async function getAvatar() {
    const resolver = new AvatarResolver(provider);
    const avatarURI = await resolver.getAvatar('tanrikulu.eth', { /* jsdomWindow: jsdom (on nodejs) */ });
    // avatarURI = https://ipfs.io/ipfs/QmUShgfoZQSHK3TQyuTfUpsc8UfeNfD8KwPUvDBUdZ4nmR
}

async function getHeader() {
    const resolver = new AvatarResolver(provider);
    const headerURI = await resolver.getHeader('tanrikulu.eth', { /* jsdomWindow: jsdom (on nodejs) */ });
    // headerURI = https://ipfs.io/ipfs/QmRFnn6c9rj6NuHenFVyKXb6tuKxynAvGiw7yszQJ2EsjN
}

async function getAvatarMetadata() {
    const resolver = new AvatarResolver(provider);
    const avatarMetadata = await resolver.getMetadata('tanrikulu.eth');
    // avatarMetadata = { image: ... , uri: ... , name: ... , description: ... }
    const headerMetadata = await resolver.getMetadata('tanrikulu.eth', 'header');
    // headerMetadata = { image: ... , uri: ... , name: ... , description: ... }
    const avatarURI = avtUtils.getImageURI({ metadata: avatarMetadata /*, jsdomWindow: jsdom (on nodejs) */ });
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
const avt = new AvatarResolver(provider, { cache: 300 }); // 5 min response cache in memory
```

### Custom IPFS Gateway _(Default: https://ipfs.io)_

```js
const avt = new AvatarResolver(provider, { ipfs: 'https://dweb.link' });
```

### Custom Arweave Gateway _(Default: https://arweave.net)_

```js
const avt = new AvatarResolver(provider, { arweave: 'https://arweave.net' });
```

### Marketplace Api Keys _(Default: {})_

```js
const avt = new AvatarResolver(provider, {
  apiKey: {
    opensea: 'YOUR_API_KEY',
  },
});
```

### URL DenyList _(Default: [])_

```js
const avt = new AvatarResolver(provider, {
  urlDenyList: ['https://maliciouswebsite.com'],
});
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
