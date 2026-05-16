# Enhanced Conversion Data Validator

A Chrome extension for inspecting and validating **Enhanced Conversions** data sent to Google Ads and Google Analytics 4 — both the `em` parameter in conversion / GA4 collect requests and the `user_data` objects pushed via GTM, gtag, or raw JSON.

Use it to verify that ec tracking is working and the data leaving the browser actually matches what you think they're sending.

**Install from the Chrome Web Store:** <https://chromewebstore.google.com/detail/enhanced-conversion-data/oofghodijgflljjckgomndgkobnahhcp>

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
- **Conversion summary line** under the identifier pills on each card: event type (`purchase`, …), value + currency, item count (tooltip shows SKU × quantity @ price), new-customer flag, customer lifetime value, shipping cost + destination, order ID — drawn from Google Ads conversion parameters and GA4 commerce params. Fields are shown only when the request actually carries them
- **Consent state surfaced inline**: a red `no ad_storage` pill (or orange `ad_storage unset`) is added to the card whenever Consent Mode reports that `ad_storage` was not granted at request time — usually the most common reason expected user-data is missing
- The small `i` icon on each card opens a detail view with a **Conversion data** section at the top (known Google Ads + GA4 parameters with friendly labels and the raw key in brackets, e.g. `Customer lifetime value (vdltv)`, `Shipping cost (shf)`; items rendered as a numbered SKU × qty @ price list; `em` / `eme` also surface here). Below it `gcs` (current state per purpose) and `gcd` (decoded per purpose: ad_storage, analytics_storage, ad_user_data, ad_personalization) are shown — transition codes like `denied → granted` render the overruled default in grey and the active value in green / red. Everything else stays in the **Other query / body parameters** tables below
- Power-user shortcut: **Ctrl/⌘+click anywhere on a card** opens the detail view directly, instead of loading the identifier into the decoder
- **Clear links** next to both textareas (`em` value and JSON / JS literal payload) — one click empties the field and clears the decoder output
- **Settings tab** (⚙ icon, top right): central place for capture filters, permit behaviour, the toolbar indicator, plus **Theme** (System / Light / Dark) and **Text size** (Normal / Comfortable / Large) under an Appearance section. Each option shown with a full description, not just a tooltip
- **Back-to-captures button** in the Object Analysis tab when you arrived there by clicking a `user_data` card — quick return to the capture list without hunting for the EM Decoder tab. Hidden after manual tab navigation, so it never gets in the way.
- Filter to show only requests carrying any user data (`em`, `eme`, or `user_data`) — default on, hides telemetry pings
- Export captures as JSON for documentation or analysis (each entry tagged `source: 'ads' | 'ga'` and `transport: 'google' | 'first-party'`, plus `eme` and `userData` when present)
- Permission requested per-site via the URL field — the extension only listens on origins you explicitly grant; the webRequest listener is re-registered automatically when permissions change, so newly granted origins are picked up without reloading the service worker
- Granted sites are listed in a collapsible **Permitted sites** block under the URL input; one click on `×` revokes a site (active recording is stopped first)
- Requests *initiated from* Google's own UIs (`analytics.google.com`, `ads.google.com`, `tagmanager.google.com`, `tagassistant.google.com`) are ignored — those are internal calls of those tools, not events from the site under test
- The URL field auto-fills from the active tab and updates on tab switch, unless you have focus inside it (so manual edits aren't overwritten)
- Optional **Stop recording when side panel closes** (default on, Settings tab): closing the side panel ends the recording; uncheck if you want capturing to continue in the background
- Optional **Include subdomains when permitting** (default off, Settings tab): broadens the Permit request to a wildcard for the base domain (e.g. `https://*.example.com/*` instead of `https://shop.example.com/*`). Useful for shops with multiple subdomains or a first-party sGTM on its own subdomain. Chrome shows a wider permission dialog when this is active — review carefully before granting
- Optional **User-data indicator on extension icon** (default off, Settings tab): when active, the toolbar icon shows a pill (`ud` / `eme` / `em`) on the current tab whenever a built-in Google endpoint receives user data — independent of recording, so you see at a glance whether ec data is flowing on a page. Scoped strictly to the static Google endpoints (no monitoring of first-party / sGTM origins, even when granted). Pill resets on every tab navigation (including SPA route changes)

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

### v2.5.2

- **Fix: postal code / region recognition.** The compliance check and identifier pills only looked for `zp0`/`st0`, but the live Google tag emits `pc0`/`rg0` (postal code / region) for non-US addresses. Result was a false "Postal Code missing" warning and missing pills on capture cards. The decoder label table already knew both since v2.4; this aligns the rest of the codebase. `zp0`/`st0` are dropped — they were never observed in real captures.
- **Fix: street verification never matched.** Plaintext entered in the *Street* verify field was hashed as-is, but Google strips digits and punctuation from `address.street` before hashing (and does *not* collapse the resulting whitespace). `"Strasse 1a"` hashes as `"strasse a"`, `"Bahnhofsr. 42B"` as `"bahnhofsr b"`, `"Bahnhofstraße 22A - C"` as `"bahnhofstraße a  c"` (double space where `" - "` was). The verifier applies the same normalization now, verified against eight live-tag hashes.

### v2.5

- **Settings tab** (⚙ icon, top right): the five capture / permit / indicator toggles moved out of the recording card into their own tab — each with a full inline description rather than a hover tooltip. Keeps the EM Decoder tab focused on the actual recording controls.
- **Dark mode + text scaling**: a new *Appearance* section in the Settings tab adds **Theme** (System / Light / Dark, defaults to System and switches live with the OS) and **Text size** (Normal / Comfortable / Large). CSS variables were consolidated into semantic tokens (surface, text, border, …) so themes only flip the palette, not the layout. Coloured pills (identifier badges, consent state, encoding hex/b64url) keep their light-mode hues by design — they remain glanceable on either background.
- **Back-to-captures button** on the Object Analysis tab when navigation came from clicking a `user_data` card. Hidden after manual tab navigation, so it only appears when it is actually useful.
- **User-data indicator on extension icon**: new opt-in option. When active, the toolbar badge shows `ud` / `eme` / `em` on the current tab whenever a built-in Google endpoint (Ads `/ccm`, `/pagead`, GA4 `/g/collect`) receives user data — independent of recording, so the icon can act as an ambient "is ec data flowing here?" indicator while you browse. Resets automatically on every tab navigation, including SPA `pushState` / `replaceState`. Strictly scoped to the static Google endpoints — first-party / sGTM / Tag Gateway origins are not monitored by the indicator, even when granted for recording. You will see those requests only in recording mode.
- **Conversion summary on captures**: a compact second line under the identifier pills shows event type, value + currency, item count (tooltip with SKU × qty @ price), new-customer flag, customer LTV, shipping cost + destination and order ID. Sourced from Google Ads conversion parameters (`value`, `currency_code`, `bttype`, `oid`, `item`, `vdnc`, `vdltv`, `shf`, `delc`, `delopc`, `oedeld`, `mid`, `fcntr`, `flng`, `dscnt`) and GA4 commerce params (`epn.value`, `ep.currency`, `en`, `ep.transaction_id`, `prN` item count). Each field appears only when present in the request.
- **Consent Mode on captures**: a red `no ad_storage` pill (or orange `ad_storage unset`) is added to the card whenever `gcs` / `gcd` indicates that ad_storage was not granted — this explains the 99% case of "request fired but expected user data is missing".
- **Detail modal restructured**: a new **Conversion data** section at the top groups all known Google Ads / GA4 parameters with friendly labels and the raw key in brackets (`Customer lifetime value (vdltv)`, `Shipping cost (shf)`, …). `em` and `eme` are surfaced there too; items are listed by `SKU × quantity @ price` with the raw `item=(…)(…)` string still available behind a `raw` toggle. Below the conversion block, `gcs` is decoded into per-purpose state (ad_storage, analytics_storage) and `gcd` into all four purposes (ad_user_data, ad_personalization in addition). Transition codes like `denied → granted` render the overruled default in grey and the active value in green / red; pure default codes (`granted (default)`, `denied (default)`) are coloured directly; manual overrides carry a `MANUAL` marker. The remaining parameters keep their tables below as **Other query / body parameters**.
- **Power-user shortcut**: Ctrl/⌘+click anywhere on a card opens the detail view directly (the `i` icon still works the same; tooltip mentions the shortcut).
- **Clear links** next to the EM Decoder and Object Analysis textareas — one click empties the field and clears the decoder output.
- **Export** now carries `conversion` and `consent` (with `gcdDecoded`) alongside the existing `em` / `eme` / `userData` fields, so downstream tooling sees the same decoded values.

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
