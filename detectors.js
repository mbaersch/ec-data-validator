// Provider registry for third-party PII detectors (Meta, and later TikTok /
// Pinterest / Bing). Pure functions, no chrome / DOM APIs, so this file can be
// pulled into the service worker via importScripts('detectors.js'). Each
// detector knows how to (a) recognize its own requests by host + path and
// (b) parse a request into a normalized record the capture pipeline can store.
//
// The knowledge here is ported from the sibling tracking-auditor-extension
// (lib/meta.js), adapted for this extension's goal: not just listing which
// identifier fields are present, but flagging when one leaves the browser in
// plaintext instead of a SHA-256 hash.

(function (root) {
  'use strict';

  // A SHA-256 hash is 64 hex chars. Meta's fbevents.js always hashes the
  // advanced-matching fields before they go out, so a value in a hash slot that
  // does NOT look like this is the interesting case — plaintext PII leaving the
  // browser.
  function looksHashedSha256(v) {
    return typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v.trim());
  }

  // Pinterest (and Bing) accept SHA-256 (64), SHA-1 (40) or MD5 (32) hex — so a
  // value that is any of those lengths of hex is "hashed"; anything else in a
  // hash slot (e.g. a plaintext email) is a leak.
  function looksHashedAny(v) {
    if (typeof v !== 'string') return false;
    const s = v.trim();
    return [32, 40, 64].includes(s.length) && /^[0-9a-f]+$/i.test(s);
  }

  // Field normalizers used by the validation profiles. Each provider hashes
  // its advanced-matching fields with its own normalization; a validator must
  // reproduce it exactly to compare. These are the building blocks — providers
  // pick per field. The Meta rules below match fbevents.js' in-browser
  // normalization and Meta's documented advanced-matching / customer-information
  // rules (developers.facebook.com/docs/.../customer-information-parameters).
  function normTrimLower(v)    { return String(v).trim().toLowerCase(); }                 // email: lowercase + trim
  // phone: digits only (incl. country code), then strip leading zeros —
  // fbevents does .replace(/[^0-9]/g,'').replace(/^0+/,''); e.g. a German
  // "0170 1234567" hashes as "1701234567", not "01701234567".
  function normPhone(v)        { return String(v).replace(/[^\d]/g, '').replace(/^0+/, ''); }
  // name/city/state: lowercase, drop punctuation, spaces and digits, keep
  // (UTF-8) letters — so accents survive but "O'Brien" → "obrien".
  function normLettersLower(v) { return String(v).toLowerCase().replace(/[^\p{L}]/gu, ''); }
  // zip: lowercase, no spaces and no dash (keeps UK alphanumeric postcodes);
  // Meta additionally truncates US codes to the first 5 digits, which we can't
  // do reliably without a country signal, so we leave zip+4 length as-is.
  function normZip(v)          { return String(v).trim().toLowerCase().replace(/[^a-z0-9]/g, ''); }
  function normCountry(v)      { return String(v).trim().toLowerCase(); }                 // ISO-3166-1 alpha-2
  // opaque advertiser ID (external_id): trim only, NO lower-casing — these IDs
  // (CRM numbers etc.) are hashed exactly as provided and are case-sensitive.
  // Paired with the field's exact:true flag so the validator hashes case-
  // preservingly and runs no raw-vs-normalized diagnostic (exact IS canonical).
  function normId(v)           { return String(v).trim(); }
  // Pinterest email: lower-case, no spaces at all (per Pinterest's help).
  function normEmailNoSpace(v) { return String(v).toLowerCase().replace(/\s/g, ''); }
  // phone in E.164: keep a leading '+', map a leading '00' intl prefix to '+',
  // strip everything else non-digit. Used by providers that hash the '+' form
  // (TikTok, Google) — unlike Meta, which hashes digits only without the '+'.
  function normPhoneE164(v) {
    const c = String(v).replace(/[^\d+]/g, '');
    if (c.startsWith('+')) return '+' + c.slice(1).replace(/\+/g, '');
    const d = c.replace(/\+/g, '');
    return d.startsWith('00') ? '+' + d.slice(2) : d;
  }
  // phone in E.164 digits WITHOUT the leading '+'. Used by Snapchat, which hashes
  // the number without the plus (and otherwise only lower-cases).
  function normPhoneNoPlus(v) { return normPhoneE164(v).replace(/^\+/, ''); }

  // UTF-8-safe base64 decode (for the base64-in-querystring GET transport).
  // atob + TextDecoder both exist in the service worker and the panel.
  function decodeBase64Utf8(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
  }

  // base64 text → raw bytes, and gzip bytes → text (async, via DecompressionStream
  // — available in both the service worker and the panel). Used for LinkedIn's
  // base64(gzip(JSON)) /wa/ body.
  function base64ToBytes(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  async function gunzipToText(bytes) {
    const stream = new Response(bytes).body.pipeThrough(new DecompressionStream('gzip'));
    const buf = await new Response(stream).arrayBuffer();
    return new TextDecoder('utf-8').decode(buf);
  }

  // -------------------------------------------------------------------------
  // Meta (Facebook) Pixel
  // -------------------------------------------------------------------------
  //
  // A browser pixel hit goes to https://www.facebook.com/tr/ as a GET beacon
  // or, for larger payloads, a form POST carrying the params in the body. Each
  // advanced-matching field can arrive in up to four parallel representations,
  // e.g. for email:
  //   ud[em]   = SHA-256 hash (the actual advanced-matching payload)
  //   aud[em]  = SHA-256 hash (automatic advanced matching)
  //   cud[em]  = masked raw value, e.g. ****@****.**   (already PII-free)
  //   ncud[em] = masked normalized value
  // We key by the inner field so a field counts once regardless of
  // representation. `hashed` slots (ud/udff/aud) are additionally value-checked:
  // if the value in a hash slot is not hash-shaped, we mark the field as a
  // plaintext leak.

  const META_FIELD = {
    em:          { bucket: 'email',      label: 'Email' },
    ph:          { bucket: 'phone',      label: 'Phone' },
    fn:          { bucket: 'firstName',  label: 'First name' },
    ln:          { bucket: 'lastName',   label: 'Last name' },
    ct:          { bucket: 'city',       label: 'City' },
    st:          { bucket: 'region',     label: 'State' },   // Meta st = state, not street
    zp:          { bucket: 'postal',     label: 'Zip' },
    country:     { bucket: 'country',    label: 'Country' },
    ge:          { bucket: 'gender',     label: 'Gender' },
    db:          { bucket: 'dob',        label: 'Date of birth' },
    external_id: { bucket: 'externalId', label: 'External ID' },
  };

  const META_UD_KEY_RE = /^(ud|udff|cud|ncud|aud)\[([\w]+)\]$/;

  const META_STANDARD_EVENTS = new Set([
    'PageView', 'ViewContent', 'Search', 'AddToCart', 'AddToWishlist',
    'InitiateCheckout', 'AddPaymentInfo', 'Purchase', 'Lead', 'CompleteRegistration',
    'Contact', 'CustomizeProduct', 'Donate', 'FindLocation', 'Schedule',
    'StartTrial', 'SubmitApplication', 'Subscribe', 'SubscribedButtonClick', 'Microdata',
  ]);

  function isFacebookHost(host) {
    const h = (host || '').toLowerCase();
    return h === 'facebook.com' || h.endsWith('.facebook.com');
  }

  function isTrPath(pathname) {
    return /\/tr\/?$/.test(pathname || '');
  }

  // Walk both query and body params, group the ud[...]/cud[...]/... keys by
  // their inner field, and derive a status per field:
  //   hashed    — a hash slot carried a proper SHA-256 value
  //   plaintext — a hash slot (ud/udff/aud) carried a NON-hash value → leak
  //   masked    — only a cud/ncud mask was seen (no raw value ever transmitted)
  // We deliberately never keep the raw value; only the field identity and its
  // status leave this function, so the capture stays PII-free by itself.
  function extractMetaFields(queryParams, bodyParams) {
    const fields = {};
    const ensure = (key, def) => fields[key] || (fields[key] = {
      field: key, bucket: def.bucket, label: def.label,
      hashed: false, plaintext: false, masked: false, mask: null,
      // external_id is an opaque advertiser id, not PII — a pill in its own
      // right, never a plaintext "leak" even when sent unhashed.
      opaque: key === 'external_id',
    });
    const consider = (params) => {
      for (const k of Object.keys(params || {})) {
        // external_id can also ride in the custom-data namespace (cd[external_id])
        // as a normal, often unhashed parameter — worth a pill of its own.
        if (k === 'cd[external_id]') {
          const cv = params[k];
          if (cv != null && String(cv).trim() !== '') {
            const f = ensure('external_id', META_FIELD.external_id);
            if (looksHashedSha256(cv)) f.hashed = true;
          }
          continue;
        }
        const m = META_UD_KEY_RE.exec(k);
        if (!m) continue;
        const rep = m[1], key = m[2];
        const def = META_FIELD[key];
        if (!def) continue; // unknown advanced-matching subfield
        const v = params[k];
        const f = ensure(key, def);
        if (rep === 'ud' || rep === 'udff' || rep === 'aud') {
          if (looksHashedSha256(v)) f.hashed = true;
          // an unhashed value in a hash slot is a leak — except external_id,
          // which legitimately travels unhashed (opaque flag already set).
          else if (!f.opaque && v != null && String(v).trim() !== '') f.plaintext = true;
        } else if (rep === 'cud') {
          f.masked = true;
          if (f.mask == null) f.mask = String(v);
        } else if (rep === 'ncud') {
          f.masked = true;
        }
      }
    };
    consider(queryParams);
    consider(bodyParams);
    const list = Object.keys(fields).map(k => fields[k]);
    return list.length ? list : [];
  }

  // Meta's consent signal is Limited Data Use (no Google-style gcs/gcd):
  // dpo (data_processing_options), dpoco (country), dpost (state).
  function parseMetaConsent(get) {
    const dpo = get('dpo');
    const country = get('dpoco');
    const stateCode = get('dpost');
    if (dpo == null && country == null && stateCode == null) return null;
    const ldu = dpo != null && dpo !== '' && dpo !== '[]' && dpo !== '0';
    return { ldu, dpo, country, state: stateCode };
  }

  const metaDetector = {
    id: 'meta',
    label: 'Meta Pixel',
    // facebook.com/tr is https-only. The first-party proxied /tr variant on a
    // shop's own domain is out of scope for this first pass.
    permissionOrigins: ['https://*.facebook.com/*'],

    match(host, pathname) {
      return isFacebookHost(host) && isTrPath(pathname);
    },

    // Panel-side validation profile — the data that drives the generic hash-
    // validation view. `fields` are validatable (plaintext compare input +
    // Meta normalization); `labels` are shown hash-only. Adding a new provider
    // means adding one of these, not new UI.
    validation: {
      title: 'Meta Pixel',
      note: 'email lower/trim · phone digits, no leading 0 · name/city letters only · zip no space/dash · country 2-letter',
      eventParam: 'ev', // request key carrying the event name (for the header)
      // request keys carrying a validatable hash (the hashed representations)
      hashSlotRe: /^(ud|udff|aud)\[([\w]+)\]$/,
      fields: {
        em:      { verifyId: 'v_email',   label: 'Email',      normalize: normTrimLower },
        ph:      { verifyId: 'v_phone',   label: 'Phone',      normalize: normPhone },
        fn:      { verifyId: 'v_fn',      label: 'First name', normalize: normLettersLower },
        ln:      { verifyId: 'v_ln',      label: 'Last name',  normalize: normLettersLower },
        ct:      { verifyId: 'v_city',    label: 'City',       normalize: normLettersLower },
        st:      { verifyId: 'v_region',  label: 'State',      normalize: normLettersLower },
        zp:      { verifyId: 'v_postal',  label: 'Zip',        normalize: normZip },
        country: { verifyId: 'v_country', label: 'Country',    normalize: normCountry },
        // Opaque ID — hashed exactly as provided (case-sensitive), no normalization.
        external_id: { verifyId: 'v_extid', label: 'External ID', normalize: normId, exact: true }
      },
      labels: { ge: 'Gender', db: 'Date of birth' }
    },

    // ctx: { url, host, pathname, queryParams, bodyParams }
    // Returns a normalized record or null for non-events.
    parse(ctx) {
      const q = ctx.queryParams || {};
      const b = ctx.bodyParams || {};
      const get = (k) => (k in q ? q[k] : (b && k in b ? b[k] : null));

      const id = get('id');
      if (!id) return null; // a pixel event always carries its pixel id

      const ev = get('ev');
      const identifiers = extractMetaFields(q, b);
      const consent = parseMetaConsent(get);

      return {
        provider: 'meta',
        transport: 'standard',
        event: ev || null,
        standardEvent: !!ev && META_STANDARD_EVENTS.has(ev),
        providerId: String(id),
        identifiers,
        consent,
      };
    },
  };

  // -------------------------------------------------------------------------
  // TikTok Pixel
  // -------------------------------------------------------------------------
  //
  // A browser pixel hit goes to analytics.tiktok.com/api/v2/pixel (or the
  // shopify_pixel / /act batch variants) as a POST with a JSON body, OR as a GET
  // with the same JSON base64-encoded in ?analytics_message= . Unlike Meta, the
  // identifiers live in a NESTED JSON object (context.user) rather than flat
  // ud[...] params, and the values are SHA-256 hex. We flatten context.user into
  // synthetic `user[<field>]` slots so the same panel plumbing (hashSlotRe,
  // detectorRequestString, extractDetectorHashes) that drives Meta validates
  // TikTok too.

  const TIKTOK_USER_FIELD = {
    email:        { bucket: 'email',      label: 'Email' },
    phone_number: { bucket: 'phone',      label: 'Phone' },
    first_name:   { bucket: 'firstName',  label: 'First name' },
    last_name:    { bucket: 'lastName',   label: 'Last name' },
    city:         { bucket: 'city',       label: 'City' },
    state:        { bucket: 'region',     label: 'State' },   // st = state/region
    zip_code:     { bucket: 'postal',     label: 'Zip' },
    country:      { bucket: 'country',    label: 'Country' },
    external_id:  { bucket: 'externalId', label: 'External ID' },
  };

  const TIKTOK_STANDARD_EVENTS = new Set([
    'Pageview', 'ViewContent', 'Search', 'AddToCart', 'AddToWishlist',
    'InitiateCheckout', 'AddPaymentInfo', 'CompletePayment', 'PlaceAnOrder',
    'CompleteRegistration', 'Contact', 'Subscribe', 'SubmitForm',
    'ClickButton', 'Download',
  ]);

  function isTiktokHost(host) {
    const h = (host || '').toLowerCase();
    return h === 'analytics.tiktok.com' || h.endsWith('.analytics.tiktok.com');
  }

  // Event endpoints are /api/v2/pixel and /api/v2/pixel/act (plus shopify_pixel).
  // Heartbeat/telemetry sub-paths carry no event and are ignored.
  function isTiktokPixelPath(pathname) {
    const p = pathname || '';
    if (!/\/api\/v2\/(shopify_)?pixel(\/|$)/.test(p)) return false;
    if (/\/(inter|perf|monitor|enrich_ipv6)(\/|$)/.test(p)) return false;
    return true;
  }

  // Recover the TikTok payload's event + context from the capture context.
  // POST: background.js flattened the JSON top level, so bodyParams.context is a
  // JSON string and bodyParams.event the event name. GET: the whole payload sits
  // base64-encoded in the analytics_message query param.
  function tiktokPayload(ctx) {
    const q = ctx.queryParams || {};
    const b = ctx.bodyParams || {};
    if (q.analytics_message) {
      try {
        const obj = JSON.parse(decodeBase64Utf8(decodeURIComponent(q.analytics_message)));
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          return { event: obj.event, context: obj.context, transport: 'base64' };
        }
      } catch (e) { /* not a decodable TikTok message */ }
    }
    let context = null;
    if (b.context && typeof b.context === 'string') {
      try { context = JSON.parse(b.context); } catch (e) { context = null; }
    } else if (b.context && typeof b.context === 'object') {
      context = b.context;
    }
    return { event: b.event != null ? b.event : null, context, transport: 'standard' };
  }

  const tiktokDetector = {
    id: 'tiktok',
    label: 'TikTok Pixel',
    permissionOrigins: ['https://analytics.tiktok.com/*'],

    match(host, pathname) {
      return isTiktokHost(host) && isTiktokPixelPath(pathname);
    },

    validation: {
      title: 'TikTok Pixel',
      note: 'email lower/trim · phone E.164 (+, no leading 0) · name/city letters only · zip no space/dash · country 2-letter',
      eventParam: 'event',
      hashSlotRe: /^(user)\[([\w]+)\]$/,
      fields: {
        email:        { verifyId: 'v_email',   label: 'Email',      normalize: normTrimLower },
        phone_number: { verifyId: 'v_phone',   label: 'Phone',      normalize: normPhoneE164 },
        first_name:   { verifyId: 'v_fn',      label: 'First name', normalize: normLettersLower },
        last_name:    { verifyId: 'v_ln',      label: 'Last name',  normalize: normLettersLower },
        city:         { verifyId: 'v_city',    label: 'City',       normalize: normLettersLower },
        state:        { verifyId: 'v_region',  label: 'State',      normalize: normLettersLower },
        zip_code:     { verifyId: 'v_postal',  label: 'Zip',        normalize: normZip },
        country:      { verifyId: 'v_country', label: 'Country',    normalize: normCountry },
        // Opaque ID — hashed exactly as provided (case-sensitive), no normalization.
        external_id:  { verifyId: 'v_extid',   label: 'External ID', normalize: normId, exact: true },
      },
      labels: {},
    },

    // ctx: { url, host, pathname, queryParams, bodyParams }
    parse(ctx) {
      const { event, context, transport } = tiktokPayload(ctx);
      if (!event || typeof event !== 'string') return null;
      if (event === 'EnrichAM') return null; // internal advanced-matching probe

      const cxt = (context && typeof context === 'object') ? context : {};
      const pixel = (cxt.pixel && typeof cxt.pixel === 'object') ? cxt.pixel : {};
      const code = pixel.code != null ? String(pixel.code)
                 : (pixel.codes != null ? String(pixel.codes).split('|')[0] : null);
      if (!code) return null; // a pixel event always carries its pixel id

      const user = (cxt.user && typeof cxt.user === 'object' && !Array.isArray(cxt.user)) ? cxt.user : {};
      const identifiers = [];
      // Flat hash slots the panel can re-parse; always carries the event so the
      // request string shown in the PII field mirrors the Meta one.
      const hashParams = { event };
      for (const k of Object.keys(user)) {
        const def = TIKTOK_USER_FIELD[k];
        if (!def) continue;
        const v = user[k];
        if (v == null || String(v).trim() === '') continue;
        const hashed = looksHashedSha256(v);
        const opaque = (k === 'external_id'); // opaque id, unhashed is not a leak
        identifiers.push({
          field: k, bucket: def.bucket, label: def.label,
          hashed, plaintext: !hashed && !opaque, masked: false, mask: null, opaque,
        });
        hashParams['user[' + k + ']'] = String(v);
      }

      return {
        provider: 'tiktok',
        transport: transport || 'standard',
        event,
        standardEvent: TIKTOK_STANDARD_EVENTS.has(event),
        providerId: code,
        identifiers,
        consent: null,           // TikTok pixel surfaces no consent signal
        hashParams,
      };
    },
  };

  // -------------------------------------------------------------------------
  // Pinterest Tag
  // -------------------------------------------------------------------------
  //
  // A browser tag hit goes to ct.pinterest.com/v3/ as a GET beacon. Enhanced
  // match rides in the `pd` param, either as a URL-encoded JSON object (JS tag:
  // pd={"em":"<hash>",…}) or as bracket params (noscript: pd[em]=<hash>). The
  // hash may be SHA-256, SHA-1 OR MD5 (hex) — the panel detects which by length.
  // We flatten pd into synthetic pd[<field>] slots (like TikTok's context.user),
  // so the shared validation plumbing applies unchanged.

  const PINTEREST_FIELD = {
    em:           { bucket: 'email',      label: 'Email' },
    ph:           { bucket: 'phone',      label: 'Phone' },
    fn:           { bucket: 'firstName',  label: 'First name' },
    ln:           { bucket: 'lastName',   label: 'Last name' },
    ct:           { bucket: 'city',       label: 'City' },
    st:           { bucket: 'region',     label: 'State' },
    zp:           { bucket: 'postal',     label: 'Zip' },
    country:      { bucket: 'country',    label: 'Country' },
    ge:           { bucket: 'gender',     label: 'Gender' },
    db:           { bucket: 'dob',        label: 'Date of birth' },
    external_id:  { bucket: 'externalId', label: 'External ID' },
    hashed_maids: { bucket: 'maid',       label: 'Mobile ad ID' },
  };

  function isPinterestHost(host) {
    return (host || '').toLowerCase() === 'ct.pinterest.com';
  }

  function isPinterestV3Path(pathname) {
    return /^\/v3(\/|$)/.test(pathname || '');
  }

  // Recover the enhanced-match object: the JSON `pd` param, or bracket params.
  function pinterestPd(ctx) {
    const q = ctx.queryParams || {};
    const b = ctx.bodyParams || {};
    const pdRaw = (q.pd != null ? q.pd : (b && b.pd != null ? b.pd : null));
    if (pdRaw && typeof pdRaw === 'string') {
      try {
        const o = JSON.parse(pdRaw);
        if (o && typeof o === 'object' && !Array.isArray(o)) return o;
      } catch (e) { /* not the JSON variant */ }
    }
    const pd = {};
    const scan = (params) => {
      for (const k of Object.keys(params || {})) {
        const m = /^pd\[([\w]+)\]$/.exec(k);
        if (m) pd[m[1]] = params[k];
      }
    };
    scan(q); scan(b);
    return Object.keys(pd).length ? pd : null;
  }

  const pinterestDetector = {
    id: 'pinterest',
    label: 'Pinterest Tag',
    permissionOrigins: ['https://ct.pinterest.com/*'],

    match(host, pathname) {
      return isPinterestHost(host) && isPinterestV3Path(pathname);
    },

    validation: {
      title: 'Pinterest Tag',
      note: 'email lower-case, no spaces · hash SHA-256 / SHA-1 / MD5 (auto-detected by length)',
      eventParam: 'event',
      hashSlotRe: /^(pd)\[([\w]+)\]$/,
      fields: {
        em:          { verifyId: 'v_email', label: 'Email', normalize: normEmailNoSpace },
        external_id: { verifyId: 'v_extid', label: 'External ID', normalize: normId, exact: true },
      },
      // Pinterest can carry the full set, but only the email rule is documented;
      // the rest are shown hash-only rather than validated against guessed rules.
      labels: {
        ph: 'Phone', fn: 'First name', ln: 'Last name', ct: 'City', st: 'State',
        zp: 'Zip', country: 'Country', ge: 'Gender', db: 'Date of birth', hashed_maids: 'Mobile ad ID',
      },
    },

    // ctx: { url, host, pathname, queryParams, bodyParams }
    parse(ctx) {
      const q = ctx.queryParams || {};
      const b = ctx.bodyParams || {};
      const get = (k) => (k in q ? q[k] : (b && k in b ? b[k] : null));

      const tid = get('tid');
      if (!tid) return null; // a tag hit always carries its tag id

      const event = get('event');
      const pd = pinterestPd(ctx);

      const identifiers = [];
      const hashParams = {};
      if (event != null && event !== '') hashParams.event = String(event);
      if (pd) {
        for (const k of Object.keys(pd)) {
          const def = PINTEREST_FIELD[k];
          if (!def) continue;
          let v = pd[k];
          if (Array.isArray(v)) v = v[0];
          if (v == null || String(v).trim() === '') continue;
          const hashed = looksHashedAny(v);
          const opaque = (k === 'external_id' || k === 'hashed_maids');
          identifiers.push({
            field: k, bucket: def.bucket, label: def.label,
            hashed, plaintext: !hashed && !opaque, masked: false, mask: null, opaque,
          });
          hashParams['pd[' + k + ']'] = String(v);
        }
      }

      return {
        provider: 'pinterest',
        transport: 'standard',
        event: event != null && event !== '' ? String(event) : null,
        standardEvent: false,
        providerId: String(tid),
        identifiers,
        consent: null,        // Pinterest's ppce is a response header, not in the request
        hashParams,
      };
    },
  };

  // -------------------------------------------------------------------------
  // Microsoft Bing UET
  // -------------------------------------------------------------------------
  //
  // A UET hit goes to bat.bing.com/action/0 (or /actionp/0), CST/Flex tags to
  // commerce.bing.com/cst/0 — GET beacons. Enhanced-conversions user data rides
  // inside the `pid` parameter as a NESTED querystring: "em=<sha256>&ph=<sha256>
  // &fn=…&ln=…" (email/phone/first/last, SHA-256). We parse that inner string and
  // flatten it to synthetic pid[<field>] slots for the shared plumbing.

  const UET_FIELD = {
    em: { bucket: 'email',     label: 'Email' },
    ph: { bucket: 'phone',     label: 'Phone' },
    fn: { bucket: 'firstName', label: 'First name' },
    ln: { bucket: 'lastName',  label: 'Last name' },
  };

  function isBingHost(host) {
    const h = (host || '').toLowerCase();
    return h === 'bat.bing.com' || h === 'commerce.bing.com';
  }

  function isUetPath(pathname) {
    const p = pathname || '';
    return /\/actionp?(\/|$)/.test(p) || /\/cst(\/|$)/.test(p);
  }

  const bingDetector = {
    id: 'bing',
    label: 'Bing UET',
    permissionOrigins: ['https://bat.bing.com/*', 'https://commerce.bing.com/*'],

    match(host, pathname) {
      return isBingHost(host) && isUetPath(pathname);
    },

    validation: {
      title: 'Bing UET',
      note: 'email lower/trim · phone E.164 (+, no leading 0) · name letters only · SHA-256',
      eventParam: 'evt',
      hashSlotRe: /^(pid)\[([\w]+)\]$/,
      fields: {
        em: { verifyId: 'v_email', label: 'Email',      normalize: normTrimLower },
        ph: { verifyId: 'v_phone', label: 'Phone',      normalize: normPhoneE164 },
        fn: { verifyId: 'v_fn',    label: 'First name', normalize: normLettersLower },
        ln: { verifyId: 'v_ln',    label: 'Last name',  normalize: normLettersLower },
      },
      labels: {},
    },

    // ctx: { url, host, pathname, queryParams, bodyParams }
    parse(ctx) {
      const q = ctx.queryParams || {};
      const b = ctx.bodyParams || {};
      const get = (k) => (k in q ? q[k] : (b && k in b ? b[k] : null));

      const ti = get('ti');
      if (!ti) return null; // a UET hit always carries its tag id

      const evt = get('evt');
      const ea = get('ea'), ec = get('ec'), el = get('el');
      const pidRaw = get('pid');

      // Friendly event name: a custom event's real action lives in ea (purchase,
      // refund, add_to_cart, …). Fall back to the ecommerce pagetype — every
      // e-commerce hit carries ecom params (pagetype / ecomm_totalvalue), which
      // makes it recognisable even when ea is absent — then to el, then custom.
      let eventName;
      if (evt === 'custom') eventName = [ec, ea].filter(Boolean).join(' – ') || get('pagetype') || el || 'custom';
      else eventName = evt != null && evt !== '' ? String(evt) : null;

      // Revenue: gv (goal value) or ecomm_totalvalue; currency from gc / currency.
      const rawVal = get('gv') != null ? get('gv') : get('ecomm_totalvalue');
      const cur = get('gc') || get('currency') || null;
      const revenue = (rawVal != null && rawVal !== '')
        ? { value: String(rawVal), currency: cur ? String(cur) : null }
        : null;

      const identifiers = [];
      const hashParams = {};
      if (evt != null && evt !== '') hashParams.evt = String(evt);
      if (pidRaw != null && pidRaw !== '') {
        let inner = null;
        try { inner = new URLSearchParams(String(pidRaw)); } catch (e) { inner = null; }
        if (inner) {
          for (const [k, v] of inner) {
            const def = UET_FIELD[k];
            if (!def) continue;
            if (v == null || String(v).trim() === '') continue;
            const hashed = looksHashedSha256(v);
            identifiers.push({
              field: k, bucket: def.bucket, label: def.label,
              hashed, plaintext: !hashed, masked: false, mask: null,
            });
            hashParams['pid[' + k + ']'] = String(v);
          }
        }
      }

      return {
        provider: 'bing',
        transport: 'standard',
        event: eventName,
        standardEvent: false,
        providerId: String(ti),
        identifiers,
        consent: null,
        revenue,
        hashParams,
      };
    },
  };

  // -------------------------------------------------------------------------
  // LinkedIn Insight Tag (enhanced conversions)
  // -------------------------------------------------------------------------
  //
  // The hashed email (hem) does NOT ride in the /collect beacon — it travels in a
  // POST to px.ads.linkedin.com/wa/ whose body is base64(gzip(JSON)). We decode
  // that (async, via DecompressionStream) and read `hem` — SHA-256 of the
  // lower-cased email, same format as the others. Only /wa/ hits that actually
  // carry a hem are captured; a plain PAGE_VISIT (hem null) is interaction
  // telemetry, not PII.

  function isLinkedInHost(host) {
    return /(^|\.)ads\.linkedin\.com$/.test((host || '').toLowerCase());
  }

  const linkedinDetector = {
    id: 'linkedin',
    label: 'LinkedIn Insight Tag',
    permissionOrigins: ['https://px.ads.linkedin.com/*', 'https://px4.ads.linkedin.com/*'],

    match(host, pathname) {
      return isLinkedInHost(host) && /\/wa(\/|$)/.test(pathname || '');
    },

    validation: {
      title: 'LinkedIn Insight Tag',
      note: 'email lower/trim → SHA-256 (hem)',
      eventParam: 'event',
      hashSlotRe: /^(li)\[([\w]+)\]$/,
      fields: {
        hem: { verifyId: 'v_email', label: 'Email', normalize: normTrimLower },
      },
      labels: {},
    },

    // async: the /wa/ body is base64(gzip(JSON)); ctx.rawBody carries the raw
    // request bytes (the base64 text).
    async parse(ctx) {
      const bytes = ctx.rawBody;
      if (!bytes) return null;
      let json;
      try {
        const b64 = new TextDecoder('utf-8').decode(bytes).trim();
        json = JSON.parse(await gunzipToText(base64ToBytes(b64)));
      } catch (e) { return null; }
      if (!json || typeof json !== 'object' || Array.isArray(json)) return null;

      const hem = (typeof json.hem === 'string' && json.hem.trim() !== '') ? json.hem.trim() : null;
      if (!hem) return null; // no PII in this /wa/ hit — skip

      const pids = Array.isArray(json.pids) ? json.pids : [];
      const signalType = json.signalType != null ? String(json.signalType) : null;
      const hashed = looksHashedSha256(hem);

      const identifiers = [{
        field: 'hem', bucket: 'email', label: 'Email',
        hashed, plaintext: !hashed, masked: false, mask: null,
      }];
      const hashParams = { 'li[hem]': hem };
      if (signalType) hashParams.event = signalType;

      return {
        provider: 'linkedin',
        transport: 'standard',
        event: signalType,
        standardEvent: false,
        providerId: pids.length ? String(pids[0]) : null,
        identifiers,
        consent: null,
        hashParams,
      };
    },
  };

  // -------------------------------------------------------------------------
  // Snapchat Pixel
  // -------------------------------------------------------------------------
  //
  // A browser pixel hit goes to tr.snapchat.com/p (numbered mirrors tr6.* exist).
  // There are two shapes under /p: the GET carries the tracking event with all
  // identifiers + e-commerce in the query string; the POST is internal telemetry
  // with no user identifiers AND no pid/ev in the query — so requiring pid+ev
  // below excludes it cleanly without needing the request method. All identifier
  // and geo fields are SHA-256 of the LOWER-CASED value (Snapchat's only
  // normalization — verified against u_fn / u_age / l_*); phone is hashed WITHOUT
  // a leading '+'. u_hed is a derived/composite hash (no single plaintext), so it
  // is surfaced hash-only, never validated or flagged as a leak.

  const SNAP_FIELD = {
    u_hem:  { bucket: 'email',      label: 'Email' },
    u_hpn:  { bucket: 'phone',      label: 'Phone' },
    u_fn:   { bucket: 'firstName',  label: 'First name' },
    u_ln:   { bucket: 'lastName',   label: 'Last name' },
    u_age:  { bucket: 'age',        label: 'Age' },
    l_city: { bucket: 'city',       label: 'City' },
    l_gc:   { bucket: 'country',    label: 'Country' },
    l_gpc:  { bucket: 'postal',     label: 'Postal code' },
    l_gr:   { bucket: 'region',     label: 'Region' },
    u_hed:  { bucket: 'other',      label: 'Hashed data (u_hed)' },
  };

  const SNAP_STANDARD_EVENTS = new Set([
    'page_view', 'view_content', 'add_cart', 'signup', 'sign_up', 'purchase', 'search',
    'subscribe', 'start_checkout', 'add_billing', 'save', 'login', 'list_view', 'reserve',
    'ad_click', 'ad_view', 'complete_tutorial', 'level_complete', 'invite', 'share',
    'custom_event_1', 'custom_event_2', 'custom_event_3', 'custom_event_4', 'custom_event_5',
  ]);

  function isSnapchatHost(host) {
    return /^tr\d*\.snapchat\.com$/.test((host || '').toLowerCase());
  }

  const snapchatDetector = {
    id: 'snapchat',
    label: 'Snapchat Pixel',
    permissionOrigins: ['https://tr.snapchat.com/*', 'https://tr6.snapchat.com/*'],

    match(host, pathname) {
      return isSnapchatHost(host) && /^\/p$/.test(pathname || '');
    },

    validation: {
      title: 'Snapchat Pixel',
      note: 'all fields lower-cased → SHA-256 · phone without +',
      eventParam: 'ev',
      hashSlotRe: /^(snap)\[([\w]+)\]$/,
      fields: {
        u_hem:  { verifyId: 'v_email',   label: 'Email',       normalize: normTrimLower },
        u_hpn:  { verifyId: 'v_phone',   label: 'Phone',       normalize: normPhoneNoPlus },
        u_fn:   { verifyId: 'v_fn',      label: 'First name',  normalize: normTrimLower },
        u_ln:   { verifyId: 'v_ln',      label: 'Last name',   normalize: normTrimLower },
        u_age:  { verifyId: 'v_age',     label: 'Age',         normalize: normTrimLower },
        l_city: { verifyId: 'v_city',    label: 'City',        normalize: normTrimLower },
        l_gc:   { verifyId: 'v_country', label: 'Country',     normalize: normTrimLower },
        l_gpc:  { verifyId: 'v_postal',  label: 'Postal code', normalize: normTrimLower },
        l_gr:   { verifyId: 'v_region',  label: 'Region',      normalize: normTrimLower },
      },
      labels: { u_hed: 'Hashed data (u_hed)' },
    },

    // ctx: { url, host, pathname, queryParams, bodyParams }
    parse(ctx) {
      const q = ctx.queryParams || {};
      const b = ctx.bodyParams || {};
      const get = (k) => (k in q ? q[k] : (b && k in b ? b[k] : null));

      const pid = get('pid') || get('pids');
      const ev = get('ev');
      // The GET event carries both; the POST telemetry beacon carries neither.
      if (!pid || !ev) return null;

      const identifiers = [];
      const hashParams = { event: String(ev) };
      for (const k of Object.keys(SNAP_FIELD)) {
        const v = get(k);
        if (v == null || String(v).trim() === '') continue;
        const def = SNAP_FIELD[k];
        const hashed = looksHashedSha256(v);
        const opaque = (k === 'u_hed'); // composite hash, not a single plaintext
        identifiers.push({
          field: k, bucket: def.bucket, label: def.label,
          hashed, plaintext: !hashed && !opaque, masked: false, mask: null, opaque,
        });
        hashParams['snap[' + k + ']'] = String(v);
      }

      const rawVal = get('e_pr');
      const revenue = (rawVal != null && rawVal !== '')
        ? { value: String(rawVal), currency: get('e_cur') ? String(get('e_cur')) : null }
        : null;

      return {
        provider: 'snapchat',
        transport: 'standard',
        event: String(ev),
        standardEvent: SNAP_STANDARD_EVENTS.has(String(ev).toLowerCase()),
        providerId: String(pid),
        identifiers,
        consent: null,
        revenue,
        hashParams,
      };
    },
  };

  // -------------------------------------------------------------------------
  // Reddit Pixel
  // -------------------------------------------------------------------------
  //
  // A browser pixel hit goes to alb.reddit.com/rp.gif as a GET beacon. The payload
  // rides in the query string: manually-set hashed em/pn (SHA-256), an opaque
  // external_id, plus AUTO-collected lists — auto_em is a comma-separated list of
  // hashed emails, auto_pn a pipe-separated list of '<weight>~<hash>' phones. This
  // is the ONLY beacon carrying Reddit user identifiers (no separate AM request).
  // Email is lower/trim → SHA-256; phone is hashed in E.164 WITH the leading '+'.
  // The auto lists are surfaced as pills (hashed check across every entry) but are
  // not individually validatable, so they stay out of the validation profile.

  const REDDIT_STANDARD_EVENTS = new Set([
    'pagevisit', 'viewcontent', 'search', 'addtocart', 'addtowishlist',
    'purchase', 'lead', 'signup', 'custom',
  ]);

  function isRedditHost(host) {
    return (host || '').toLowerCase() === 'alb.reddit.com';
  }

  function redditSplitList(v, sep) {
    return (v == null ? '' : String(v)).split(sep).map(s => s.trim()).filter(Boolean);
  }

  const redditDetector = {
    id: 'reddit',
    label: 'Reddit Pixel',
    permissionOrigins: ['https://alb.reddit.com/*'],

    match(host, pathname) {
      return isRedditHost(host) && /^\/rp\.gif$/.test(pathname || '');
    },

    validation: {
      title: 'Reddit Pixel',
      note: 'email lower/trim · phone E.164 with + · SHA-256',
      eventParam: 'event',
      hashSlotRe: /^(rdt)\[([\w]+)\]$/,
      fields: {
        em:          { verifyId: 'v_email', label: 'Email',       normalize: normTrimLower },
        pn:          { verifyId: 'v_phone', label: 'Phone',       normalize: normPhoneE164 },
        external_id: { verifyId: 'v_extid', label: 'External ID', normalize: normId, exact: true },
      },
      // Auto-collected lists are shown as pills on the card, not validated here.
      labels: {},
    },

    // ctx: { url, host, pathname, queryParams, bodyParams }
    parse(ctx) {
      const q = ctx.queryParams || {};
      const b = ctx.bodyParams || {};
      const get = (k) => (k in q ? q[k] : (b && k in b ? b[k] : null));

      const id = get('id');
      if (!id) return null; // a pixel hit always carries its account id (a2_…)

      const eventRaw = get('event');
      const event = eventRaw ? String(eventRaw) : 'PageVisit';

      const identifiers = [];
      const hashParams = { event };

      const single = (key, bucket, label, opaque) => {
        const v = get(key);
        if (v == null || String(v).trim() === '') return;
        const hashed = looksHashedSha256(v);
        identifiers.push({
          field: key, bucket, label, hashed,
          plaintext: !hashed && !opaque, masked: false, mask: null, opaque: !!opaque,
        });
        hashParams['rdt[' + key + ']'] = String(v);
      };
      single('em', 'email', 'Email', false);
      single('pn', 'phone', 'Phone', false);
      single('external_id', 'externalId', 'External ID', true);

      const autoEm = redditSplitList(get('auto_em'), ',');
      if (autoEm.length) {
        const allHashed = autoEm.every(looksHashedSha256);
        identifiers.push({
          field: 'auto_em', bucket: 'email', label: 'Auto email ×' + autoEm.length,
          hashed: allHashed, plaintext: !allHashed, masked: false, mask: null, opaque: false,
        });
      }
      // auto_pn entries are '<weight>~<hash>' — check the hash part.
      const autoPn = redditSplitList(get('auto_pn'), '|').map(e => {
        const i = e.indexOf('~');
        return i > 0 ? e.slice(i + 1) : e;
      });
      if (autoPn.length) {
        const allHashed = autoPn.every(looksHashedSha256);
        identifiers.push({
          field: 'auto_pn', bucket: 'phone', label: 'Auto phone ×' + autoPn.length,
          hashed: allHashed, plaintext: !allHashed, masked: false, mask: null, opaque: false,
        });
      }

      // Revenue: m.valueDecimal (comma-decimal, e.g. "12,55") preferred, else m.value.
      const valDec = get('m.valueDecimal');
      const val = (valDec != null && valDec !== '') ? valDec : get('m.value');
      const revenue = (val != null && String(val) !== '')
        ? { value: String(val), currency: get('m.currency') ? String(get('m.currency')) : null }
        : null;

      return {
        provider: 'reddit',
        transport: 'standard',
        event,
        standardEvent: REDDIT_STANDARD_EVENTS.has(event.toLowerCase()),
        providerId: String(id),
        identifiers,
        consent: null,
        revenue,
        hashParams,
      };
    },
  };

  // -------------------------------------------------------------------------
  // Registry
  // -------------------------------------------------------------------------

  const registry = [metaDetector, tiktokDetector, pinterestDetector, bingDetector, linkedinDetector, snapchatDetector, redditDetector];

  root.EcDetectors = {
    registry,
    looksHashedSha256,
    byId(id) {
      return registry.find(d => d.id === id) || null;
    },
    // Return the first enabled detector matching host + path, or null.
    // `enabled` is a map like { meta: true }.
    match(host, pathname, enabled) {
      const en = enabled || {};
      for (const d of registry) {
        if (en[d.id] && d.match(host, pathname)) return d;
      }
      return null;
    },
    // Does this host+path belong to ANY known detector, regardless of whether the
    // detector is currently enabled? Used by the capture pipeline to make sure a
    // request to a detector endpoint is never mis-handled by the Google path when
    // its detector is off — Reddit/Snapchat reuse bare em/pn param names that
    // would otherwise surface as a bogus Google "em" capture.
    matchesKnownHost(host, pathname) {
      return registry.some(d => d.match(host, pathname));
    },
    // Origins the panel needs to request/remove when a detector is toggled.
    permissionOrigins(id) {
      const d = this.byId(id);
      return d ? d.permissionOrigins.slice() : [];
    },
  };
})(typeof self !== 'undefined' ? self : this);
