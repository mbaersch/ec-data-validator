# Enhanced Conversion Data Validator

A Chrome extension for inspecting and validating **Enhanced Conversions** data sent to Google Ads and Google Analytics 4 — both the `em` parameter in conversion / GA4 collect requests and the `user_data` objects pushed via GTM, gtag, or raw JSON.

Use it to verify that ec tracking is working and the data leaving the browser actually matches what you think they're sending.

## What it does

**Decode the `em` parameter** from a Google Ads conversion request:

- Paste the `em=…` string from the Network tab (or Tag Assistant)
- See each token broken out: email, phone, first/last name, address fields, etc.
- Detect the encoding automatically: **Hex** (manual `sha256_*` values) or **Base64URL** (auto-detection by the Google tag)
- Optionally enter plaintext below to verify hashes match — values are hashed in both encodings and the result is shown per token
- Compliance check: green when minimum requirements are met (Email *or* full address); grey/yellow warnings for incomplete data

<img width="607" height="901" alt="image" src="https://github.com/user-attachments/assets/a181bc47-d15c-41a1-a0d2-14d8b20817d0" />

**Inspect a `user_data` object**:

- Accepts `dataLayer.push({…})`, `gtag('event', '…', {…})`, raw JSON, or just the `{…}` itself
- JS-style syntax (unquoted keys, single quotes, dotted keys like `gtm.uniqueEventId`) is normalized automatically — paste directly from Tag Assistant if you want
- Verifies hashed fields the same way as the EM Decoder
- **Structure validation**: address fields (`first_name`, `country`, `postal_code`, …) outside of `user_data.address` trigger a structure-error warning — these don't reach Google as expected

<img width="597" height="868" alt="image" src="https://github.com/user-attachments/assets/697d1dee-38f5-45c9-9ccf-c16610c2c880" />

**Live network recording**:

