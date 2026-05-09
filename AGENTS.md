# AGENTS.md

Notes for future agent sessions on this codebase. Read this before touching code so you don't have to re-derive the architecture from scratch.

## What this is

A Chrome MV3 extension (Manifest V3) that helps debug Google Ads **Enhanced Conversions** data flows. Two main jobs:

1. **Decode and validate** the `em` parameter from Google Ads conversion requests — match hashed values against plaintext, detect encoding (Hex vs Base64URL), check minimum-required fields per Google's spec.
2. **Inspect `user_data` objects** from `dataLayer.push`, `gtag()` calls, or raw JSON — verify hashed fields, detect structure errors (address fields outside `user_data.address`), warn on incomplete data.

UI sits in a Side Panel (since v1.3), not a popup. Includes a live network recording feature that captures Google Ads conversion requests and lists them as clickable cards.

## File map

```
manifest.json     MV3 manifest. Permissions: storage, sidePanel, webRequest, tabs.
                  host_permissions: 4 patterns for googleadservices.com + google.com.
                  optional_host_permissions: <all_urls> (granted per-site at runtime).
background.js     Service worker. Handles webRequest sniffing, message API for the
                  Side Panel, persistent state in chrome.storage.local. Bootstrap
                  promise serializes startup before message handling.
popup.html        Side Panel UI. Two tabs (EM Decoder, Object Analysis).
                  Recording card + capture grid live in the EM Decoder tab.
popup.js          UI logic. Tab switching, hash matching (Hex + Base64URL),
                  compliance checks, structure validation, capture rendering.
                  Communicates with background via chrome.runtime.sendMessage.
test-page/        Static test page (ectest.html) for atomkraftwerke24.de.
                  Has GTM-M3X2ND4 + form + dataLayer push with toggleable
                  hash/country/push options. Used to generate test conversions.
ressources/
  ec-ploginfo.md  Findings doc — observations from real testing, structured
                  as a knowledge base for a planned blogpost. Source of truth
                  for "what we learned".
  enhanced-conversions-info-de.md
                  Reference notes on EC fields and minimum requirements.
  user-data-validator.html
                  Standalone HTML version of the popup (legacy, pre-extension).
  icon.svg / make-icons.ps1
                  Asset pipeline for the icon set.
```

## Key concepts

### Hash encodings (popup.js)

Google sends SHA-256 hashes in **two encodings** depending on the path:

- **Hex** (64 chars, `[0-9a-f]`) — manually provided values, e.g. `sha256_email_address` from a dataLayer push
- **Base64URL** (43 chars, `[A-Za-z0-9_-]`, no padding) — automatically detected values in the `em` parameter

`sha256()` returns `{ hex, b64url }`, `hashMatches()` checks against both. `detectHashEncoding()` parses tokens and returns `'hex'` / `'b64url'` / `null`. Pills (`.enc-hex`, `.enc-b64url`) show the encoding next to each hash.

### Compliance check (popup.js → checkMinReq)

Three states, no red errors:

