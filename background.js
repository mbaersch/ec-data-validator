console.log('[ec-validator] background.js loaded at', new Date().toISOString());

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(err => console.error(err));

const RING_SIZE = 50;
const STATIC_PATTERNS = [
  'https://*.googleadservices.com/pagead/*',
  'https://*.googleadservices.com/ccm/*',
  'https://www.google.com/pagead/*',
  'https://www.google.com/ccm/*',
  'https://www.google-analytics.com/g/collect*',
  'https://*.google-analytics.com/g/collect*',
  'https://*.analytics.google.com/g/collect*'
];

function isStaticPattern(pattern) {
  return STATIC_PATTERNS.includes(pattern);
}

function buildListenerPatterns(grantedOrigins) {
  const custom = (grantedOrigins || []).filter(o => !isStaticPattern(o));
  return [...STATIC_PATTERNS, ...custom];
}

let state = { recording: false, captures: [], userDataIndicator: false };

function persist() {
  chrome.storage.local.set({ captureState: state });
}

const bootstrapPromise = new Promise(resolve => {
  chrome.storage.local.get('captureState', (res) => {
    if (res.captureState) {
      state.captures = Array.isArray(res.captureState.captures) ? res.captureState.captures : [];
      state.recording = !!res.captureState.recording;
      state.userDataIndicator = !!res.captureState.userDataIndicator;
    }
    resolve();
  });
});

chrome.runtime.onStartup.addListener(() => {
  state.recording = false;
  persist();
});

// Parameter keys carrying user_data fields can arrive in several shapes:
//   ep.user_data.email_address           (GA4 event-parameter, URL-encoded)
//   ep.user_data.address.first_name      (nested via dots in the key)
//   user_data.email_address              (sGTM POST body / form-encoded)
// Returns the dotted suffix as an array of path segments, or null if the key
// does not belong to user_data.
function userDataPath(key) {
  if (typeof key !== 'string') return null;
  if (key.startsWith('ep.user_data.')) return key.substring('ep.user_data.'.length).split('.');
  if (key.startsWith('user_data.'))    return key.substring('user_data.'.length).split('.');
  return null;
}

function setNested(target, path, value) {
  if (!path.length) return;
  let cur = target;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i];
    if (!cur[seg] || typeof cur[seg] !== 'object') cur[seg] = {};
    cur = cur[seg];
  }
  cur[path[path.length - 1]] = value;
}

function mergeUserDataObject(target, src) {
  if (!src || typeof src !== 'object' || Array.isArray(src)) return;
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      mergeUserDataObject(target[k], v);
    } else {
      target[k] = v;
    }
  }
}

// Keys we treat as actual user-provided identifiers. Anything else (e.g.
// `_tag_mode`, future meta fields) is ignored — a user_data block that only
// contains meta keys is treated as empty, so the capture is not flagged as
// carrying user data.
const KNOWN_USERDATA_KEYS = new Set([
  'email', 'email_address', 'sha256_email_address',
  'phone_number', 'sha256_phone_number',
  'first_name', 'sha256_first_name',
  'last_name', 'sha256_last_name',
  'street', 'sha256_street',
  'city',
  'region',
  'postal_code',
  'country'
]);

function hasKnownIdentifier(node) {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(hasKnownIdentifier);
  for (const k of Object.keys(node)) {
    if (KNOWN_USERDATA_KEYS.has(k)) return true;
    if (node[k] && typeof node[k] === 'object' && hasKnownIdentifier(node[k])) return true;
  }
  return false;
}

function extractUserData(url, body) {
  const out = {};
  let found = false;

  try {
    const u = new URL(url);
    for (const [k, v] of u.searchParams.entries()) {
      const path = userDataPath(k);
      if (path) { setNested(out, path, v); found = true; }
    }
  } catch (e) { /* ignore */ }

  if (body) {
    try {
      if (body.formData) {
        for (const k of Object.keys(body.formData)) {
          const path = userDataPath(k);
          if (!path) continue;
          const arr = body.formData[k];
          const v = Array.isArray(arr) && arr.length > 0 ? String(arr[0]) : '';
          setNested(out, path, v);
          found = true;
        }
      } else if (body.raw && body.raw.length > 0 && body.raw[0].bytes) {
        const text = new TextDecoder('utf-8').decode(body.raw[0].bytes);
        let obj = null;
        try { obj = JSON.parse(text); } catch (e) { obj = null; }
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          if (obj.user_data && typeof obj.user_data === 'object' && !Array.isArray(obj.user_data)) {
            mergeUserDataObject(out, obj.user_data);
            found = true;
          }
          for (const [k, v] of Object.entries(obj)) {
            const path = userDataPath(k);
            if (path) { setNested(out, path, v); found = true; }
          }
        } else if (!obj) {
          const params = new URLSearchParams(text);
          for (const [k, v] of params.entries()) {
            const path = userDataPath(k);
            if (path) { setNested(out, path, v); found = true; }
          }
        }
      }
    } catch (e) { /* ignore */ }
  }

  if (!found) return null;
  if (!hasKnownIdentifier(out)) return null;
  return out;
}

