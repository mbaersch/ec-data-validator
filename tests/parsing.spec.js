// Parsing in background.js / detectors.js without a browser: both scripts run in a
// vm context with a no-op chrome stub, so the capture pipeline can be fed webRequest-
// shaped details directly. Fixtures are real requests from the ectest.html playground.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const fx = require('./ectest-fixtures');

const ROOT = path.join(__dirname, '..');

function loadExtension() {
  const stub = new Proxy(function () {}, {
    get: (t, p) => (p === 'then' ? undefined : stub),
    apply: () => Promise.resolve({}),
  });
  const ctx = vm.createContext({
    chrome: stub, console, URL, URLSearchParams, TextEncoder, TextDecoder, atob, btoa,
    Response, DecompressionStream, crypto, setTimeout, clearTimeout,
  });
  ctx.self = ctx;
  ctx.importScripts = (f) => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf-8'), ctx, { filename: f });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf-8'), ctx, { filename: 'background.js' });
  vm.runInContext('state.recording = true; state.captures = [];', ctx);
  return ctx;
}

const raw = (text) => ({ raw: [{ bytes: new TextEncoder().encode(text).buffer }] });
const captures = (ctx) => vm.runInContext('state.captures', ctx);

test('GA4: currency comes from cu, the value from epn.value', () => {
  const ctx = loadExtension();
  ctx.handleRequest({ url: fx.GA4_GENERATE_LEAD, method: 'POST', timeStamp: 1, tabId: -1, requestBody: null });
  const [c] = captures(ctx);
  expect(c.conversion).toMatchObject({ eventType: 'generate_lead', value: 20, currency: 'EUR' });
  expect(c.em).toContain('tv.1~em.');
});

test('GA4: a batched POST becomes one capture per event line', () => {
  const ctx = loadExtension();
  // Shape of a real batch (analytrix.de, see the tracking-auditor-extension tests);
  // line 2 carries the conversion and user data, both of which used to be lost.
  const url = 'https://region1.google-analytics.com/g/collect?v=2&tid=G-0Z2X040Q21&gcs=G111&cid=1.2&cu=EUR';
  const body = [
    'en=page_view&_et=2340',
    'en=purchase&epn.value=49.9&ep.transaction_id=T-1&ep.user_data.sha256_email_address=' + 'a'.repeat(64),
    'en=scroll&_et=4',
  ].join('\n');
  ctx.handleRequest({ url, method: 'POST', timeStamp: 1, tabId: -1, requestBody: raw(body) });
  const cs = captures(ctx);
  expect(cs.map(c => c.conversion && c.conversion.eventType)).toEqual(['page_view', 'purchase', 'scroll']);
  expect(cs[1].conversion).toMatchObject({ value: 49.9, currency: 'EUR', orderId: 'T-1' });
  expect(cs[1].userData).toBeTruthy();
  expect(cs[0].userData).toBeNull();
});

test('LinkedIn /wa/: gzip body (fmt=g) and plain base64 body (fmt=b) both decode', async () => {
  const ctx = loadExtension();
  const li = ctx.EcDetectors.byId('linkedin');
  const gz = await li.parse({ rawBody: new TextEncoder().encode(fx.LI_WA_GZIP_BODY).buffer });
  expect(gz).toBeTruthy();
  expect(gz.identifiers[0].bucket).toBe('email');
  // fmt=b (beacon) sends the same JSON without gzip
  const json = zlib.gunzipSync(Buffer.from(fx.LI_WA_GZIP_BODY, 'base64')).toString('utf-8');
  const plain = Buffer.from(json, 'utf-8').toString('base64');
  const b = await li.parse({ rawBody: new TextEncoder().encode(plain).buffer });
  expect(b).toBeTruthy();
  expect(b.identifiers[0].bucket).toBe('email');
});
