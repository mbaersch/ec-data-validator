# Enhanced Conversion Data Validator

A Chrome extension for inspecting and validating Google Ads **Enhanced Conversions** data — both the `em` parameter sent in conversion requests and the `user_data` objects pushed via GTM, gtag, or raw JSON.

Built for marketers, analysts, and engineers who need to verify that the data leaving the browser actually matches what they think they're sending.

## What it does

**Decode the `em` parameter** from a Google Ads conversion request:

- Paste the `em=…` string from the Network tab (or Tag Assistant)
- See each token broken out: email, phone, first/last name, address fields, etc.
- Detect the encoding automatically: **Hex** (manual `sha256_*` values) or **Base64URL** (auto-detection by the Google tag)
- Optionally enter plaintext below to verify hashes match — values are hashed in both encodings and the result is shown per token
- Compliance check: green when minimum requirements are met (Email *or* full address); grey/yellow warnings for incomplete data

**Inspect a `user_data` object**:

- Accepts `dataLayer.push({…})`, `gtag('event', '…', {…})`, raw JSON, or just the `{…}` itself
- JS-style syntax (unquoted keys, single quotes, dotted keys like `gtm.uniqueEventId`) is normalized automatically — paste directly from Tag Assistant if you want
- Verifies hashed fields the same way as the EM Decoder
- **Structure validation**: address fields (`first_name`, `country`, `postal_code`, …) outside of `user_data.address` trigger a structure-error warning — these don't reach Google as expected

**Live network recording**:

- Capture Google Ads conversion requests in real time, listed as clickable cards
- Pills show which identifiers each request carries (em, pn, fn0, ln0, …)
- Hover reveals full names; click loads the `em` into the decoder
- Filter to show only requests with `em` payload (default on, hides telemetry pings)
- Export captures as JSON for documentation or analysis
- Permission requested per-site via the URL field — the extension only listens on origins you explicitly grant

## Install

Manifest V3 unpacked extension. Requires Chrome 114+ (Side Panel API).

1. Clone or download this repository
2. Open `chrome://extensions/`
3. Enable "Developer mode" (top right)
4. Click "Load unpacked" and select the project folder
5. Pin the extension if you want it in the toolbar

The extension icon opens a Side Panel — not a popup. The panel persists across tab switches.

## Use

### Decoding an `em` parameter

1. Open the Side Panel (click the extension icon)
2. Switch to the **EM Decoder** tab
3. Paste the `em=…` value from Network tab or Tag Assistant
4. Tokens are decoded into a table with encoding pills
5. (Optional) Fill in the verify fields below the table with plaintext — the extension hashes and matches against each token

### Inspecting a dataLayer/gtag object

1. Switch to the **Object Analysis** tab
2. Paste the call (or just the object). JS-syntax is fine.
3. The compliance pill, structure check, and field table render immediately

### Recording network traffic

1. In the EM Decoder tab, the URL field at the top should show the active tab's origin (otherwise click ↻ to refresh from the active tab)
2. Click **Permit & Record** — Chrome asks for site access for that origin; allow it
3. Trigger conversions / form submissions on the page being recorded
4. Captures appear as cards below the EM input
5. Click a card with `em` to load it into the decoder
6. **Export** copies the visible captures as JSON to clipboard
7. **Clear** removes them; **Stop** ends recording

The recording continues in the background even when the Side Panel is closed. It is automatically stopped when the browser restarts (so a forgotten recording doesn't run silently).

## Permissions

- `storage` — persist recording state and captures across SW lifecycle
- `sidePanel` — UI placement
- `webRequest` — observe Google Ads requests (read-only, no blocking, no modification)
- `tabs` — read the active tab URL to pre-fill the recording URL field
- `host_permissions` (static): `googleadservices.com/{pagead,ccm}/*` and `www.google.com/{pagead,ccm}/*` — the **target** domains
- `optional_host_permissions: ["<all_urls>"]` — granted **per-site at runtime** when you click "Permit & Record" for the **initiator** origin (the page where the conversion fires from). The extension never auto-requests permissions — every site grant requires an explicit user action.

The extension does not transmit anything anywhere. All processing is local.

## Development

The codebase is small and unbundled — no build step. Edit, reload the extension, test.

- `manifest.json` — MV3 config
- `background.js` — service worker, handles recording and the message API
- `popup.html` / `popup.js` — Side Panel UI

For diagnostic helpers in the service worker console (`chrome://extensions/` → click "Service worker"):

```js
checkSetup()         // permissions, listener state, capture count
recordingStatus()    // current recording flag and ringbuffer size
getCaptures()        // console.table of current captures
listOrigins()        // all granted origins (static + optional)
revokeOrigin('https://example.com/*')
revokeAllOptionalOrigins()
lightTest()          // 30s diagnostic listener that logs every match
```

## License

MIT (see LICENSE).

## Author

Markus Baersch — <https://www.markus-baersch.de>
