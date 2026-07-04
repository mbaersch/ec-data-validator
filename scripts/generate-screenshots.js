const { chromium } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const fixtures = require('../tests/fixtures.js');
const { CAPTURES } = require('../tests/detector-fixtures.js');

async function generateScreenshots() {
  const extensionPath = path.resolve(__dirname, '..');
  const userDataDir = path.resolve(__dirname, '..', 'tmp-user-data-shots');
  const screenshotDir = path.resolve(__dirname, '..', 'screenshots');

  if (fs.existsSync(userDataDir)) fs.rmSync(userDataDir, { recursive: true, force: true });
  if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir);

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker');
  const extensionId = worker.url().split('/')[2];
  const popupUrl = `chrome-extension://${extensionId}/popup.html`;

  const page = await context.newPage();
  await page.addInitScript(() => {
    if (window.chrome && !window.chrome.sidePanel) {
      window.chrome.sidePanel = { setPanelBehavior: () => Promise.resolve() };
    }
  });
  await page.setViewportSize({ width: 420, height: 900 });

  // --- 01: Object Analysis with full user_data + verification ---
  console.log('Screenshot 01-validation...');
  await page.goto(popupUrl);
  await page.waitForSelector('.tabs .tab.active');
  await page.click('.tab[data-target="tab-obj"]');
  await page.fill('#objInput', fixtures.USER_DATA_FULL_JS);
  await page.dispatchEvent('#objInput', 'input');
  await page.waitForTimeout(400);
  await page.waitForSelector('#v_email', { state: 'visible' });
  await page.fill('#v_email', fixtures.HASHES.emailGmail.raw);
  await page.dispatchEvent('#v_email', 'input');
  await page.fill('#v_phone', '+49 123 456 789');
  await page.dispatchEvent('#v_phone', 'input');
  await page.fill('#v_fn', 'Test');
  await page.dispatchEvent('#v_fn', 'input');
  await page.fill('#v_ln', 'Wrong');
  await page.dispatchEvent('#v_ln', 'input');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(screenshotDir, '01-validation.png'), fullPage: true });

  // --- 02: EM Decoder Tab with ECID string + verification ---
  console.log('Screenshot 02-em-decoder...');
  await page.goto(popupUrl);
  await page.waitForSelector('.tabs .tab.active');
  await page.click('.tab[data-target="tab-em"]');
  await page.fill('#emInput', fixtures.ECID_STRING_HEX);
  await page.dispatchEvent('#emInput', 'input');
  await page.waitForTimeout(400);
  await page.waitForSelector('#v_email', { state: 'visible' });
  await page.fill('#v_email', fixtures.HASHES.emailGmail.raw);
  await page.dispatchEvent('#v_email', 'input');
  await page.fill('#v_phone', '+49 123 456 789');
  await page.dispatchEvent('#v_phone', 'input');
  await page.fill('#v_fn', 'Test');
  await page.dispatchEvent('#v_fn', 'input');
  await page.fill('#v_ln', 'Test');
  await page.dispatchEvent('#v_ln', 'input');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(screenshotDir, '02-em-decoder.png'), fullPage: true });

  // --- 03: Recording UI in idle state with pre-filled URL ---
  console.log('Screenshot 03-recording-setup...');
  await page.goto(popupUrl);
  await page.waitForSelector('.tabs .tab.active');
  await page.fill('#recUrl', 'https://www.example-shop.com/*');
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(screenshotDir, '03-recording-setup.png'), fullPage: true });

  // Seed synthetic detector captures into the service worker's state, so the
  // panel renders real provider cards (Meta / TikTok / Pinterest / Bing /
  // LinkedIn) on the next load. Done after scene 03 so the earlier idle scenes
  // stay empty.
  let sw = context.serviceWorkers()[0];
  if (!sw) sw = await context.waitForEvent('serviceworker');
  await sw.evaluate((caps) => {
    // `state` is the service worker's top-level recording state (background.js).
    state.captures = caps;
    state.recording = false;
    chrome.storage.local.set({ captureState: state });
  }, CAPTURES);

  // --- 04: Detector capture list — PII-leak detection across ad platforms ---
  console.log('Screenshot 04-detectors...');
  await page.goto(popupUrl);
  await page.waitForSelector('.tabs .tab.active');
  await page.waitForSelector('.cap-card.source-meta');
  // The panel restores the previous scene's decoder input from storage — clear
  // it so this shot is just the capture list, not a leftover Google validation.
  await page.evaluate(() => {
    for (const id of ['emInput', 'objInput']) {
      const el = document.getElementById(id);
      if (el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
    }
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(screenshotDir, '04-detectors.png'), fullPage: true });

  // --- 05: Detector hash validation with the normalization diagnostic ---
  console.log('Screenshot 05-detector-validation...');
  await page.click('.cap-card.source-pinterest');
  await page.waitForSelector('#v_email', { state: 'visible' });
  // Upper-case input reproduces the hash only after lower-casing, so the match
  // is reported as MATCH + "INPUT NORMALIZED" — normalization is surfaced, not
  // silently assumed.
  await page.fill('#v_email', 'MAIL@markus-baersch.de');
  await page.dispatchEvent('#v_email', 'input');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(screenshotDir, '05-detector-validation.png'), fullPage: true });

  console.log('Done. Screenshots in', screenshotDir);
  await context.close();
}

generateScreenshots().catch((e) => {
  console.error(e);
  process.exit(1);
});
