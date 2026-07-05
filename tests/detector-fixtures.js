// Synthetic detector captures for the screenshot harness. These mirror exactly
// what background.js's handleDetectorRequest stores (see the capture object
// there), so the panel renders them like real ones. Hashes are real: the email
// hash is SHA-256("mail@markus-baersch.de"), so the validation flow produces a
// genuine MATCH when that address is entered.
const crypto = require('crypto');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

const EMAIL = 'mail@markus-baersch.de';
const emHash = sha256(EMAIL.toLowerCase());        // 8d9b70fd… — same across all providers
const phMeta = sha256('4917612345678');            // Meta/Pinterest: digits, no '+'
const phE164 = sha256('+4917612345678');           // TikTok/Bing: E.164 with '+'
const fnHash = sha256('markus');
const lnHash = sha256('baersch');
const extId  = sha256('crm-88134');                // opaque advertiser id (hashed variant)
const ageHash = sha256('42');                      // Snapchat hashes the age too
const cityHash = sha256('berlin');                 // Snapchat hashes geo (l_city)

// One identifier slot in the shape parse() emits.
function idf(field, bucket, over) {
  return Object.assign(
    { field, bucket, label: bucket, hashed: true, plaintext: false, masked: false, mask: null },
    over || {}
  );
}

// A detector capture with all the Google-shaped fields nulled out, matching
// handleDetectorRequest's object.
function cap(over) {
  return Object.assign({
    ts: 0, url: '', host: '', method: 'POST',
    provider: null, source: null, transport: 'standard',
    event: null, providerId: null, identifiers: [],
    detectorConsent: null, detectorRevenue: null, detectorParams: null,
    em: null, eme: null, userData: null, conversion: null, consent: null,
    queryParams: {}, bodyParams: {}, truncated: false, customLoader: null, decodedUrl: null
  }, over);
}

// Spaced timestamps (newest last; the panel shows newest first).
const t0 = Date.UTC(2026, 6, 4, 16, 51, 0);
const ts = (i) => t0 + i * 37000;

const CAPTURES = [
  // Meta — clean Purchase with the full advanced-matching set + opaque external_id.
  cap({
    ts: ts(0), method: 'POST',
    url: 'https://www.facebook.com/tr/', host: 'www.facebook.com',
    provider: 'meta', source: 'meta', event: 'Purchase', providerId: '1004723150984266',
    identifiers: [
      idf('em', 'email'), idf('ph', 'phone'), idf('fn', 'firstName'), idf('ln', 'lastName'),
      idf('external_id', 'externalId', { opaque: true }),
    ],
    detectorParams: { 'ud[em]': emHash, 'ud[ph]': phMeta, 'ud[fn]': fnHash, 'ud[ln]': lnHash, 'cd[external_id]': extId },
  }),

  // TikTok — email + phone hashed.
  cap({
    ts: ts(1),
    url: 'https://analytics.tiktok.com/api/v2/pixel', host: 'analytics.tiktok.com',
    provider: 'tiktok', source: 'tiktok', event: 'CompletePayment', providerId: 'CABC1D2E3F4G5H6I7J8K',
    identifiers: [idf('email', 'email'), idf('phone', 'phone')],
    detectorParams: { 'user[email]': emHash, 'user[phone]': phE164 },
  }),

  // Pinterest — single hashed email.
  cap({
    ts: ts(2),
    url: 'https://ct.pinterest.com/v3/', host: 'ct.pinterest.com',
    provider: 'pinterest', source: 'pinterest', event: 'checkout', providerId: '2613570657899',
    identifiers: [idf('em', 'email')],
    detectorParams: { 'pd[em]': emHash },
  }),

  // Bing UET — purchase surfaced as such, with the conversion value pill.
  cap({
    ts: ts(3), method: 'GET',
    url: 'https://bat.bing.com/action/0', host: 'bat.bing.com',
    provider: 'bing', source: 'bing', event: 'purchase', providerId: '111111111111',
    detectorRevenue: { value: '44', currency: 'EUR' },
    identifiers: [idf('em', 'email'), idf('ph', 'phone')],
    detectorParams: { evt: 'custom', 'pid[em]': emHash, 'pid[ph]': phE164 },
  }),

  // LinkedIn — hashed email (hem) from the decoded /wa/ POST, on a CLICK signal.
  cap({
    ts: ts(4),
    url: 'https://px.ads.linkedin.com/wa/', host: 'px.ads.linkedin.com',
    provider: 'linkedin', source: 'linkedin', event: 'CLICK', providerId: '512345',
    identifiers: [idf('hem', 'email')],
    detectorParams: { 'li[hem]': emHash, event: 'CLICK' },
  }),

  // Snapchat — GET /p event hashing email, phone (no +), name, age and geo.
  cap({
    ts: ts(5), method: 'GET',
    url: 'https://tr.snapchat.com/p', host: 'tr.snapchat.com',
    provider: 'snapchat', source: 'snapchat', event: 'PURCHASE',
    providerId: 'a1b2c3d4-0000-1111-2222-333344445555',
    detectorRevenue: { value: '44.90', currency: 'EUR' },
    identifiers: [
      idf('u_hem', 'email'), idf('u_hpn', 'phone'), idf('u_fn', 'firstName'),
      idf('u_age', 'age'), idf('l_city', 'city'),
    ],
    detectorParams: {
      event: 'PURCHASE',
      'snap[u_hem]': emHash, 'snap[u_hpn]': phMeta, 'snap[u_fn]': fnHash,
      'snap[u_age]': ageHash, 'snap[l_city]': cityHash,
    },
  }),

  // Reddit — rp.gif Purchase with manual em/pn, auto-collected emails and a
  // comma-decimal conversion value.
  cap({
    ts: ts(6), method: 'GET',
    url: 'https://alb.reddit.com/rp.gif', host: 'alb.reddit.com',
    provider: 'reddit', source: 'reddit', event: 'Purchase', providerId: 'a2_abc123',
    detectorRevenue: { value: '12,55', currency: 'EUR' },
    identifiers: [
      idf('em', 'email'), idf('pn', 'phone'),
      idf('auto_em', 'email', { label: 'Auto email ×2' }),
      idf('external_id', 'externalId', { opaque: true }),
    ],
    detectorParams: { event: 'Purchase', 'rdt[em]': emHash, 'rdt[pn]': phE164, 'rdt[external_id]': extId },
  }),

  // Meta — a PageView leaking the email UNHASHED: the red "raw" pill, the whole
  // point of the tool.
  cap({
    ts: ts(7),
    url: 'https://www.facebook.com/tr/', host: 'www.facebook.com',
    provider: 'meta', source: 'meta', event: 'PageView', providerId: '1004723150984266',
    identifiers: [idf('em', 'email', { hashed: false, plaintext: true })],
    detectorParams: { 'ud[em]': EMAIL },
  }),
];

module.exports = { CAPTURES, EMAIL };
