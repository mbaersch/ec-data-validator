const { test, expect, chromium } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const fixtures = require('./fixtures.js');
const detectorFixtures = require('./detector-fixtures.js');

const EXTENSION_PATH = path.resolve(__dirname, '..');
const USER_DATA_DIR = path.resolve(__dirname, '..', 'tmp-user-data-test');

let context;
let extensionId;

test.beforeAll(async () => {
  if (fs.existsSync(USER_DATA_DIR)) {
    fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
  }
  context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`
    ]
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  extensionId = worker.url().split('/')[2];
});

test.afterAll(async () => {
  if (context) await context.close();
});

async function openPopup() {
  const page = await context.newPage();
  await page.addInitScript(() => {
    if (window.chrome && !window.chrome.sidePanel) {
      window.chrome.sidePanel = { setPanelBehavior: () => Promise.resolve() };
    }
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.waitForSelector('.tabs .tab.active');
  return { page, errors };
}

async function activateTab(page, targetId) {
  await page.click(`.tab[data-target="${targetId}"]`);
  await page.waitForSelector(`#${targetId}.content.active`);
}

test('1. Smoke: popup loads without errors and both tabs are clickable', async () => {
  const { page, errors } = await openPopup();
  await expect(page.locator('.tab[data-target="tab-em"]')).toBeVisible();
  await expect(page.locator('.tab[data-target="tab-obj"]')).toBeVisible();

  await activateTab(page, 'tab-obj');
  await expect(page.locator('#tab-obj.content.active')).toBeVisible();

  await activateTab(page, 'tab-em');
  await expect(page.locator('#tab-em.content.active')).toBeVisible();

  expect(errors).toEqual([]);
  await page.close();
});

async function pasteUserData(page, jsLiteral) {
  await activateTab(page, 'tab-obj');
  await page.fill('#objInput', jsLiteral);
  await page.dispatchEvent('#objInput', 'input');
  await page.waitForTimeout(300);
}

async function fillVerification(page, fieldId, value) {
  await page.waitForSelector(`#${fieldId}`, { state: 'visible' });
  await page.fill(`#${fieldId}`, value);
  await page.dispatchEvent(`#${fieldId}`, 'input');
  await page.waitForTimeout(300);
}

test('2. Email match: Gmail hash matches plaintext with dots/+alias/capitals', async () => {
  const { page } = await openPopup();
  await pasteUserData(page, fixtures.USER_DATA_FULL_JS);
  await fillVerification(page, 'v_email', fixtures.HASHES.emailGmail.raw);
  await expect(page.locator('#objResult .match').first()).toBeVisible();
  await page.close();
});

test('3. Email no-match: wrong plaintext yields no-match badge', async () => {
  const { page } = await openPopup();
  await pasteUserData(page, fixtures.USER_DATA_FULL_JS);
  await fillVerification(page, 'v_email', fixtures.HASHES.emailNonGmail.raw);
  await expect(page.locator('#objResult .no-match').first()).toBeVisible();
  await page.close();
});

test('4. Gmail normalization: dots and +alias are stripped before hashing', async () => {
  const { page } = await openPopup();
  await pasteUserData(page, fixtures.USER_DATA_FULL_JS);
  await fillVerification(page, 'v_email', 'mbaersch@gmail.com');
  await expect(page.locator('#objResult .match').first()).toBeVisible();
  await page.close();
});

test('5. Non-Gmail: dots and +alias are kept (no Gmail normalization)', async () => {
  const { page } = await openPopup();
  await pasteUserData(page, fixtures.USER_DATA_NON_GMAIL_JS);
  await fillVerification(page, 'v_email', fixtures.HASHES.emailNonGmail.raw);
  await expect(page.locator('#objResult .match').first()).toBeVisible();
  await page.close();
});

test('6. Phone match: formatted plaintext matches E.164 hash', async () => {
  const { page } = await openPopup();
  await pasteUserData(page, fixtures.USER_DATA_FULL_JS);
  await fillVerification(page, 'v_phone', '+49 123 456 789');
  await expect(
    page.locator('#objResult tr', { has: page.locator('b', { hasText: 'sha256_phone_number' }) })
        .locator('.match')
  ).toBeVisible();
  await page.close();
});

test('6b. Phone meta-only: hash without leading + shows META ONLY warning', async () => {
  const { page } = await openPopup();
  await pasteUserData(page, fixtures.USER_DATA_PHONE_META_JS);
  await fillVerification(page, 'v_phone', '+49123456789');
  await expect(page.locator('#objResult .fmt-warn', { hasText: 'META ONLY' })).toBeVisible();
  await page.close();
});

test('7. Encoding hex: pill enc-hex visible for hex hash', async () => {
  const { page } = await openPopup();
  await pasteUserData(page, fixtures.USER_DATA_FULL_JS);
  await expect(page.locator('#objResult .enc-hex').first()).toBeVisible();
  await page.close();
});

test('8. Encoding b64url: pill enc-b64url visible for base64url hash', async () => {
  const { page } = await openPopup();
  await pasteUserData(page, fixtures.USER_DATA_B64URL_JS);
  await expect(page.locator('#objResult .enc-b64url').first()).toBeVisible();
  await page.close();
});

test('9. Format warning: plaintext in sha256_email_address triggers fmt-warn', async () => {
  const { page } = await openPopup();
  await pasteUserData(page, fixtures.USER_DATA_PLAINTEXT_EMAIL_JS);
  const resultHtml = await page.locator('#objResult').innerHTML();
  expect(resultHtml.toLowerCase()).toMatch(/fmt-warn|format|invalid|not.*hash|plaintext/);
  await page.close();
});

test('10. Compliance min-req: missing em/pn/name triggers minimum-requirements alert', async () => {
  const { page } = await openPopup();
  await pasteUserData(page, fixtures.USER_DATA_EMPTY_JS);
  const resultHtml = await page.locator('#objResult').innerHTML();
  expect(resultHtml.toLowerCase()).toMatch(/minimum|insufficient|missing|required|incomplete/);
  await page.close();
});

test('11. Misplaced address field: city outside address block triggers structure error', async () => {
  const { page } = await openPopup();
  await pasteUserData(page, fixtures.USER_DATA_MISPLACED_JS);
  const resultHtml = await page.locator('#objResult').innerHTML();
  expect(resultHtml.toLowerCase()).toMatch(/misplaced|outside|structure|wrong place|nesting/);
  await page.close();
});

test('12. Country warning: full country name instead of ISO code triggers warning', async () => {
  const { page } = await openPopup();
  await pasteUserData(page, fixtures.USER_DATA_COUNTRY_WARN_JS);
  const resultHtml = await page.locator('#objResult').innerHTML();
  expect(resultHtml.toLowerCase()).toMatch(/country|iso|two[- ]?letter|code/);
  await page.close();
});

test('13. eme paste: encrypted banner appears, verify block stays hidden', async () => {
  const { page, errors } = await openPopup();
  await activateTab(page, 'tab-em');
  await page.fill('#emInput', fixtures.EME_TOKEN_WITH_PREFIX);
  await page.dispatchEvent('#emInput', 'input');
  await page.waitForTimeout(300);

  await expect(page.locator('.enc-banner')).toBeVisible();
  await expect(page.locator('#vBox')).toHaveClass(/hidden/);

  const resultHtml = await page.locator('#emResult').innerHTML();
  expect(resultHtml.toLowerCase()).toMatch(/encrypted/);

  expect(errors).toEqual([]);
  await page.close();
});

test('14. Service filter bar shows on load when a detector is enabled', async () => {
  const { page } = await openPopup();
  // Pretend the Meta host permission is granted (so the toggle reconciliation
  // keeps the flag on) and persist the enabled flag, then reload so the panel's
  // init reads both. This reproduces "detector on, panel opened" — the bar must
  // be visible right after load, not only after a later re-render.
  await page.addInitScript(() => {
    if (window.chrome && window.chrome.permissions) {
      window.chrome.permissions.contains = () => Promise.resolve(true);
    }
  });
  await page.evaluate(() => new Promise((r) => chrome.storage.local.set({ enabledDetectors: { meta: true } }, r)));
  await page.reload();
  await page.waitForSelector('.tabs .tab.active');

  await expect(page.locator('#capFilterBar')).toBeVisible();
  await expect(page.locator('#capFilterBar .cap-filter-chip', { hasText: 'Meta' })).toBeVisible();
  // all/none quick links are present
  await expect(page.locator('#capFilterBar .cap-filter-link', { hasText: 'all' })).toBeVisible();

  // Clean up so the seeded flag doesn't leak into other tests sharing the profile.
  await page.evaluate(() => new Promise((r) => chrome.storage.local.set({ enabledDetectors: {} }, r)));
  await page.close();
});

// --- OpenAI pixel: the origin-nested user block ------------------------------
// The one thing no other pixel does — the same identifier arrives once as the
// site supplied it (in) and once as the SDK scraped it off the page (fm/js/ht).
// The panel has to keep those apart, or a disagreement between the two is
// invisible. Hashes are the reference fixtures (docs 2026-09-01-openai-pixel-
// reference.md §11): identity A went to init, identity B sat in the form.
const OAI_EM_A = '973dfe463ec85785f5f95af5ba3906eedb2d931c24e69824a89ea65dba4e813b'; // test@example.com
const OAI_EM_B = '6d91ea2f7e0eea059183972f9d6fe225ee7d4248e4281f1ce5a90e33f25448b6'; // aam@example.com
const OAI_PH_A = '8b47a52ed04d068c3a9c5632b98cec18780a9f9f4099d4f8afe233970ce116fe'; // 491701234567
const OAI_REQUEST = `event=order_created&oai[in.em]=${OAI_EM_A}&oai[in.ph]=${OAI_PH_A}&oai[fm.em]=${OAI_EM_B}&oai[in.pc]=20095`;

async function pasteEm(page, value) {
  await activateTab(page, 'tab-em');
  await page.fill('#emInput', value);
  await page.dispatchEvent('#emInput', 'input');
  await page.waitForTimeout(300);
}

test('15. OpenAI: init and scraped email are separate rows, not merged', async () => {
  const { page, errors } = await openPopup();
  await pasteEm(page, OAI_REQUEST);

  const html = await page.locator('#emResult').innerHTML();
  expect(html).toMatch(/OpenAI Ad Measurement Pixel/);
  expect(html).toMatch(/Email \(init\)/);
  expect(html).toMatch(/Email \(form\)/);
  expect(html).toMatch(/order_created/);

  expect(errors).toEqual([]);
  await page.close();
});

test('16. OpenAI: the site-supplied email matches while the scraped one does not', async () => {
  const { page } = await openPopup();
  await pasteEm(page, OAI_REQUEST);
  await fillVerification(page, 'v_email', 'test@example.com');

  // Row order follows the block order, so init comes before form.
  const rows = page.locator('#emResult .res-table tr');
  await expect(rows.filter({ hasText: 'Email (init)' }).locator('.match')).toBeVisible();
  await expect(rows.filter({ hasText: 'Email (form)' }).locator('.no-match')).toBeVisible();
  await page.close();
});

test('17. OpenAI: phone normalization (digits, no leading zeros) reproduces the hash', async () => {
  const { page } = await openPopup();
  await pasteEm(page, OAI_REQUEST);
  await fillVerification(page, 'v_phone', '+49 170 1234567');
  const rows = page.locator('#emResult .res-table tr');
  await expect(rows.filter({ hasText: 'Phone (init)' }).locator('.match')).toBeVisible();
  await page.close();
});

test('18. OpenAI: cleartext geo is marked as by-design, never as a leak', async () => {
  const { page } = await openPopup();
  await pasteEm(page, OAI_REQUEST);
  const row = page.locator('#emResult .res-table tr').filter({ hasText: 'Postal code (init)' });
  await expect(row).toContainText('CLEARTEXT BY DESIGN');
  await expect(row.locator('.no-match')).toHaveCount(0);
  await page.close();
});

// --- Activity dot on the filter chips -----------------------------------
// A chip that is switched OFF hides its cards — which is exactly when you can
// no longer tell that the service is firing. The dot is the answer, so it must
// survive the toggle.

// Seed captures straight into the service worker's state, the same way the
// screenshot harness does. Detector flags are NOT set here: the panel's first
// load reconciles them against the real (absent) permissions and would write
// them straight back to false — they have to be set after the stub is in place.
async function seedCaptures(recording) {
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker');
  await sw.evaluate(({ caps, rec }) => {
    state.captures = caps;
    state.recording = rec;
    chrome.storage.local.set({ captureState: state });
  }, { caps: detectorFixtures.CAPTURES, rec: recording });
}

// Open the panel with the host permissions faked as granted, then enable the
// detectors and reload — the same order test 14 uses, and the only one that
// survives the reconciliation described above.
async function openPopupWithDetectors() {
  const { page } = await openPopup();
  await page.addInitScript(() => {
    if (window.chrome && window.chrome.permissions) {
      window.chrome.permissions.contains = () => Promise.resolve(true);
    }
  });
  await page.evaluate(() => new Promise((r) => chrome.storage.local.set({
    enabledDetectors: { meta: true, openai: true }, hiddenSources: [],
  }, r)));
  await page.reload();
  await page.waitForSelector('.tabs .tab.active');
  return page;
}

function chipInfo(page, src) {
  return page.evaluate((s) => {
    const bar = document.getElementById('capFilterBar');
    const c = bar.querySelector(`.cap-filter-chip[data-src="${s}"]`);
    if (!c) return null;
    return {
      active: c.classList.contains('active'),
      hasData: c.classList.contains('has-data'),
      anim: getComputedStyle(c, '::before').animationName,
      recLive: bar.classList.contains('rec-live'),
    };
  }, src);
}

test('19. Filter chips: the activity dot survives switching the chip off', async () => {
  await seedCaptures(false);
  const page = await openPopupWithDetectors();
  await page.waitForSelector('#capFilterBar .cap-filter-chip');
  // Start via the button: the reload above disconnects the panel port, and the
  // auto-stop option would have turned a pre-seeded recording back off.
  await page.click('#recToggle');
  await page.waitForTimeout(350);

  expect(await chipInfo(page, 'meta')).toMatchObject({ hasData: true, recLive: true });
  // A chip only gets a dot when captures of that service exist — 'ga' is in the
  // order list but produces none here.
  expect(await chipInfo(page, 'ga')).toBeNull();

  await page.click('.cap-filter-chip[data-src="meta"]');
  await page.waitForTimeout(250);
  const off = await chipInfo(page, 'meta');
  expect(off.active).toBe(false);
  expect(off.hasData).toBe(true);          // the point of the feature
  expect(off.anim).toMatch(/flt-live-pulse/);

  // Restore the show state so the next test starts from a visible chip.
  await page.evaluate(() => new Promise((r) => chrome.storage.local.set({ hiddenSources: [] }, r)));
  await page.close();
});

test('20. Filter chips: the dot stops pulsing once recording stops', async () => {
  await seedCaptures(false);
  const page = await openPopupWithDetectors();
  await page.waitForSelector('#capFilterBar .cap-filter-chip');

  const idle = await chipInfo(page, 'meta');
  expect(idle.hasData).toBe(true);
  expect(idle.recLive).toBe(false);
  expect(idle.anim).toBe('none');          // static marker, not an animation

  await page.click('#recToggle');          // Start
  await page.waitForTimeout(350);
  expect((await chipInfo(page, 'meta')).recLive).toBe(true);
  await page.click('#recToggle');          // Stop
  await page.waitForTimeout(350);
  expect((await chipInfo(page, 'meta')).recLive).toBe(false);
  await page.close();
});
