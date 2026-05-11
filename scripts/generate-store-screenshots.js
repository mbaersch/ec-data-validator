const { chromium } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const fixtures = require('../tests/fixtures.js');

const STORE_CSS = `
  html, body {
    background: linear-gradient(135deg, #1a1a1a 0%, #000 100%) !important;
    margin: 0 !important;
    padding: 0 !important;
    overflow: hidden !important;
    height: 800px !important;
  }
  body {
    display: flex !important;
    justify-content: center !important;
    align-items: flex-start !important;
    padding-top: 24px !important;
    box-sizing: border-box !important;
  }
  #ec-store-wrapper {
    width: 420px !important;
    max-height: 752px !important;
    overflow: hidden !important;
    background: #f8fafc !important;
    border: 2px solid #C44E00 !important;
    border-radius: 10px !important;
    box-shadow: 0 20px 80px rgba(0,0,0,0.8) !important;
  }
  ::-webkit-scrollbar { display: none; }
`;

const WRAP_SCRIPT = `
  (() => {
    if (document.getElementById('ec-store-wrapper')) return;
    const wrapper = document.createElement('div');
    wrapper.id = 'ec-store-wrapper';
    // Move every direct child of body except scripts/modals into the wrapper
    const moves = Array.from(document.body.children).filter(el => {
      const id = el.id || '';
      return el.tagName !== 'SCRIPT' && id !== 'detailModal';
    });
    moves.forEach(el => wrapper.appendChild(el));
    document.body.insertBefore(wrapper, document.body.firstChild);
  })();
`;

async function generateStoreScreenshots() {
  const extensionPath = path.resolve(__dirname, '..');
  const userDataDir = path.resolve(__dirname, '..', 'tmp-user-data-store');
  const webstoreDir = path.resolve(__dirname, '..', 'webstore');

  if (fs.existsSync(userDataDir)) fs.rmSync(userDataDir, { recursive: true, force: true });
  if (!fs.existsSync(webstoreDir)) fs.mkdirSync(webstoreDir);

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
  await page.setViewportSize({ width: 1280, height: 800 });

  async function snap(filename, setupFn) {
    await page.goto(popupUrl);
    await page.waitForSelector('.tabs .tab.active');
    if (setupFn) await setupFn(page);
    await page.evaluate(WRAP_SCRIPT);
    await page.addStyleTag({ content: STORE_CSS });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(webstoreDir, filename), clip: { x: 0, y: 0, width: 1280, height: 800 } });
    console.log('Wrote', filename);
  }

  // 01: Object Analysis Validation
  await snap('01-validation.png', async (p) => {
    await p.click('.tab[data-target="tab-obj"]');
    await p.fill('#objInput', fixtures.USER_DATA_FULL_JS);
    await p.dispatchEvent('#objInput', 'input');
    await p.waitForTimeout(400);
    await p.waitForSelector('#v_email', { state: 'visible' });
    await p.fill('#v_email', fixtures.HASHES.emailGmail.raw);
    await p.dispatchEvent('#v_email', 'input');
    await p.fill('#v_phone', '+49 123 456 789');
    await p.dispatchEvent('#v_phone', 'input');
    await p.fill('#v_fn', 'Test');
    await p.dispatchEvent('#v_fn', 'input');
    await p.fill('#v_ln', 'Test');
    await p.dispatchEvent('#v_ln', 'input');
  });

  // 02: EM Decoder with ECID + verification
  await snap('02-em-decoder.png', async (p) => {
    await p.click('.tab[data-target="tab-em"]');
    await p.fill('#emInput', fixtures.ECID_STRING_HEX);
    await p.dispatchEvent('#emInput', 'input');
    await p.waitForTimeout(400);
    await p.waitForSelector('#v_email', { state: 'visible' });
    await p.fill('#v_email', fixtures.HASHES.emailGmail.raw);
    await p.dispatchEvent('#v_email', 'input');
    await p.fill('#v_phone', '+49 123 456 789');
    await p.dispatchEvent('#v_phone', 'input');
    await p.fill('#v_fn', 'Test');
    await p.dispatchEvent('#v_fn', 'input');
    await p.fill('#v_ln', 'Test');
    await p.dispatchEvent('#v_ln', 'input');
  });

  // 03: Recording setup
  await snap('03-recording-setup.png', async (p) => {
    await p.fill('#emInput', '');
    await p.dispatchEvent('#emInput', 'input');
    await p.fill('#recUrl', 'https://www.example-shop.com/*');
  });

  console.log('Store assets generated in', webstoreDir);
  await context.close();
}

generateStoreScreenshots().catch((e) => {
  console.error(e);
  process.exit(1);
});
