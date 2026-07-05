const { test, expect, chromium } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const fixtures = require('./fixtures.js');

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
