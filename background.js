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

let state = { recording: false, captures: [] };

function persist() {
  chrome.storage.local.set({ captureState: state });
}

const bootstrapPromise = new Promise(resolve => {
  chrome.storage.local.get('captureState', (res) => {
    if (res.captureState) {
      state.captures = Array.isArray(res.captureState.captures) ? res.captureState.captures : [];
      state.recording = !!res.captureState.recording;
    }
    resolve();
  });
});

chrome.runtime.onStartup.addListener(() => {
  state.recording = false;
  persist();
});

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

function handleRequest(details) {
  if (!state.recording) return;

  let host = '', pathname = '';
  try {
    const u = new URL(details.url);
    host = u.host;
    pathname = u.pathname;
  } catch (e) { return; }

  const transport = isGoogleHost(host) ? 'google' : 'first-party';

  const { em, eme, queryParams, bodyParams } = extractAllParams(details.url, details.requestBody);

  if (transport === 'first-party') {
    const hasPathMarker = /\/(ccm|pagead|g\/collect)(\/|$)/.test(pathname);
    if (!hasPathMarker && !em && !eme) return;
  }

  const source = classifySource(host, pathname);

  const capture = {
    ts: details.timeStamp,
    url: details.url,
    host,
    method: details.method,
    em,
    eme,
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