function extractAllParams(url, body) {
  let queryParams = {};
  let bodyParams = null;

  try {
    const u = new URL(url);
    for (const [k, v] of u.searchParams.entries()) {
      if (!(k in queryParams)) queryParams[k] = v;
    }
  } catch (e) { /* leave queryParams empty */ }

  if (body) {
    try {
      if (body.formData) {
        bodyParams = {};
        for (const k of Object.keys(body.formData)) {
          const arr = body.formData[k];
          bodyParams[k] = Array.isArray(arr) && arr.length > 0 ? String(arr[0]) : '';
        }
      } else if (body.raw && body.raw.length > 0 && body.raw[0].bytes) {
        const text = new TextDecoder('utf-8').decode(body.raw[0].bytes);
        try {
          const obj = JSON.parse(text);
          if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
            bodyParams = {};
            for (const k of Object.keys(obj)) {
              const v = obj[k];
              bodyParams[k] = (v !== null && typeof v === 'object') ? JSON.stringify(v) : String(v);
            }
          }
        } catch (e) {
          const params = new URLSearchParams(text);
          bodyParams = {};
          for (const [k, v] of params.entries()) {
            if (!(k in bodyParams)) bodyParams[k] = v;
          }
        }
      }
    } catch (e) { bodyParams = null; }
  }

  let em  = queryParams.em  || (bodyParams && bodyParams.em)  || null;
  let eme = queryParams.eme || (bodyParams && bodyParams.eme) || null;
  return { em, eme, queryParams, bodyParams };
}

const CAP_BYTES = 8192;
const VALUE_TRUNC_AT = 500;

function truncValue(v) {
  const s = String(v);
  if (s.length <= VALUE_TRUNC_AT) return s;
  return s.slice(0, VALUE_TRUNC_AT) + '...[+' + (s.length - VALUE_TRUNC_AT) + ' chars]';
}

function enforceCap(capture) {
  if (JSON.stringify(capture).length <= CAP_BYTES) return;

  // Stufe 1: nur Werte innerhalb queryParams + bodyParams kuerzen.
  for (const dictKey of ['queryParams', 'bodyParams']) {
    const dict = capture[dictKey];
    if (!dict) continue;
    for (const k of Object.keys(dict)) {
      dict[k] = truncValue(dict[k]);
    }
  }
  if (JSON.stringify(capture).length <= CAP_BYTES) return;

  // Stufe 2: bodyParams als Stub ersetzen.
  if (capture.bodyParams) {
    const orig = JSON.stringify(capture.bodyParams).length;
    capture.bodyParams = { __truncated__: true, __sizeBytes__: orig };
    capture.truncated = true;
  }
  if (JSON.stringify(capture).length <= CAP_BYTES) return;

  // Stufe 3 (selten): queryParams als Stub.
  const orig = JSON.stringify(capture.queryParams).length;
  capture.queryParams = { __truncated__: true, __sizeBytes__: orig };
  capture.truncated = true;
}

// Conversion-side parameters worth surfacing on the capture card. Sourced from
// live Ads conversion requests (/pagead/conversion/, /ccm/conversion/) — the
// param vocabulary is Ads-specific (vdnc, vdltv, delopc, …), not gtag's public
// API. Mirrored in queryParams and bodyParams so sGTM / Tag Gateway requests
// (which carry the same payload in JSON / form-encoded body) yield the same
// fields. GA4 /g/collect uses its own keys (epn.value, ep.currency) and is
// handled below.
const ADS_ITEM_RE = /\(([^)]*)\)/g;

