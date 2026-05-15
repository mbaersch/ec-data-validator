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
