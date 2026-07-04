const { chromium } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const fixtures = require('../tests/fixtures.js');
const { CAPTURES } = require('../tests/detector-fixtures.js');

const MERCH_URL = 'https://shop.googlemerchandisestore.com/';
const VIEW_W = 1280;
const VIEW_H = 800;

// Chrome Side Panel: rechte Spalte, volle Höhe, kein Drop-Shadow / Border-Radius.
// The panel is the product — give it the majority of the frame (was 420 / 33%,
// which left the store page dominating). A wide side panel is realistic (users
// drag it), and the store now reads as a context slice on the left.
const PANEL_W = 720;
const BG_W = VIEW_W - PANEL_W; // 560 — store slice left of the side panel

const SHORT_ECID = `tv.1~em.${fixtures.HASHES.emailGmail.hex}~pn.${fixtures.HASHES.phoneE164.hex}`;

function buildFixtureCaptures() {
  const now = Date.now();
  return [
    {
      ts: now - 5400,
      url: `https://www.googleadservices.com/pagead/conversion/123456789/?em=${fixtures.ECID_STRING_HEX}`,
      host: 'www.googleadservices.com',
      method: 'GET',
      em: fixtures.ECID_STRING_HEX,
      eme: null,
      queryParams: { tid: 'AW-123456789', em: fixtures.ECID_STRING_HEX },
      bodyParams: null,
      truncated: false,
      source: 'ads',
      transport: 'google'
    },
    {
      ts: now - 3800,
      url: 'https://www.google-analytics.com/g/collect?v=2&tid=G-EXAMPLE&en=purchase',
      host: 'www.google-analytics.com',
      method: 'POST',
      em: SHORT_ECID,
      eme: null,
      queryParams: { v: '2', tid: 'G-EXAMPLE', en: 'purchase' },
      bodyParams: { em: SHORT_ECID },
      truncated: false,
      source: 'ga',
      transport: 'google'
    },
    {
      ts: now - 2100,
      url: `https://sgtm.example-shop.com/ccm/conversion?em=${fixtures.ECID_STRING_HEX}`,
      host: 'sgtm.example-shop.com',
      method: 'GET',
      em: fixtures.ECID_STRING_HEX,
      eme: null,
      queryParams: { em: fixtures.ECID_STRING_HEX },
      bodyParams: null,
      truncated: false,
      source: 'ads',
      transport: 'first-party'
    },
    {
      ts: now - 600,
      url: `https://tags.example-shop.com/pagead/conversion?eme=${fixtures.EME_TOKEN_RAW}`,
      host: 'tags.example-shop.com',
      method: 'POST',
      em: null,
      eme: fixtures.EME_TOKEN_RAW,
      queryParams: {},
      bodyParams: { eme: fixtures.EME_TOKEN_RAW },
      truncated: false,
      source: 'ads',
      transport: 'first-party'
    }
  ];
}

function buildStoreCss(bgDataUri) {
  return `
    html, body {
      margin: 0 !important;
      padding: 0 !important;
      overflow: hidden !important;
      width: ${VIEW_W}px !important;
      height: ${VIEW_H}px !important;
      background: #ffffff !important;
    }
    body::before {
      content: '';
      position: fixed;
      top: 0; left: 0;
      width: ${BG_W}px;
      height: ${VIEW_H}px;
      background-image: url("${bgDataUri}");
      background-repeat: no-repeat;
      background-size: ${BG_W}px ${VIEW_H}px;
      background-position: 0 0;
      z-index: 0;
    }
    body {
      display: block !important;
    }
    #ec-store-wrapper {
      position: fixed !important;
      top: 0 !important;
      right: 0 !important;
      width: ${PANEL_W}px !important;
      height: ${VIEW_H}px !important;
      background: #ffffff !important;
      border: none !important;
      border-left: 1px solid #d1d5db !important;
      border-radius: 0 !important;
      box-shadow: -1px 0 4px rgba(0,0,0,0.06) !important;
      overflow-y: auto !important;
      overflow-x: hidden !important;
      z-index: 2 !important;
      box-sizing: border-box !important;
    }
    ::-webkit-scrollbar { display: none; }
  `;
}