function parseAdsItems(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  const items = [];
  let m;
  ADS_ITEM_RE.lastIndex = 0;
  while ((m = ADS_ITEM_RE.exec(raw)) !== null) {
    const parts = m[1].split('*');
    const priceStr = parts[0];
    const qtyStr   = parts[1];
    const sku      = parts[2];
    const item = {};
    if (priceStr !== undefined && priceStr !== '') {
      const n = Number(priceStr);
      if (!Number.isNaN(n)) item.price = n;
    }
    if (qtyStr !== undefined && qtyStr !== '') {
      const n = Number(qtyStr);
      if (!Number.isNaN(n)) item.qty = n;
    }
    if (sku !== undefined && sku !== '') item.sku = sku;
    if (Object.keys(item).length > 0) items.push(item);
  }
  return items.length > 0 ? items : null;
}

function numOrNull(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

function boolOrNull(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).toLowerCase();
  if (s === 'true')  return true;
  if (s === 'false') return false;
  return null;
}

// Google Consent Signal — encodes per-purpose consent state. Shape "G1AB[CD]":
//   position 2 = ad_storage, position 3 = analytics_storage
//   '0' denied, '1' granted, '-' unset. Higher positions (ad_user_data,
//   ad_personalization) exist on newer payloads but are not surfaced here —
//   the user only asked for the ad_storage signal, which is enough to explain
//   the 99% case of "request went out without identifiers". The full raw value
//   is preserved so the detail modal can show it verbatim.
function parseGcs(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!/^G1[01-][01-]/.test(s)) return null;
  const map = { '0': 'denied', '1': 'granted', '-': 'unset' };
  return {
    adStorage:        map[s[2]] || null,
    analyticsStorage: map[s[3]] || null,
    raw: s
  };
}

// gcd carries per-purpose consent state (default, update, manual overrides) for
// up to four purposes: ad_storage, analytics_storage, ad_user_data,
// ad_personalization. The letter codes below mirror the user's GCD bookmarklet
// — lowercase = automatic, uppercase = manually set via the Consent Mode API.
// `updated` tracks whether the purpose received a Consent Mode update beyond
// the initial default. Renderers use this to suppress the green/red status
// color when an update happened — the prior state (default) is no longer
// meaningful in that case, so neutral text is more honest than colouring
// either side of the transition.
const GCD_LETTER_MAP = {
  l: { text: 'not set',                    state: 'unset',   updated: false, manual: false },
  p: { text: 'denied (default)',           state: 'denied',  updated: false, manual: false },
  q: { text: 'denied (default + update)',  state: 'denied',  updated: true,  manual: false },
  t: { text: 'granted (default)',          state: 'granted', updated: false, manual: false },
  r: { text: 'denied → granted',           state: 'granted', updated: true,  manual: false },
  m: { text: 'denied (update)',            state: 'denied',  updated: true,  manual: false },
  n: { text: 'granted (update)',           state: 'granted', updated: true,  manual: false },
  u: { text: 'granted → denied',           state: 'denied',  updated: true,  manual: false },
  v: { text: 'granted (default + update)', state: 'granted', updated: true,  manual: false },
  L: { text: 'not set',                    state: 'unset',   updated: false, manual: true  },
  P: { text: 'granted (default + update)', state: 'granted', updated: true,  manual: true  },
  Q: { text: 'denied + update',            state: 'denied',  updated: true,  manual: true  },
  T: { text: 'granted',                    state: 'granted', updated: false, manual: true  },
  R: { text: 'denied → granted',           state: 'granted', updated: true,  manual: true  },
  M: { text: 'denied (update)',            state: 'denied',  updated: true,  manual: true  },
  N: { text: 'granted (update)',           state: 'granted', updated: true,  manual: true  },
  U: { text: 'granted → denied',           state: 'denied',  updated: true,  manual: true  },
  V: { text: 'granted (default + update)', state: 'granted', updated: true,  manual: true  }
};
const GCD_PURPOSES = ['ad_storage', 'analytics_storage', 'ad_user_data', 'ad_personalization'];

function parseGcd(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!/^1[13]/.test(s)) return null;
  const letters = [];
  const re = /[a-zA-Z]/g;
  let m;
  while ((m = re.exec(s)) !== null) letters.push(m[0]);
  if (letters.length === 0) return null;
  return GCD_PURPOSES.map((purpose, i) => {
    const letter = letters[i] || null;
    const info = letter ? GCD_LETTER_MAP[letter] : null;
    return {
      purpose,
      letter,
      text:    info ? info.text    : (letter ? 'unknown' : 'absent'),
      state:   info ? info.state   : null,
      updated: info ? info.updated : false,
      manual:  info ? info.manual  : false
    };
  });
}

