# Changelog

## 2.0.0-alpha.4 (2026-10-05)

SVG sanitizer: no external loads anywhere, real-world editor output kept intact, and a document-level export.

### Added

- **`utils.sanitizeSVGDocument(svg, { maxLength }): string | null`** — `sanitizeSVG` plus root-only extraction: returns a standalone `<svg …>…</svg>` document (or `null`), with whitespace kept as is.
- Fidelity: `xlink:href` is renamed to `href` (an existing `href` wins); `href` allowed on gradients, `pattern` and `filter`; every presentation attribute and `xml:space` allowed on every element; `feDropShadow` and the full `fe*` attribute set; `spreadMethod`/`fr` on gradients, `viewBox`/`preserveAspectRatio`/`patternContentUnits` on `pattern`, `textLength`/`lengthAdjust`/`rotate` on text; a single CDATA section around `<style>` CSS is unwrapped (Illustrator).

### Security / behaviour changes

- **`url()` is internal-only everywhere**: attribute values (`fill`, `stroke`, `filter`, `mask`, `clip-path`, `marker-*`, …) are now checked like CSS, so `url(https://…)` (also when written with character references) is dropped.
- **CSS functions are allowlisted** (colors, math, transforms, filter functions, basic shapes, timing functions) instead of blocking known-bad tokens; `src()`, `var()`, `env()`, `attr()`, `paint()`, `image-set()`, … are dropped. Bare parentheses (`@media (…)`) are unaffected.
- **Every `<svg>` is pinned to the SVG namespace** (`xmlns` added when missing; other `xmlns*` declarations removed).
- The output safety net also rejects any `url(` that does not target `#…`.
- CSS checks are case- and escape-proof: escapes are decoded the way browsers decode them and the result lowercased, so `\55 \52 \4c (…)` is recognised as `url(`. `<STYLE>`/`<Script>` (any case) are dropped together with their content.
- **Malformed SVGs are rejected before parsing**: a `<` that doesn't start markup (e.g. `a < b` in text) makes `sanitizeSVG` return `''` and `sanitizeSVGDocument` / `getImageURI` return `null`. Such a file isn't valid XML, and it was the slowest input to sanitize.
- **`getImageURI` no longer collapses whitespace** in inline SVGs (it joined adjacent `<tspan>`s); output keeps the original whitespace.

## 2.0.0-alpha.3 (2026-09-25)

Security hardening. Most changes are invisible to callers; the ones below can change results or throw where the previous release did not.

### Breaking / behaviour changes

- **Node.js 22+** (`engines.node`); Node 20 is end-of-life.
- **viem 2.35+** (peer dependency): the adapter relies on Universal Resolver v3 errors.
- **ethers 6.13+** (peer dependency): earlier 6.x releases never time out a hung request, so an RPC outage could make `getAvatar` hang instead of throwing.
- **Limits** (all configurable on `AvatarResolver`):
  - `maxContentLength` — fetched and inline (`data:`) metadata, and raster `data:` images: **1 MiB**.
  - `maxRedirects` — **5** per request (was 10).
  - `maxSvgLength` — inline / `data:` SVGs: **256 KiB**. SVGs nested deeper than 256 elements or with more than 64 `<style>` elements are dropped, as are `<style>` blocks over 32 KiB of raw CSS or 2000 CSS nodes, and CSS beyond 128 KiB parsed or 64 KiB kept per SVG.
  - `timeout` now covers the whole request, body included.
- **Option validation:** invalid limits (`NaN`, `Infinity`, negatives, non-integers), a non-boolean `allowPrivateIPs`, a non-array `urlDenyList` or a non-http(s) gateway now **throw** when the resolver is created. `null` and `''` still mean "unset".
- **SSRF:** only globally routable unicast addresses are fetched (multicast, reserved, documentation, 6to4, Teredo, … are blocked); only `http:`/`https:` URLs; hostnames are compared case- and trailing-dot-insensitively, and deny-list entries are canonicalized (IDN, IP text forms, IPv4-mapped/NAT64).
- **Chain adapters throw on outages** (RPC errors, CCIP gateway failures other than 404/410) instead of resolving to `null`. A missing resolver, record or profile, a resolver that reverts, and a gateway 404/410 still resolve to `null` — the same in the ethers and viem adapters.
- Gateway options (`ipfs`, `arweave`) must be plain http(s) base URLs: no query, fragment or credentials.
- **`ChainMismatch`** is thrown for an NFT avatar on a chain other than the client's.
- **`getAvatar` / `getHeader` content-check every remote URL they return**, including images named in metadata JSON (one extra request).
- **Returned URLs are normalized** (`URL#href`, e.g. `http://a.example` → `http://a.example/`).
- **JSON avatar records** (`data:application/json…`) are parsed as metadata; metadata must be a JSON object, and record JSON can no longer set `is_owner`, `host_meta` or `uri`.
- **`urlDenyList` takes hostnames**, not URLs.
- `utils.assert` throws `BaseError` instead of a string.
- `url-join` is no longer a dependency; `htmlparser2` is a direct one.