const WRAP_SCRIPT = `
  (() => {
    if (document.getElementById('ec-store-wrapper')) return;
    const wrapper = document.createElement('div');
    wrapper.id = 'ec-store-wrapper';
    const moves = Array.from(document.body.children).filter(el => {
      const id = el.id || '';
      return el.tagName !== 'SCRIPT' && id !== 'detailModal';
    });
    moves.forEach(el => wrapper.appendChild(el));
    document.body.insertBefore(wrapper, document.body.firstChild);
  })();
`;

async function captureMerchBackground(context) {
  const page = await context.newPage();
  await page.setViewportSize({ width: BG_W, height: VIEW_H });
  try {
    await page.goto(MERCH_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
  } catch (e) {
    console.warn('Merch site failed to load fully, screenshotting current state:', e.message);
  }
  // Dismiss cookie banner if any
  await page.evaluate(() => {
    const candidates = Array.from(document.querySelectorAll('button, [role="button"]'));
    const btn = candidates.find(b => /accept|agree|got it|verstanden/i.test(b.textContent || ''));
    if (btn) btn.click();
  }).catch(() => {});
  await page.waitForTimeout(500);
  const buffer = await page.screenshot({ clip: { x: 0, y: 0, width: BG_W, height: VIEW_H }, type: 'png' });
  await page.close();
  return 'data:image/png;base64,' + buffer.toString('base64');
}

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

  console.log('Capturing merch.google.com background...');
  const bgDataUri = await captureMerchBackground(context);
  const storeCss = buildStoreCss(bgDataUri);

  async function snap(filename, opts) {
    const { tabTarget, mockCaptures = null, mockRecording = false, setupFn } = opts;
    const page = await context.newPage();
    await page.addInitScript((data) => {
      if (window.chrome && !window.chrome.sidePanel) {
        window.chrome.sidePanel = { setPanelBehavior: () => Promise.resolve() };
      }
      if (data && data.captures && window.chrome && window.chrome.runtime) {
        const fakeState = {
          recording: data.recording,
          captures: data.captures,
          ringSize: 50
        };
        window.chrome.runtime.sendMessage = function (msg, cb) {
          if (msg && msg.type === 'getState') {
            if (typeof cb === 'function') {
              setTimeout(() => cb(fakeState), 0);
              return undefined;
            }
            return Promise.resolve(fakeState);
          }
          if (typeof cb === 'function') {
            setTimeout(() => cb({}), 0);
            return undefined;
          }
          return Promise.resolve({});
        };
      }
    }, { captures: mockCaptures, recording: mockRecording });

    await page.setViewportSize({ width: VIEW_W, height: VIEW_H });
    await page.goto(popupUrl);
    await page.waitForSelector('.tabs .tab.active');
    if (tabTarget) {
      await page.click(`.tab[data-target="${tabTarget}"]`);
      await page.waitForTimeout(150);
    }
    if (setupFn) await setupFn(page);
    await page.waitForTimeout(300);
    await page.evaluate(WRAP_SCRIPT);
    await page.addStyleTag({ content: storeCss });
    await page.waitForTimeout(500);
    await page.screenshot({
      path: path.join(webstoreDir, filename),
      clip: { x: 0, y: 0, width: VIEW_W, height: VIEW_H },
      type: 'png'
    });
    console.log('Wrote', filename);
    await page.close();
  }

  // Clear any decoder input the panel restored from a previous scene's storage.
  const clearDecoder = async (p) => {
    await p.evaluate(() => {
      for (const id of ['emInput', 'objInput']) {
        const el = document.getElementById(id);
        if (el) { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); }
      }
    });
  };
  const hideIntro = async (p) => {
    await p.evaluate(() => {
      const intro = document.querySelector('#tab-em .intro');
      if (intro) intro.style.display = 'none';
    });
  };

  // 01: PII-leak detection across ad platforms — the flagship. Meta / TikTok /
  // Pinterest / Bing / LinkedIn cards, including an unhashed-email leak.
  await snap('01-pii-leak-detection.png', {
    tabTarget: 'tab-em',
    mockCaptures: CAPTURES,
    mockRecording: true,
    setupFn: async (p) => {
      await clearDecoder(p);
      await hideIntro(p);
      await p.evaluate(() => {
        const url = document.getElementById('recUrl');
        if (url) url.value = 'https://www.example-shop.com/*';
      });
      await p.waitForSelector('.cap-card.source-meta');
      await p.evaluate(() => {
        const cap = document.getElementById('capList');
        if (cap && !cap.hidden) cap.scrollIntoView({ block: 'start' });
      });
      await p.waitForTimeout(400);
    }
  });

  // 02: Hash validation with the normalization diagnostic — click a detector
  // card, enter a looser plaintext → MATCH + "INPUT NORMALIZED".
  await snap('02-hash-validation.png', {
    tabTarget: 'tab-em',
    mockCaptures: CAPTURES,
    mockRecording: true,
    setupFn: async (p) => {
      await hideIntro(p);
      await p.waitForSelector('.cap-card.source-pinterest');
      await p.click('.cap-card.source-pinterest');
      await p.waitForSelector('#v_email', { state: 'visible' });
      await p.fill('#v_email', 'MAIL@markus-baersch.de');
      await p.dispatchEvent('#v_email', 'input');
      await p.waitForTimeout(400);
      await p.evaluate(() => {
        const em = document.getElementById('emResult');
        if (em) em.scrollIntoView({ block: 'start' });
      });
      await p.waitForTimeout(200);
    }
  });

  // 03: Object Analysis with full user_data + verification (Google EC).
  await snap('03-object-analysis.png', {
    tabTarget: 'tab-obj',
    setupFn: async (p) => {
      await clearDecoder(p);
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
    }
  });

  // 04: EM Decoder with ECID (hex) + verification.
  await snap('04-em-decoder.png', {
    tabTarget: 'tab-em',
    setupFn: async (p) => {
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
    }
  });

  // 05: Live recording — Google Ads / GA4 / Tag Gateway / sGTM captures.
  await snap('05-recording.png', {
    tabTarget: 'tab-em',
    mockCaptures: buildFixtureCaptures(),
    mockRecording: true,
    setupFn: async (p) => {
      await clearDecoder(p);
      await hideIntro(p);
      await p.evaluate(() => {
        const url = document.getElementById('recUrl');
        if (url) url.value = 'https://www.example-shop.com/*';
      });
      await p.evaluate(() => {
        const cap = document.getElementById('capList');
        if (cap && !cap.hidden) cap.scrollIntoView({ block: 'nearest' });
      });
      await p.waitForTimeout(400);
    }
  });

  // --- Promo Tiles ---
  await generatePromoTiles(context, webstoreDir);

  console.log('Store assets generated in', webstoreDir);
  await context.close();
}