function extractConversionData(queryParams, bodyParams, pathname) {
  const all = Object.assign({}, queryParams || {}, bodyParams || {});
  const isAds = /\/(pagead|ccm)\/conversion\//.test(pathname);
  const isGa  = (pathname || '').includes('/g/collect');
  if (!isAds && !isGa) return null;

  const out = {};

  if (isAds) {
    const value = numOrNull(all.value);
    if (value !== null) out.value = value;
    if (all.currency_code) out.currency = String(all.currency_code);
    if (all.bttype)        out.eventType = String(all.bttype);
    if (all.oid)           out.orderId   = String(all.oid);

    const items = parseAdsItems(all.item);
    if (items) out.items = items;

    const newCust = boolOrNull(all.vdnc);
    if (newCust !== null) out.newCustomer = newCust;

    const ltv = numOrNull(all.vdltv);
    if (ltv !== null) out.ltv = ltv;

    const discount = numOrNull(all.dscnt);
    if (discount !== null) out.discount = discount;

    if (all.mid)   out.merchantId    = String(all.mid);
    if (all.fcntr) out.feedCountry   = String(all.fcntr);
    if (all.flng)  out.feedLanguage  = String(all.flng);

    const shipCost = numOrNull(all.shf);
    if (shipCost !== null) out.shipCost = shipCost;
    if (all.delc)   out.shipCountry    = String(all.delc);
    if (all.delopc) out.shipPostalCode = String(all.delopc);
    if (all.oedeld) out.estDeliveryDate = String(all.oedeld);
  }

  if (isGa) {
    const value = numOrNull(all['epn.value']) ?? numOrNull(all['ep.value']);
    if (value !== null) out.value = value;
    if (all['ep.currency']) out.currency = String(all['ep.currency']);
    if (all.en) out.eventType = String(all.en);
    if (all['ep.transaction_id']) out.orderId = String(all['ep.transaction_id']);
    let itemCount = 0;
    for (const k of Object.keys(all)) {
      if (/^pr\d+$/.test(k)) itemCount++;
    }
    if (itemCount > 0) out.itemCount = itemCount;
  }

  return Object.keys(out).length > 0 ? out : null;
}

function isGoogleHost(host) {
  const h = (host || '').toLowerCase();
  return h.endsWith('googleadservices.com')
      || h === 'www.google.com'
      || h.endsWith('google-analytics.com')
      || h.endsWith('analytics.google.com');
}

// Requests, deren initiierender Tab eine Google-eigene UI ist (GA4-, Ads-,
// GTM-, Tag-Assistant-UI), gehoeren nicht zur zu testenden Website und
// werden komplett ignoriert.
const INITIATOR_BLOCKLIST_HOSTS = new Set([
  'analytics.google.com',
  'ads.google.com',
  'tagmanager.google.com',
  'tagassistant.google.com'
]);

function isBlockedInitiator(initiator) {
  if (!initiator) return false;
  try {
    const h = new URL(initiator).host.toLowerCase();
    return INITIATOR_BLOCKLIST_HOSTS.has(h);
  } catch (e) {
    return false;
  }
}

function classifySource(host, pathname) {
  if (pathname && pathname.includes('/g/collect')) return 'ga';
  if (pathname && (pathname.includes('/ccm/') || pathname.includes('/pagead/'))) return 'ads';
  const h = (host || '').toLowerCase();
  if (h.endsWith('google-analytics.com') || h.endsWith('analytics.google.com')) return 'ga';
  return 'ads';
}

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => { /* no listeners — ignore */ });
}

// Toolbar-Indicator: which marker is "stronger" — `ud` (full user_data object)
// wins over `eme` (decoded enhanced match) wins over `em` (hashed only).
// Badge upgrades only — a weaker marker arriving later never downgrades the
// current pill, so the displayed value reflects the strongest signal seen on
// the tab since the last navigation. Colors mirror the capture-card pills
// (popup.html .identifier-em / .identifier-eme / .source-userdata) so the
// toolbar uses the same visual vocabulary as the recording UI.
const BADGE_RANK  = { em: 1, eme: 2, ud: 3 };
const BADGE_COLOR = { em: '#1e40af', eme: '#92400e', ud: '#475569' };

function badgeMarker(em, eme, userData) {
  if (userData) return 'ud';
  if (eme) return 'eme';
  if (em) return 'em';
  return null;
}

