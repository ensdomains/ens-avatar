# Security

## Overview

ENS Avatar library handles user-generated content (ENS avatar images and metadata) which may include malicious SVG files. This document describes our security measures and best practices.

## Threat Model

### Primary Threats

1. **XSS via SVG**: Malicious users could set SVG avatars containing `<script>` tags, event handlers, `javascript:` URLs, or other XSS vectors
2. **XSS via xlink:href**: SVG elements (`<use>`, `<image>`) with `xlink:href="javascript:..."` attributes
3. **SSRF (Server-Side Request Forgery)**: Malicious URIs pointing to internal networks, localhost, or cloud metadata endpoints
4. **Phishing via Meta Refresh**: SVG with `<meta http-equiv="refresh">` to redirect users to phishing sites
5. **Clickjacking**: SVG with embedded `<iframe>` or `<a>` tags linking to malicious sites
6. **Data Exfiltration**: SVG with external resource loading to malicious URLs

### Attack Surface

- Avatars and headers in ENS domains can point to any URI (IPFS, HTTP, data URIs)
- SVG can be base64-encoded or raw
- Metadata is fetched from untrusted sources (NFT contracts, IPFS, HTTP)

## Security Measures

### 1. Automatic SVG Sanitization

All SVG content is sanitized before being returned to users. The library uses **platform-specific sanitizers**:

#### DOMPurify (Browser/Node.js)

**Used in**: Browsers and Node.js environments with JSDOM

**Security Features**:

- Developed by Cure53 security experts
- Removes all JavaScript execution vectors:
  - `<script>` tags
  - Event handlers (`onclick`, `onerror`, etc.)
  - `javascript:` URLs in href and xlink:href
  - `data:text/html` URLs (can contain scripts)
  - `vbscript:` URLs
  - Data exfiltration vectors
- Custom hooks:
  - Remove meta refresh tags (phishing prevention)
  - Block dangerous protocols in `href` and `xlink:href` attributes
- Forbidden deprecated `xlink:href` attribute (modern SVG uses `href`)
- SVG-specific profiles for proper element/attribute filtering
- Actively maintained with rapid CVE response

**Forbidden Tags**:

```javascript
['a', 'area', 'base', 'iframe', 'link', 'script'];
```

**Forbidden Attributes**:

```javascript
['xlink:href']; // Deprecated and XSS vector
```

**Configuration**:

```javascript
DOMPurify.addHook('uponSanitizeAttribute', (node, data) => {
  // Block javascript:, data:text/html, vbscript: URLs
  if (data.attrName === 'xlink:href' || data.attrName === 'href') {
    const normalized = data.attrValue?.toLowerCase().trim();
    if (
      normalized?.startsWith('javascript:') ||
      normalized?.startsWith('data:text/html') ||
      normalized?.startsWith('vbscript:')
    ) {
      data.keepAttr = false;
      node.removeAttribute(data.attrName);
    }
  }
});

DOMPurify.sanitize(svg, {
  USE_PROFILES: { svg: true, svgFilters: true },
  FORBID_TAGS: ['a', 'area', 'base', 'iframe', 'link', 'script'],
  FORBID_ATTR: ['xlink:href'],
});
```

#### sanitize-html (Cloudflare Workers)

**Used in**: Cloudflare Workers and edge runtimes without DOM APIs

**Security Features**:

- Parser-based (no DOM dependency, works in V8 isolates)
- Comprehensive SVG element whitelist (50+ allowed tags)
- Strict attribute filtering per element type
- **xlink:href removed** from allowed attributes (deprecated, XSS vector)
- Protocol restrictions (only `http`, `https`, `data`)
- **Transform hooks** to strip dangerous protocols from `href` attributes
- Case-sensitive parsing (prevents mutation XSS)

**Allowed Protocols**:

```javascript
allowedSchemes: ['http', 'https', 'data'];
allowedSchemesByTag: {
  image: ['http', 'https', 'data'],
  use: ['http', 'https'], // No javascript: or vbscript:
  textPath: ['http', 'https'],
};
```

**Key Configuration**:

```javascript
{
  parser: {
    lowerCaseTags: false,  // Preserve SVG case (security critical)
    lowerCaseAttributeNames: false,
  },
  allowIframeRelativeUrls: false,  // Block iframe injection
  transformTags: {
    // Strip dangerous protocols from href attributes
    use: (tagName, attribs) => {
      if (attribs.href?.toLowerCase().startsWith('javascript:')) {
        delete attribs.href;
      }
      return { tagName, attribs };
    },
    image: /* same protection */
  }
}
```

### 2. SSRF Protection (Node.js Only)

**Default Protection**: The library includes built-in Server-Side Request Forgery (SSRF) protection for **Node.js server environments** using the `ssrf-req-filter` package.

> **Note**: SSRF is a server-side vulnerability. Browsers are not affected as they run in the user's context and have built-in protections (CORS, Same-Origin Policy). This protection only applies when using the library in Node.js servers, not in browser environments.

**Blocked by Default**:

- localhost (127.0.0.1, ::1, localhost)
- Private IPv4 ranges (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16)
- Link-local addresses (169.254.0.0/16)
- Cloud metadata endpoints (AWS, GCP, Azure)
- IPv6 private ranges (fc00::/7)

