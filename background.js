console.log('[ec-validator] background.js loaded at', new Date().toISOString());

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(err => console.error(err));

const RING_SIZE = 50;
const TARGET_PATTERNS = [
  'https://*.googleadservices.com/pagead/*',
  'https://*.googleadservices.com/ccm/*',
  'https://www.google.com/pagead/*',
  'https://www.google.com/ccm/*'
];

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

function extractEM(url, body) {
  try {
    const u = new URL(url);
    const em = u.searchParams.get('em');
    if (em) return em;
  } catch (e) {}
  if (body) {
    if (body.formData && body.formData.em && body.formData.em.length > 0) {
      return body.formData.em[0];
    }
    if (body.raw && body.raw.length > 0 && body.raw[0].bytes) {
      try {
        const text = new TextDecoder('utf-8').decode(body.raw[0].bytes);
        const params = new URLSearchParams(text);
        const em = params.get('em');
        if (em) return em;
        try {
          const obj = JSON.parse(text);
          if (obj && typeof obj.em === 'string') return obj.em;
        } catch (e) {}
      } catch (e) {}
    }
  }
  return null;
}

function broadcast(msg) {
  chrome.runtime.sendMessage(msg).catch(() => { /* no listeners — ignore */ });
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!state.recording) return;
    const em = extractEM(details.url, details.requestBody);
    let host = '';
    try { host = new URL(details.url).host; } catch (e) {}
    const capture = {
      ts: details.timeStamp,
      url: details.url,
      host: host,
      method: details.method,
      em: em
    };
    state.captures.push(capture);
    if (state.captures.length > RING_SIZE) {
      state.captures = state.captures.slice(-RING_SIZE);
    }
    persist();
    broadcast({ type: 'captureAdded', capture: capture, count: state.captures.length });
  },
  { urls: TARGET_PATTERNS },
  ['requestBody']
);

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
    targetPatterns: TARGET_PATTERNS
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
  const staticOrigins = new Set([
    'https://*.googleadservices.com/pagead/*',
    'https://*.googleadservices.com/ccm/*',
    'https://www.google.com/pagead/*',
    'https://www.google.com/ccm/*'
  ]);
  const toRemove = perms.origins.filter(o => !staticOrigins.has(o));
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
  chrome.webRequest.onBeforeRequest.addListener(cb, { urls: TARGET_PATTERNS });
  console.log('[ec-validator] light test active for 30s — fire a conversion now');
  setTimeout(() => {
    chrome.webRequest.onBeforeRequest.removeListener(cb);
    console.log('[ec-validator] light test ended');
  }, 30000);
};