function maybeUpgradeBadge(tabId, marker) {
  chrome.action.getBadgeText({ tabId }, (current) => {
    const currentRank = BADGE_RANK[current] || 0;
    const newRank = BADGE_RANK[marker] || 0;
    if (newRank <= currentRank) return;
    chrome.action.setBadgeText({ tabId, text: marker });
    chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR[marker] });
  });
}

function clearAllBadges() {
  chrome.tabs.query({}, (tabs) => {
    for (const t of tabs) {
      if (typeof t.id === 'number' && t.id >= 0) {
        chrome.action.setBadgeText({ tabId: t.id, text: '' });
      }
    }
  });
}

function handleRequest(details) {
  if (!state.recording && !state.userDataIndicator) return;
  if (isBlockedInitiator(details.initiator)) return;

  let host = '', pathname = '';
  try {
    const u = new URL(details.url);
    host = u.host;
    pathname = u.pathname;
  } catch (e) { return; }

  const transport = isGoogleHost(host) ? 'google' : 'first-party';

  const { em, eme, queryParams, bodyParams } = extractAllParams(details.url, details.requestBody);
  const userData = extractUserData(details.url, details.requestBody);
  const conversion = extractConversionData(queryParams, bodyParams, pathname);

  const gcsRaw = (queryParams && queryParams.gcs) || (bodyParams && bodyParams.gcs) || null;
  const gcdRaw = (queryParams && queryParams.gcd) || (bodyParams && bodyParams.gcd) || null;
  const gcsParsed = parseGcs(gcsRaw);
  const gcdParsed = parseGcd(gcdRaw);
  const consent = (gcsParsed || gcdParsed || gcsRaw || gcdRaw) ? {
    adStorage:        gcsParsed ? gcsParsed.adStorage : null,
    analyticsStorage: gcsParsed ? gcsParsed.analyticsStorage : null,
    gcs:              gcsParsed ? gcsParsed.raw : (gcsRaw || null),
    gcd:              gcdRaw,
    gcdDecoded:       gcdParsed
  } : null;

  // Indicator runs independently of recording, but only for built-in Google
  // endpoints — first-party transports (Tag Gateway / sGTM) are intentionally
  // excluded so the always-on path never touches user-granted origins.
  if (state.userDataIndicator && transport === 'google' && typeof details.tabId === 'number' && details.tabId >= 0) {
    const marker = badgeMarker(em, eme, userData);
    if (marker) maybeUpgradeBadge(details.tabId, marker);
  }

  if (!state.recording) return;

  if (transport === 'first-party') {
    const hasPathMarker = /\/(ccm|pagead|g\/collect)(\/|$)/.test(pathname);
    if (!hasPathMarker && !em && !eme && !userData) return;
  }

  const source = classifySource(host, pathname);

  const capture = {
    ts: details.timeStamp,
    url: details.url,
    host,
    method: details.method,
    em,
    eme,
    userData,
    conversion,
    consent,
    queryParams,
    bodyParams,
    truncated: false,
    source,
    transport
  };
  enforceCap(capture);
  state.captures.push(capture);
  if (state.captures.length > RING_SIZE) {
    state.captures = state.captures.slice(-RING_SIZE);
  }
  persist();
  broadcast({ type: 'captureAdded', capture, count: state.captures.length });
}

let activeListener = null;

async function refreshListener() {
  if (activeListener) {
    try { chrome.webRequest.onBeforeRequest.removeListener(activeListener); } catch (e) {}
  }
  const perms = await new Promise(resolve => chrome.permissions.getAll(p => resolve(p || { origins: [] })));
  const patterns = buildListenerPatterns(perms.origins || []);
  activeListener = handleRequest;
  try {
    chrome.webRequest.onBeforeRequest.addListener(
      activeListener, { urls: patterns }, ['requestBody']
    );
  } catch (e) {
    console.error('[ec-validator] failed to register listener:', e, patterns);
  }
}

chrome.permissions.onAdded.addListener(refreshListener);
chrome.permissions.onRemoved.addListener(refreshListener);
chrome.runtime.onInstalled.addListener(refreshListener);
chrome.runtime.onStartup.addListener(refreshListener);

refreshListener();

// SPA-aware reset: chrome.tabs.onUpdated fires with changeInfo.url for both
// full navigations and history.pushState/replaceState, so a single listener
// covers classic and SPA flows without needing the webNavigation permission.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url === undefined) return;
  chrome.action.setBadgeText({ tabId, text: '' });
});

