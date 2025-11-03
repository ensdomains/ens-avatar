# ens-avatar

Avatar resolver library for Node.js, browsers, and edge runtimes (Cloudflare Workers etc.).

## Important Notes

- **ENS-Avatar >= 1.0.0** is only compatible with ethers v6. If your project is using v5, keep your ens-avatar on latest 0.x version.
- **Version 1.0.4+** uses the native Fetch API for maximum compatibility across platforms including Cloudflare Workers and other edge runtimes.

## Platform Support

This library works seamlessly across:
- ✅ **Node.js** 18+ (uses native fetch or http adapter)
- ✅ **Browsers** (all modern browsers)
- ✅ **Cloudflare Workers**
- ✅ **Other edge runtimes** that support standard Fetch API

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

### Custom Agents (Node.js only)

You can provide custom HTTP/HTTPS agents for advanced use cases:

```js
import http from 'http';
import https from 'https';

const avt = new AvatarResolver(provider, {
  agents: {
    httpAgent: new http.Agent({ keepAlive: true }),
    httpsAgent: new https.Agent({ keepAlive: true }),
  },
});
```

**⚠️ SECURITY WARNING**: When you provide custom agents, ens-avatar will use them as-is **without applying SSRF protection**. You are responsible for ensuring your custom agents have appropriate security measures to prevent Server-Side Request Forgery attacks.

If you need SSRF protection with custom agents, wrap them with `ssrf-req-filter`:

```js
import http from 'http';
import https from 'https';
const { requestFilterHandler } = require('ssrf-req-filter');

const avt = new AvatarResolver(provider, {
  agents: {
    httpAgent: requestFilterHandler(new http.Agent({ keepAlive: true })),
    httpsAgent: requestFilterHandler(new https.Agent({ keepAlive: true })),
  },
});
```

### Allow Private IPs _(Default: false)_ - **Development Only**

For local development when you need to access localhost or private network services:

```js
const avt = new AvatarResolver(provider, {
  allowPrivateIPs: true, // Allows localhost, 127.0.0.1, 10.x.x.x, 192.168.x.x, etc.
});
```

**⚠️ WARNING**: This disables SSRF protection. Only use for local development (e.g., local IPFS nodes, test servers). **NEVER enable this in production**.

Common local development scenarios:
- Local IPFS node: `http://127.0.0.1:5001`
- Local Ethereum node: `http://localhost:8545`
- Docker containers on private networks

**Note**: This flag is ignored if you provide custom agents (you control security in that case).

## Security

### XSS Protection

All user-generated SVG content is automatically sanitized to prevent XSS attacks:

- **Browser/Node.js**: Uses [DOMPurify](https://github.com/cure53/DOMPurify) (8.74 KB, battle-tested)
- **Cloudflare Workers**: Uses [sanitize-html](https://github.com/apostrophecms/sanitize-html) (parser-based, no DOM dependency)

Both sanitizers are production-ready, actively maintained, and specifically configured for secure SVG handling.

### SSRF Protection

**By default**, ens-avatar includes built-in protection against Server-Side Request Forgery (SSRF) attacks in Node.js environments. This prevents malicious actors from using avatar URLs to probe internal networks.

**Default behavior** (recommended for production):
- ✅ Blocks requests to `localhost`, `127.0.0.1`
- ✅ Blocks private IP ranges: `10.x.x.x`, `192.168.x.x`, `172.16.x.x-172.31.x.x`
- ✅ Blocks link-local and other internal addresses

**Custom agents**: If you provide your own HTTP/HTTPS agents, ens-avatar will use them as-is without applying SSRF protection. You are responsible for securing your custom agents.

**Local development**: Set `allowPrivateIPs: true` to disable SSRF protection when you need to access local services (e.g., local IPFS nodes). Never use this in production.

See the [Custom Agents](#custom-agents-nodejs-only) section for more details.

---

> **⚠️ SECURITY DISCLAIMER**
>
> While ens-avatar implements security measures to help protect against XSS and SSRF attacks, **you are ultimately responsible for the security of your application**. We strongly recommend:
>
> - Conducting your own security audits before deploying to production
> - Implementing additional security layers appropriate for your use case
> - Keeping the library updated to receive security patches
> - Following security best practices when handling user-generated content
> - Properly configuring all security-related options for your environment
>
> This library is provided "as-is" without warranty. The maintainers are not liable for any security vulnerabilities in applications using this library.

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