- Capture Google Ads conversion requests **and** GA4 `/g/collect` requests in real time, listed as clickable cards
- **Tag Gateway and server-side GTM on first-party origins** are captured as well, as soon as you grant the respective origin via the **Permit** button — requests are recognized by typical path markers (`/ccm/`, `/pagead/`, `/g/collect`) or by the presence of an `em`/`eme`/`user_data` parameter, so normal page loads on the granted origin are ignored
- First-party captures get a soft orange background tint to distinguish them from direct-to-Google requests
- GA4 captures (whether direct or via sGTM on a first-party `/g/collect` endpoint) are visually distinguished by a left accent border (indigo); the optional `Show also Google Analytics requests with user data` checkbox toggles their visibility
- The encrypted **`eme`** parameter (Tag Gateway / Cloud-Edge encrypted) is recognized and flagged with its own yellow pill — the key lives at the Cloud Edge and cannot be decoded by the extension, but visible metadata (`tv`, `emkid`, `ev`) is shown in the decoder when you click such a capture
- **`user_data` from GA4/sGTM requests** is extracted from `ep.user_data.*` event parameters (URL or form-encoded) and from a top-level `user_data` object in JSON bodies — nested address fields (`ep.user_data.address.first_name` etc.) are reconstructed. Captures carrying only `user_data` (no `em`) are clickable too: the data lands in the Object Analysis tab for the same verification flow.
- Pills show which identifiers each request carries (em, pn, fn0, ln0, … `eme` when encrypted, or pills derived from `user_data` when that is the only source)
- Hover reveals full names; click loads the `em`/`eme` into the decoder, or the `user_data` object into Object Analysis
- The small `i` icon on each card opens a detail view with **all** query and body parameters of that request — useful for telemetry fields like `gcs`, `gcd`, `gtm`, `dma`, `tag_exp`
- Filter to show only requests carrying any user data (`em`, `eme`, or `user_data`) — default on, hides telemetry pings
- Export captures as JSON for documentation or analysis (each entry tagged `source: 'ads' | 'ga'` and `transport: 'google' | 'first-party'`, plus `eme` and `userData` when present)
- Permission requested per-site via the URL field — the extension only listens on origins you explicitly grant; the webRequest listener is re-registered automatically when permissions change, so newly granted origins are picked up without reloading the service worker
- Granted sites are listed in a collapsible **Permitted sites** block under the URL input; one click on `×` revokes a site (active recording is stopped first)
- Requests *initiated from* Google's own UIs (`analytics.google.com`, `ads.google.com`, `tagmanager.google.com`, `tagassistant.google.com`) are ignored — those are internal calls of those tools, not events from the site under test
- The URL field auto-fills from the active tab and updates on tab switch, unless you have focus inside it (so manual edits aren't overwritten)
- Optional **Stop recording when side panel closes** (default on): closing the side panel ends the recording; uncheck if you want capturing to continue in the background
- Optional **Include subdomains when permitting** (default off): broadens the Permit request to a wildcard for the base domain (e.g. `https://*.example.com/*` instead of `https://shop.example.com/*`). Useful for shops with multiple subdomains or a first-party sGTM on its own subdomain. Chrome shows a wider permission dialog when this is active — review carefully before granting

<img width="664" height="414" alt="image" src="https://github.com/user-attachments/assets/0f804a14-317b-4ced-821f-b71f971c3bbf" />

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

1. In the EM Decoder tab, the URL field at the top should show the active tab's origin (otherwise click ↻ to refresh from the active tab — the field also auto-updates on tab switch unless you are editing it)
2. Click **Permit** once — Chrome asks for site access for that origin; allow it. The same origin only needs to be permitted once; subsequent sessions skip the dialog.
3. Click **Start** to begin capturing. Standard Google endpoints (Ads, GA4) work without any extra permit; the Permit step is only needed for first-party / sGTM / Tag Gateway origins.
4. Trigger conversions / form submissions on the page being recorded
5. Captures appear as cards at the bottom of the panel
6. Click a card with `em` to load it into the decoder; click the `i` icon to inspect all query and body parameters of that request
7. **Export** copies the visible captures as JSON to clipboard
8. **Clear** removes them; **Stop** ends recording
9. To revoke site access, expand **Permitted sites** under the URL input and click `×` next to the entry

By default the recording stops when you close the Side Panel (toggle the option to keep capturing in the background). It is also stopped automatically when the browser restarts, so a forgotten recording never runs silently.

## Permissions

- `storage` — persist recording state and captures across SW lifecycle
- `sidePanel` — UI placement
- `webRequest` — observe Google Ads and GA4 requests (read-only, no blocking, no modification)
- `tabs` — read the active tab URL to pre-fill the recording URL field
- `host_permissions` (static): `googleadservices.com/{pagead,ccm}/*`, `www.google.com/{pagead,ccm}/*`, and the GA4 collect endpoints `*.google-analytics.com/g/collect*` and `*.analytics.google.com/g/collect*` — the **target** domains
- `optional_host_permissions: ["<all_urls>"]` — granted **per-site at runtime** when you click **Permit** for the **initiator** origin (the page where the conversion fires from). The extension never auto-requests permissions — every site grant requires an explicit user action.

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
revokeOrigin('https://example.com/*')         // also available via the Permitted sites UI
revokeAllOptionalOrigins()
lightTest()          // 30s diagnostic listener that logs every match
```

## Changelog

### v2.4

- **Recording UI overhauled**: `Permit` and `Start`/`Stop` are separate buttons now. The URL field is always editable and auto-updates when you switch tabs (unless you are typing in it).
- **Permit-button live status**: shows `Permitted ✓` when the origin in the URL field is already covered. `Start` refuses to run on a site that is not permitted, with a clear error.
- **Auto-stop on panel close** (default on): closing the side panel ends the recording. Uncheck the new option to keep capturing in the background.
- **Include-subdomains toggle** (default off): broadens the Permit request to `https://*.<base>/*`, so a single grant covers shop subdomains and a first-party sGTM on its own subdomain.
- **GA4 / sGTM `user_data` capture**: `ep.user_data.*` event parameters and top-level `user_data` JSON bodies are extracted and shown like an `em` payload. Click such a capture to load it into Object Analysis. Only fields with known identifiers (email/phone/address with or without `sha256_`) count — meta keys like `_tag_mode` are ignored.
- **`user_data` source pill** (grey): marks every capture that carries `user_data` event params, even when `em` is also present (typical Tag Gateway case). Click priority remains em → eme → user_data.
- **Initiator filter**: requests fired from Google's own UIs (`analytics.google.com`, `ads.google.com`, `tagmanager.google.com`, `tagassistant.google.com`) are ignored — they are internal calls, not events from the site under test.
- Filter labels renamed from `EM` to `user data` to match the broader scope.
- No new permissions: everything runs on the existing `webRequest` / `tabs` / `<all_urls>` (optional) declarations.

### v2.3

- **Tag Gateway / server-side GTM on first-party origins**: requests on granted origins are captured by path markers (`/ccm/`, `/pagead/`, `/g/collect`) or `em`/`eme` presence, so normal page loads are ignored.
- First-party captures get an orange tint to distinguish them from direct-to-Google requests.
- **Encrypted `eme` parameter** (Tag Gateway / Cloud-Edge) is recognized, flagged with its own yellow pill, and shows visible metadata (`tv`, `emkid`, `ev`) in the decoder.
- GA4 captures get an indigo accent border; new filter `Show also Google Analytics requests with EM` toggles them.
- Updated GA-filter tooltip.

## License

MIT (see LICENSE).

## Author

Markus Baersch — <https://www.markus-baersch.de>
