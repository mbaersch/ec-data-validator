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
  // phone in E.164: keep a leading '+', map a leading '00' intl prefix to '+',
  // strip everything else non-digit. Used by providers that hash the '+' form
  // (TikTok, Google) — unlike Meta, which hashes digits only without the '+'.
  function normPhoneE164(v) {
    const c = String(v).replace(/[^\d+]/g, '');
    if (c.startsWith('+')) return '+' + c.slice(1).replace(/\+/g, '');
    const d = c.replace(/\+/g, '');
    return d.startsWith('00') ? '+' + d.slice(2) : d;
  }

  // UTF-8-safe base64 decode (for the base64-in-querystring GET transport).
  // atob + TextDecoder both exist in the service worker and the panel.
  function decodeBase64Utf8(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8').decode(bytes);
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
    const consider = (params) => {
      for (const k of Object.keys(params || {})) {
        const m = META_UD_KEY_RE.exec(k);
        if (!m) continue;
        const rep = m[1], key = m[2];
        const def = META_FIELD[key];
        if (!def) continue; // unknown advanced-matching subfield
        const v = params[k];
        const f = fields[key] || (fields[key] = {
          field: key, bucket: def.bucket, label: def.label,
          hashed: false, plaintext: false, masked: false, mask: null,
        });
        if (rep === 'ud' || rep === 'udff' || rep === 'aud') {
          if (looksHashedSha256(v)) f.hashed = true;
          else if (v != null && String(v).trim() !== '') f.plaintext = true;
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
        identifiers.push({
          field: k, bucket: def.bucket, label: def.label,
          hashed, plaintext: !hashed, masked: false, mask: null,
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
  // Registry
  // -------------------------------------------------------------------------

  const registry = [metaDetector, tiktokDetector];

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
    // Origins the panel needs to request/remove when a detector is toggled.
    permissionOrigins(id) {
      const d = this.byId(id);
      return d ? d.permissionOrigins.slice() : [];
    },
  };
})(typeof self !== 'undefined' ? self : this);