function buildPromoTileHtml({ width, height, layout }) {
  const isSmall = layout === 'small';
  const iconSize = isSmall ? 96 : 200;
  const titleSize = isSmall ? 30 : 76;
  const taglineSize = isSmall ? 14 : 30;
  const versionSize = isSmall ? 12 : 22;
  const padX = isSmall ? 28 : 80;
  const gap = isSmall ? 22 : 56;

  const iconSvg = `
    <svg viewBox="0 0 128 128" width="${iconSize}" height="${iconSize}" xmlns="http://www.w3.org/2000/svg">
      <rect width="128" height="128" rx="24" ry="24" fill="#FFFFFF" opacity="0.08"/>
      <g stroke="#FFB37A" stroke-width="9" stroke-linecap="round" fill="none">
        <line x1="40" y1="18" x2="32" y2="68"/>
        <line x1="68" y1="18" x2="60" y2="68"/>
        <line x1="18" y1="34" x2="78" y2="34"/>
        <line x1="16" y1="54" x2="76" y2="54"/>
      </g>
      <path d="M 56 90 L 76 112 L 116 64"
            stroke="#FFFFFF" stroke-width="14"
            stroke-linecap="round" stroke-linejoin="round"
            fill="none"/>
    </svg>
  `;

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  html, body {
    margin: 0; padding: 0;
    width: ${width}px; height: ${height}px;
    overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
    color: #ffffff;
  }
  .tile {
    width: ${width}px;
    height: ${height}px;
    box-sizing: border-box;
    padding: 0 ${padX}px;
    background:
      radial-gradient(1200px 600px at 80% -20%, rgba(196,78,0,0.35) 0%, rgba(196,78,0,0) 60%),
      radial-gradient(900px 500px at 0% 110%, rgba(0,200,150,0.18) 0%, rgba(0,200,150,0) 60%),
      linear-gradient(135deg, #00372D 0%, #005141 55%, #062a23 100%);
    display: flex;
    align-items: center;
    gap: ${gap}px;
    position: relative;
  }
  .tile::after {
    content: '';
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px);
    background-size: 40px 40px;
    mask-image: radial-gradient(ellipse at center, black 30%, transparent 75%);
    -webkit-mask-image: radial-gradient(ellipse at center, black 30%, transparent 75%);
    pointer-events: none;
  }
  .icon {
    flex: 0 0 auto;
    position: relative;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .text {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: ${isSmall ? 6 : 18}px;
    min-width: 0;
  }
  .title {
    font-size: ${titleSize}px;
    font-weight: 700;
    letter-spacing: -0.01em;
    line-height: 1.05;
    color: #ffffff;
  }
  .title .accent { color: #FFB37A; }
  .tagline {
    font-size: ${taglineSize}px;
    line-height: 1.25;
    color: rgba(255,255,255,0.85);
    max-width: ${isSmall ? 240 : 820}px;
  }
  .version {
    font-size: ${versionSize}px;
    color: rgba(255,255,255,0.55);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
</style>
</head>
<body>
  <div class="tile">
    <div class="icon">${iconSvg}</div>
    <div class="text">
      <div class="title"><span class="accent">ec</span> Data Validator</div>
      <div class="tagline">${isSmall
        ? 'Inspect Google Ads enhanced conversion data — hash, decode, verify.'
        : 'Inspect, hash and verify Google Ads enhanced conversion data. Decode Cloud-Edge tokens and audit Tag Gateway &amp; server-side GTM traffic.'}</div>
      <div class="version">Chrome Extension</div>
    </div>
  </div>
</body>
</html>`;
}

async function renderTile(context, filename, dir, opts) {
  const { width, height, layout } = opts;
  const page = await context.newPage();
  await page.setViewportSize({ width, height });
  const html = buildPromoTileHtml({ width, height, layout });
  await page.setContent(html, { waitUntil: 'load' });
  await page.waitForTimeout(300);
  await page.screenshot({
    path: path.join(dir, filename),
    clip: { x: 0, y: 0, width, height },
    type: 'png',
    omitBackground: false
  });
  console.log('Wrote', filename);
  await page.close();
}

async function generatePromoTiles(context, webstoreDir) {
  await renderTile(context, 'promo-small-440x280.png', webstoreDir, {
    width: 440, height: 280, layout: 'small'
  });
  await renderTile(context, 'promo-marquee-1400x560.png', webstoreDir, {
    width: 1400, height: 560, layout: 'marquee'
  });
}

generateStoreScreenshots().catch((e) => {
  console.error(e);
  process.exit(1);
});
