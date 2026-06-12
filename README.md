# ens-avatar

Avatar resolver library for Node.js, browsers, and edge runtimes (Cloudflare Workers etc.).

## Important Notes

- **Bring your own chain client.** `AvatarResolver` takes a `ChainClient` instead of a raw provider, so the core ships with **no ethers in the bundle**. Wrap your SDK with a one-line adapter:
  - ethers: `import { fromEthers } from '@ensdomains/ens-avatar/ethers'` → `new AvatarResolver(fromEthers(provider))`
  - viem: `import { fromViem } from '@ensdomains/ens-avatar/viem'` → `new AvatarResolver(fromViem(client))`
  - `ethers` and `viem` are **optional peer dependencies** — install only the one you use.
- **Version 1.0.4+** uses the native Fetch API for maximum compatibility across platforms including Cloudflare Workers and other edge runtimes.
- **Name resolution uses the ENS [Universal Resolver](https://docs.ens.domains/resolvers/universal/)**: the resolver address, owner address, and avatar/header record are fetched in a single CCIP-read-aware call, so offchain (gateway/L2) and ENSIP-10 wildcard names resolve out of the box. Override the contract via the adapter's `universalResolverAddress` option for non-default networks.

## Platform Support

This library works seamlessly across:
- ✅ **Node.js** 18+ (uses native fetch or http adapter)
- ✅ **Browsers** (all modern browsers)
- ✅ **Cloudflare Workers**
- ✅ **Other edge runtimes** that support standard Fetch API

## Getting started

### Prerequisites

- Have an ethers v6 provider or a viem public client ready.

And good to go! SVG sanitization is built in and runs identically in browsers, Node.js,
and edge runtimes (Cloudflare Workers) — no DOM polyfill (jsdom) required.

### Installation

```bash
# npm
npm i @ensdomains/ens-avatar
# yarn
yarn add @ensdomains/ens-avatar
```

### Usage

With ethers:

```js
import { JsonRpcProvider } from 'ethers';
import { AvatarResolver, utils as avtUtils } from '@ensdomains/ens-avatar';
import { fromEthers } from '@ensdomains/ens-avatar/ethers';

const provider = new JsonRpcProvider(/* ... */);
const resolver = new AvatarResolver(fromEthers(provider));

async function getAvatar() {
    const avatarURI = await resolver.getAvatar('tanrikulu.eth');
    // avatarURI = https://ipfs.io/ipfs/QmUShgfoZQSHK3TQyuTfUpsc8UfeNfD8KwPUvDBUdZ4nmR
}

async function getHeader() {
    const headerURI = await resolver.getHeader('tanrikulu.eth');
    // headerURI = https://ipfs.io/ipfs/QmRFnn6c9rj6NuHenFVyKXb6tuKxynAvGiw7yszQJ2EsjN
}

async function getAvatarMetadata() {
    const avatarMetadata = await resolver.getMetadata('tanrikulu.eth');
    // avatarMetadata = { image: ... , uri: ... , name: ... , description: ... }
    const headerMetadata = await resolver.getMetadata('tanrikulu.eth', 'header');
    // headerMetadata = { image: ... , uri: ... , name: ... , description: ... }
    const avatarURI = avtUtils.getImageURI({ metadata: avatarMetadata });
    // avatarURI = https://ipfs.io/ipfs/QmUShgfoZQSHK3TQyuTfUpsc8UfeNfD8KwPUvDBUdZ4nmR
}
```

With viem:

```js
import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import { AvatarResolver } from '@ensdomains/ens-avatar';
import { fromViem } from '@ensdomains/ens-avatar/viem';

const client = createPublicClient({ chain: mainnet, transport: http() });
const resolver = new AvatarResolver(fromViem(client));

const avatarURI = await resolver.getAvatar('tanrikulu.eth');
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

- A single, parser-based sanitizer ([sanitize-html](https://github.com/apostrophecms/sanitize-html) + [postcss](https://github.com/postcss/postcss)) runs **identically** in browsers, Node.js, and edge runtimes (Cloudflare Workers) — no DOM or jsdom required.
- Tags and attributes are restricted to a strict SVG allowlist (no `script`, `foreignObject`, event handlers, or external `href`/`use`/`image` targets).
- CSS in both `style` attributes and `<style>` blocks is filtered against a property allowlist; `url(...)` is permitted only for internal fragment references (`url(#id)`), so gradients/clips/masks keep working while external resource loading (tracking, exfiltration) is blocked.

Raster avatars (`png`, `jpeg`, `gif`, `webp`, …), whether served as `data:` URIs or remote URLs, are passed through after validation — they are inert as `<img>` sources and are not (and need not be) rewritten.

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
