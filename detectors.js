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
        country: { verifyId: 'v_country', label: 'Country',    normalize: normCountry }
      },
      labels: { ge: 'Gender', db: 'Date of birth', external_id: 'External ID' }
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
  // Registry
  // -------------------------------------------------------------------------

  const registry = [metaDetector];

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