// Side-panel lifecycle: each opened panel connects via a long-lived port.
// When the port disconnects (panel closed) and the panel has the auto-stop
// option enabled, we stop recording. The option is communicated through the
// port so the SW does not need to read it from storage on every disconnect.
const panelPorts = new Map(); // port -> { autoStop: boolean }

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'panel') return;
  panelPorts.set(port, { autoStop: true });
  port.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'panelOption') return;
    const entry = panelPorts.get(port);
    if (entry) entry.autoStop = !!msg.autoStop;
  });
  port.onDisconnect.addListener(() => {
    const entry = panelPorts.get(port);
    panelPorts.delete(port);
    if (!entry || !entry.autoStop) return;
    if (!state.recording) return;
    state.recording = false;
    persist();
    broadcast({ type: 'stateChanged', recording: false });
  });
});

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (!msg || !msg.type) return;
  bootstrapPromise.then(() => {
    if (msg.type === 'getState') {
      respond({ recording: state.recording, captures: state.captures, ringSize: RING_SIZE });
    } else if (msg.type === 'startRecording') {
      state.recording = true;
      persist();
      broadcast({ type: 'stateChanged', recording: true });
      respond({ ok: true });
    } else if (msg.type === 'stopRecording') {
      state.recording = false;
      persist();
      broadcast({ type: 'stateChanged', recording: false });
      respond({ ok: true });
    } else if (msg.type === 'clearCaptures') {
      state.captures = [];
      persist();
      broadcast({ type: 'capturesCleared' });
      respond({ ok: true });
    } else if (msg.type === 'setIndicator') {
      const enabled = !!msg.enabled;
      state.userDataIndicator = enabled;
      persist();
      if (!enabled) clearAllBadges();
      respond({ ok: true });
    }
  });
  return true;
});

// ---------------------------------------------------------------------------
// Debug / diagnostic helpers — exposed on globalThis for the SW console.
// Not used by the side-panel UI; production paths go through chrome.runtime
// messaging. Useful when triaging issues. Start with checkSetup() / recordingStatus().
// ---------------------------------------------------------------------------

globalThis.recordingStatus = () => ({
  recording: state.recording,
  count: state.captures.length,
  ringSize: RING_SIZE
});

globalThis.getCaptures = () => {
  console.table(state.captures.map(c => ({
    ts: new Date(c.ts).toLocaleTimeString(),
    method: c.method,
    host: c.host,
    em: c.em ? (c.em.length > 60 ? c.em.slice(0, 60) + '…' : c.em) : '(none)'
  })));
  return state.captures;
};

globalThis.checkSetup = async () => {
  const perms = await chrome.permissions.getAll();
  const info = {
    swLoaded: true,
    listenerRegistered: chrome.webRequest.onBeforeRequest.hasListeners(),
    recording: state.recording,
    captureCount: state.captures.length,
    permissions: perms.permissions,
    origins: perms.origins,
    targetPatterns: STATIC_PATTERNS
  };
  console.log('[ec-validator] checkSetup:', info);
  return info;
};

globalThis.listOrigins = async () => {
  const perms = await chrome.permissions.getAll();
  console.log('[ec-validator] current origins:', perms.origins);
  return perms.origins;
};

globalThis.revokeOrigin = (origin) => {
  chrome.permissions.remove({ origins: [origin] }, (removed) => {
    console.log('[ec-validator] permission for', origin, removed ? 'REVOKED' : 'NOT REVOKED');
  });
};

globalThis.revokeAllOptionalOrigins = async () => {
  const perms = await chrome.permissions.getAll();
  const staticSet = new Set(STATIC_PATTERNS);
  const toRemove = (perms.origins || []).filter(o => !staticSet.has(o));
  if (toRemove.length === 0) {
    console.log('[ec-validator] no optional origins to revoke');
    return;
  }
  chrome.permissions.remove({ origins: toRemove }, (removed) => {
    console.log('[ec-validator] revoked optional origins:', toRemove, removed);
  });
};

// Diagnostic: temporary listener that logs every matched request for 30s,
// regardless of recording state. Useful when patterns or permissions look off.
globalThis.lightTest = () => {
  const cb = (d) => console.log('[ec-validator] LIGHT:', d.type, d.method, d.url);
  chrome.webRequest.onBeforeRequest.addListener(cb, { urls: STATIC_PATTERNS });
  console.log('[ec-validator] light test active for 30s — fire a conversion now');
  setTimeout(() => {
    chrome.webRequest.onBeforeRequest.removeListener(cb);
    console.log('[ec-validator] light test ended');
  }, 30000);
};