**Attack Scenarios Prevented**:

- ✅ AWS metadata: `http://169.254.169.254/latest/meta-data/iam/security-credentials/`
- ✅ Internal network scanning: `http://192.168.1.1/admin`
- ✅ Localhost services: `http://localhost:6379/` (Redis)
- ✅ Docker networks: `http://172.17.0.1/`

**Configuration**:

SSRF protection is **enabled by default** with no configuration required:

```javascript
// Default - SSRF protection enabled
const resolver = new AvatarResolver(provider);
```

For **local development only** (testing with local IPFS nodes, etc.):

```javascript
// ⚠️ WARNING: Only for development, NEVER in production
const resolver = new AvatarResolver(provider, {
  allowPrivateIPs: true, // Disables SSRF protection
});
```

For **custom agents** (you control security):

```javascript
import http from 'http';
import https from 'https';
const { requestFilterHandler } = require('ssrf-req-filter');

const resolver = new AvatarResolver(provider, {
  agents: {
    // Your custom agents with SSRF protection
    httpAgent: requestFilterHandler(new http.Agent()),
    httpsAgent: requestFilterHandler(new https.Agent()),
  },
});
```

**Note**: When you provide custom agents, the library uses them as-is without applying additional SSRF protection. You are responsible for securing your custom agents.

### 3. URL Deny List

Users can configure a deny list to block specific domains:

```javascript
const resolver = new AvatarResolver(provider, {
  urlDenyList: ['malicious-site.com'],
});
```

### 4. Content-Type Validation

The library validates that image URLs return proper MIME types:

```javascript
ALLOWED_IMAGE_MIMETYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/svg+xml',
  'image/gif',
  'image/webp',
];
```

### 5. Size Limits

Maximum file size enforced: **300 MB** (prevents DoS via large files)

### 6. HTTPS Enforcement

HTTP URLs are automatically upgraded to HTTPS where possible.

## Vulnerability Disclosure

If you discover a security vulnerability in this library, please report it to:

**Email**: bugs@ens.domains

Please include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if available)

## Best Practices for Users

### 1. Keep Dependencies Updated

```bash
yarn upgrade @ensdomains/ens-avatar
```

Check for security updates regularly using:

```bash
yarn audit
npm audit
```

### 2. Configure URL Deny Lists

If you're aware of malicious domains, block them:

```javascript
const resolver = new AvatarResolver(provider, {
  urlDenyList: ['known-phishing-site.com', 'malware-host.io'],
});
```

### 3. Content Security Policy (CSP)

When displaying avatars in browsers, use strict CSP headers:

```http
Content-Security-Policy:
  default-src 'self';
  img-src 'self' https: data:;
  script-src 'none';
```

### 4. Subresource Integrity (SRI)

If loading this library from a CDN, use SRI hashes:

```html
<script
  src="https://cdn.example.com/ens-avatar.js"
  integrity="sha384-..."
  crossorigin="anonymous"
></script>
```

### 5. Sandbox Iframe for Untrusted Content

If displaying avatars in highly sensitive contexts, render in sandboxed iframe:

```html
<iframe sandbox="allow-scripts" src="avatar-renderer.html"> </iframe>
```

## Security Testing

### Automated Tests

The library includes security-focused tests:

```bash
yarn test
```

Key test cases:

- ✅ Meta refresh tag removal
- ✅ Script tag stripping
- ✅ Event handler removal
- ✅ `javascript:` URL blocking in href/xlink:href
- ✅ `xlink:href` attribute removal (DOMPurify)
- ✅ SSRF protection (blocks private IPs)
- ✅ Malformed SVG handling
- ✅ Protocol validation

### Manual Security Review

Before releases, we perform:

1. **Dependency audit**: `yarn audit`
2. **Static analysis**: TypeScript strict mode
3. **Sanitizer configuration review**: Verify whitelists/blacklists
4. **Test coverage**: Ensure all XSS vectors are tested

### OWASP Guidelines

This library follows OWASP recommendations:

- ✅ [OWASP XSS Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html)
- ✅ [OWASP SVG Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/SVG_Security_Cheat_Sheet.html)

### Standards

- **DOM Purification**: Uses DOMPurify (recommended by OWASP)
- **Input Validation**: Strict MIME type and protocol checking
- **Output Encoding**: Base64 encoding for sanitized SVG

## Limitations

### What This Library Does NOT Protect Against

1. **DNS hijacking**: If IPFS/HTTP gateways are compromised, malicious content could be served
2. **Social engineering**: Users may still be tricked by misleading (but safe) images
3. **Browser vulnerabilities**: Zero-day browser bugs could bypass sanitization

### Security Disclaimer

While ens-avatar implements multiple layers of security protection, **you are ultimately responsible for the security of your application**. We strongly recommend:

- Conducting your own security audits before deploying to production
- Implementing additional security layers appropriate for your use case
- Keeping the library updated to receive security patches
- Following security best practices when handling user-generated content
- Properly configuring all security-related options for your environment

This library is provided "as-is" without warranty. The maintainers are not liable for any security vulnerabilities in applications using this library.