- **green** — Email present *or* full address (FN+LN+Country+PLZ) present
- **grey** — full address minus PLZ (Google still processes; documented in finding #2)
- **yellow** — address fields detected but key required ones missing, or only Phone (insufficient on its own)

`checkMinReq(keys, misplaced)` accepts an optional `misplaced` set; address fields found *outside* `user_data.address` don't count toward `fullAddr`.

### Structure validation (popup.js → detectMisplacedAddrFields)

Walks the parsed object, marks address-class fields (`first_name`, `last_name`, `country`, `postal_code`, `street`, `city`, `region`, all incl. `sha256_*` variants) that aren't nested under an `address` block. Renders a red structure-error block at the top of the Object tab.

### Recording (background.js + popup.js)

- `chrome.webRequest.onBeforeRequest` listens on the four host patterns. **Both target and initiator origin must be permitted.** That's why we ship target permissions statically and request initiator permissions per-site via `optional_host_permissions: ["<all_urls>"]`.
- Recording state (`{ recording, captures }`) lives in `chrome.storage.local.captureState`, ringed at 50 entries.
- `bootstrapPromise` serializes startup load before message handling — without it, a `clearCaptures` racing the storage `get()` callback would silently lose the clear.
- Side Panel sends `getState` / `startRecording` / `stopRecording` / `clearCaptures`. Background broadcasts `captureAdded` / `stateChanged` / `capturesCleared` for live UI updates.
- Permission request happens in popup.js under user gesture (`chrome.permissions.request`). MUST be triggered from a click handler — not callable from the service worker.

### Misc important details

- Service-worker top-level registration matters: `chrome.webRequest.onBeforeRequest.addListener(...)` runs at SW boot. If the SW suspends and wakes up, this re-registers automatically.
- `chrome.runtime.onStartup` resets `state.recording = false` so a forgotten recording doesn't run silently after browser restart.
- `[hidden]` HTML attribute does NOT override `display: grid` / `flex`. We have an explicit `.cap-list[hidden] { display: none; }` rule, learned the hard way.
- The Side Panel persists open across tab switches. The "Reload URL from active tab" button (↻) re-reads the current tab's origin without needing a panel reopen.

## TODOs (next session candidates)

These were postponed at the end of the v2 release, all worth doing when relevant:

### TODO 1: Permitted Origins management UI

Currently you can grant origins via `permitOrigin('https://example.com/*')` in the SW console, but only revoke via `revokeOrigin(...)` or `revokeAllOptionalOrigins()`. After testing on multiple sites the granted-list grows long and there's no UI to inspect/clean it.

**Implementation sketch:**
- Below the URL input, render a collapsible "Permitted sites" list
- One row per granted optional origin, with a small × button to revoke
- On `permitOrigin` / `revokeOrigin` (or after the permission dialog), refresh the list via `chrome.permissions.getAll()`
- Static origins (the 4 host_permissions) should be filtered out — they can't be revoked

### TODO 2: POST-body parser for `pagead/form-data`

We know from finding #4 that `pagead/form-data` POSTs are systematically without `em`, while `ccm/form-data` carries the identifier. The `pagead/form-data` body still has telemetry fields (`gtm`, `gcs`, `gcd`, `dma`, `tag_exp`, UA hints) — currently invisible to the user.

**Implementation sketch:**
- In `extractEM`, also extract a flat dict of all body params (not just `em`)
- Persist it in the capture as `c.bodyParams` (cap to a few KB)
- Detail-view (see TODO 3) shows them in a table

This would let us either confirm or kill the "two requests, two contracts" hypothesis from finding #4.

### TODO 3: Capture detail view

Click on a card currently loads the `em` into the EM Decoder. A second click target (or shift-click, or a small icon button on the card) could open a drawer/modal with **all** query params + body params for that capture, neatly tabulated. Useful for debugging beyond `em`: consent state (`gcs`, `gcd`), tag version (`gtm`), DMA (`dma`), experiment cohorts (`tag_exp`), etc.

**Implementation sketch:**
- Small icon (e.g. `i` or magnifier) on each card, top-right
- Click opens an overlay with a table: param name → value
- For long values (cookies, base64), show truncated with "show full" toggle
- Don't replace the click-to-load behavior, add a second one

## Findings doc

`ressources/ec-ploginfo.md` is the source of truth for what we've learned about Enhanced Conversions in practice. Each finding has structure: setup, observation, hypothesis/evaluation, implication, sources. Add to it whenever new test runs reveal something — the doc feeds a planned blogpost.

Currently has 4 findings. Highlights:
- **#1**: SHA-256 hashes in `em` are Base64URL, not Hex (auto-detection vs manual differs)
- **#2**: Only the GTM UI manual mapping validates required fields; all programmatic paths accept anything
- **#3**: Even single-field identifiers (`fn0` alone) are transmitted; possible server-side stitching
- **#4**: Each UPD event sends two POSTs (`pagead/form-data` empty, `ccm/form-data` with em) — split contracts vs redundancy hypotheses

## Don't break

- The `chrome.webRequest` listener registration must stay top-level in `background.js` (re-registered on every SW wake).
- `bootstrapPromise` must wrap all message handler logic — direct sync access to `state` from a message handler races the storage initial load.
- `optional_host_permissions: ["<all_urls>"]` must remain optional, not static. We had a phase where Chrome cached it as required after a manifest swap; the only fix is full re-install.
- Pills are styled by class, not inline color — keep `PILL_CLASS` and the `.identifier-*` rules in sync.
