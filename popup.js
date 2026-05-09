document.addEventListener('DOMContentLoaded', () => {
    const fieldsMap = {
        'tv': 'Version', 'em': 'Email Hash', 'pn': 'Phone Hash',
        'fn0': 'First Name Hash', 'ln0': 'Last Name Hash',
        'co0': 'Country', 'ct0': 'City', 'st0': 'State', 'zp0': 'Zip', 'sa0': 'Street Hash'
    };

    // Felder, die als Hash auftreten koennen -> Vergleichsfeld dynamisch
    const verifyFields = [
        { id: 'v_email',  label: 'Email',      placeholder: 'test@example.com', hashKeys: ['sha256_email_address', 'em'] },
        { id: 'v_phone',  label: 'Phone',      placeholder: '+4912345678',      hashKeys: ['sha256_phone_number', 'pn'], normalize: v => v.replace(/\s+/g, '') },
        { id: 'v_fn',     label: 'First Name', placeholder: 'Max',              hashKeys: ['sha256_first_name', 'fn0'] },
        { id: 'v_ln',     label: 'Last Name',  placeholder: 'Mustermann',       hashKeys: ['sha256_last_name', 'ln0'] },
        { id: 'v_street', label: 'Street',     placeholder: 'Hauptstr. 1',      hashKeys: ['sha256_street', 'sa0'] }
    ];
    const hashKeyToVerifyId = {};
    verifyFields.forEach(f => f.hashKeys.forEach(k => { hashKeyToVerifyId[k] = f.id; }));

    // Felder fuer den Object-Report (auch unhashed)
    const reportFields = [
        'email', 'sha256_email_address',
        'phone_number', 'sha256_phone_number',
        'first_name', 'sha256_first_name',
        'last_name', 'sha256_last_name',
        'street', 'city', 'region', 'postal_code', 'country'
    ];

    let verifyState = {};
    let lastVisibleSig = '';

    const vBox = document.getElementById('vBox');
    const vGrid = document.getElementById('vGrid');
    const emInput = document.getElementById('emInput');
    const objInput = document.getElementById('objInput');

    // Tabs
    function activateTab(targetId) {
        const tab = document.querySelector(`.tab[data-target="${targetId}"]`);
        const pane = document.getElementById(targetId);
        if (!tab || !pane) return;
        document.querySelectorAll('.tab, .content').forEach(el => el.classList.remove('active'));
        tab.classList.add('active');
        pane.classList.add('active');
    }

    function getActiveTabId() {
        const t = document.querySelector('.tab.active');
        return t ? t.dataset.target : 'tab-em';
    }

    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            activateTab(tab.dataset.target);
            chrome.storage.local.set({ activeTab: tab.dataset.target });
            runUpdate();
        });
    });

    async function sha256(msg) {
        if (!msg || msg.trim() === '') return null;
        const buf = new TextEncoder().encode(msg.toLowerCase().trim());
        const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
        const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        const b64url = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        return { hex, b64url };
    }

    function detectHashEncoding(v) {
        if (!v) return null;
        if (/^[0-9a-f]{64}$/i.test(v)) return 'hex';
        if (/^[A-Za-z0-9_-]{43}={0,1}$/.test(v)) return 'b64url';
        return null;
    }

    function hashMatches(observed, expected) {
        if (!expected) return false;
        return observed === expected.hex
            || observed.toLowerCase() === expected.hex
            || observed === expected.b64url;
    }

    function encPill(enc) {
        return enc ? ` <span class="enc enc-${enc}">${enc}</span>` : '';
    }

    function normalizeJS(str) {
        let c = str.trim();
        if (!c) return '{}';
        if (c.includes('dataLayer.push(')) {
            c = c.substring(c.indexOf('(') + 1, c.lastIndexOf(')'));
        } else if (c.includes('gtag(')) {
            const m = c.match(/gtag\s*\(\s*['"]event['"]\s*,\s*['"][^'"]+['"]\s*,\s*({.*})\s*\)/s);
            if (m) c = m[1];
        }
        c = c.trim();
        // Fragment ohne aussere Klammern in {} packen
        if (!c.startsWith('{') && !c.startsWith('[')) {
            c = '{' + c + '}';
        }
        return c
            .replace(/"\s*\+\s*"/g, '')                          // Konkat double-quoted
            .replace(/'\s*\+\s*'/g, '')                          // Konkat single-quoted
            .replace(/([{,])\s*([a-zA-Z0-9_.]+)\s*:/g, '$1"$2":') // unquoted keys (incl. dotted like gtm.uniqueEventId)
            .replace(/:\s*'([^']*)'/g, ': "$1"')                 // single-quoted values
            .replace(/,\s*([\]}])/g, '$1');                      // trailing commas
    }

    function getEMKeys(raw) {
        const keys = new Set();
        if (!raw) return keys;
        let s = raw.trim();
        try { s = decodeURIComponent(s); } catch (e) { /* ignore */ }
        if (s.startsWith('em=')) s = s.substring(3);
        s.split('~').forEach(p => {
            const i = p.indexOf('.');
            if (i !== -1) keys.add(p.substring(0, i));
        });
        return keys;
    }

    function parseObj(raw) {
        if (!raw.trim()) return null;
        try { return JSON.parse(normalizeJS(raw)); } catch (e) { return undefined; }
    }

    function collectObjKeys(obj, keys = new Set()) {
        if (!obj || typeof obj !== 'object') return keys;
        Object.keys(obj).forEach(k => {
            keys.add(k);
            if (obj[k] && typeof obj[k] === 'object') collectObjKeys(obj[k], keys);
        });
        return keys;
    }

    const ADDRESS_FIELDS = new Set([
        'first_name', 'sha256_first_name',
        'last_name',  'sha256_last_name',
        'street',     'sha256_street',
        'city', 'region', 'postal_code', 'country'
    ]);

    function detectMisplacedAddrFields(obj) {
        const misplaced = new Set();
        function walk(node, inAddress) {
            if (!node || typeof node !== 'object') return;
            if (Array.isArray(node)) {
                node.forEach(n => walk(n, inAddress));
                return;
            }
            Object.keys(node).forEach(k => {
                if (k === 'address') {
                    walk(node[k], true);
                } else if (ADDRESS_FIELDS.has(k) && !inAddress) {
                    misplaced.add(k);
                } else if (node[k] && typeof node[k] === 'object') {
                    walk(node[k], inAddress);
                }
            });
        }
        walk(obj, false);
        return Array.from(misplaced);
    }

    function checkMinReq(keys, misplaced) {
        const bad = new Set(misplaced || []);
        const has      = (...alts) => alts.some(k => keys.has(k));
        const hasValid = (...alts) => alts.some(k => keys.has(k) && !bad.has(k));
        const r = {
            email:   has('email', 'sha256_email_address', 'em'),
            phone:   has('phone_number', 'sha256_phone_number', 'pn'),
            fn:      hasValid('first_name', 'sha256_first_name', 'fn0'),
            ln:      hasValid('last_name', 'sha256_last_name', 'ln0'),
            zip:     hasValid('postal_code', 'zp0'),
            country: hasValid('country', 'co0'),
            street:  hasValid('street', 'sa0'),
            city:    hasValid('city', 'ct0'),
            region:  hasValid('region', 'st0'),
            any:     keys.size > 0
        };
        r.addrAny  = r.fn || r.ln || r.zip || r.country || r.street || r.city || r.region;
        r.fullAddr = r.fn && r.ln && r.zip && r.country;
        r.ok       = r.email || r.fullAddr;
        return r;
    }

    function renderCompliance(c) {
        if (!c.any) return '';

        const ok   = `margin-bottom:6px; padding:6px 10px; background:#dcfce7; color:#166534; border-radius:4px; font-size:11px;`;
        const warn = `margin-bottom:6px; padding:6px 10px; background:#fef3c7; color:#92400e; border-radius:4px; font-size:11px;`;
        const info = `margin-bottom:6px; padding:6px 10px; background:#f1f5f9; color:#475569; border-radius:4px; font-size:11px;`;
        const blocks = [];

        if (c.ok) {
            const path = c.email && c.fullAddr ? 'Email + full address'
                       : c.email ? 'Email'
                       : 'full address';
            const phoneHint = c.phone ? ' · +Phone' : '';
            blocks.push(`<div style="${ok}">✓ Minimum requirements met (${path})${phoneHint}</div>`);
        }

        if (c.addrAny && !c.fullAddr) {
            const parts = [];
            if (!c.fn)      parts.push('First Name');
            if (!c.ln)      parts.push('Last Name');
            if (!c.country) parts.push('Country');
            if (!c.zip)     parts.push('Postal Code');
            const onlyZipMissing = c.fn && c.ln && c.country && !c.zip;
            if (onlyZipMissing) {
                blocks.push(`<div style="${info}">i Address incomplete — missing: Postal Code (will still be processed)</div>`);
            } else {
                blocks.push(`<div style="${warn}">! Address fields detected but incomplete — for an address-based match these are required: ${parts.join(', ')}</div>`);
            }
        }

        if (!c.ok && !c.addrAny && c.phone) {
            blocks.push(`<div style="${warn}">! Phone alone is not sufficient for matching — add Email or a full address</div>`);
        }

        return blocks.join('');
    }

    function countryWarning(val) {
        if (val === undefined || val === null || val === '') return '';
        return /^[A-Za-z]{2}$/.test(String(val).trim())
            ? ''
            : ` <span style="background:#c2410c; color:white; padding:2px 6px; border-radius:4px; font-size:9px; font-weight:bold;" title="expected ISO-3166-1 alpha-2 (e.g. CH, DE)">[!] ISO-3166-1 alpha-2 (e.g. CH, DE)</span>`;
    }

    function getObjValue(obj, key) {
        if (!obj) return undefined;
        if (obj[key] !== undefined) return obj[key];
        const unpackAddr = (a) => Array.isArray(a) ? a[0] : a;
        if (obj.user_data) {
            if (obj.user_data[key] !== undefined) return obj.user_data[key];
            const udAddr = unpackAddr(obj.user_data.address);
            if (udAddr && udAddr[key] !== undefined) return udAddr[key];
        }
        const addr = unpackAddr(obj.address);
        if (addr && addr[key] !== undefined) return addr[key];
        return undefined;
    }

    function detectObjType(parsed) {
        if (!parsed || typeof parsed !== 'object') return null;
        const hasTagMode = (o) => {
            if (!o || typeof o !== 'object') return false;
            if (Object.prototype.hasOwnProperty.call(o, '_tag_mode')) return true;
            return Object.values(o).some(v => hasTagMode(v));
        };
        return hasTagMode(parsed) ? 'user-provided data' : 'dataLayer / object';
    }

    function renderTypePill(type) {
        if (!type) return '';
        const isUPD = type === 'user-provided data';
        const bg = isUPD ? '#fef3c7' : '#dbeafe';
        const fg = isUPD ? '#92400e' : '#1e40af';
        return `<div style="margin-bottom:8px;"><span style="font-size:10px; padding:3px 8px; border-radius:4px; background:${bg}; color:${fg}; font-weight:600; letter-spacing:0.3px;">${type}</span></div>`;
    }

    function renderVerifyFields(activeKeys) {
        const visible = verifyFields.filter(f => f.hashKeys.some(k => activeKeys.has(k)));
        const sig = visible.map(f => f.id).join(',');

        if (visible.length === 0) {
            vBox.classList.add('hidden');
            lastVisibleSig = '';
            return;
        }
        vBox.classList.remove('hidden');

        if (sig === lastVisibleSig) return;
        lastVisibleSig = sig;

        vGrid.innerHTML = visible.map(f => `
            <div>
                <label>${f.label}</label>
                <input type="text" id="${f.id}" placeholder="${f.placeholder}" value="${(verifyState[f.id] || '').replace(/"/g, '&quot;')}">
            </div>
        `).join('');

        vGrid.querySelectorAll('input').forEach(inp => {
            inp.addEventListener('input', (e) => {
                verifyState[e.target.id] = e.target.value;
                persist();
                runUpdate();
            });
        });
    }

    function renderEM(raw, hashes, emKeys) {
        const target = document.getElementById('emResult');
        if (!raw.trim()) { target.innerHTML = ''; return; }

        let s = raw.trim();
        try { s = decodeURIComponent(s); } catch (e) { /* ignore */ }
        if (s.startsWith('em=')) s = s.substring(3);

        const compliance = renderCompliance(checkMinReq(emKeys));
        let html = compliance + '<table class="res-table">';
        s.split('~').forEach(p => {
            const i = p.indexOf('.');
            if (i === -1) return;
            const k = p.substring(0, i), v = p.substring(i + 1);
            const verifyId = hashKeyToVerifyId[k];
            const enc = (verifyId || k === 'em' || k === 'pn' || k === 'fn0' || k === 'ln0' || k === 'sa0')
                ? detectHashEncoding(v) : null;
            let status = '';
            if (verifyId && hashes[verifyId]) {
                status = hashMatches(v, hashes[verifyId])
                    ? '<span class="match">MATCH</span>'
                    : '<span class="no-match">ERR</span>';
            }
            status += encPill(enc);
            if (k === 'co0') status += countryWarning(v);
            const statusBlock = status.trim() ? `<div class="status-line">${status}</div>` : '';
            html += `<tr><td><b>${fieldsMap[k] || k}</b></td><td><code>${v}</code>${statusBlock}</td></tr>`;
        });
        html += '</table>';
        target.innerHTML = html;
    }

    function renderObj(parsed, raw, hashes, objKeys) {
        const target = document.getElementById('objResult');
        if (!raw.trim()) { target.innerHTML = ''; return; }
        if (parsed === undefined) {
            target.innerHTML = '<table class="res-table"><tr><td class="no-match">JSON Parse Error: Check syntax</td></tr></table>';
            return;
        }

        const typePill   = renderTypePill(detectObjType(parsed));
        const misplaced  = detectMisplacedAddrFields(parsed);
        const compliance = renderCompliance(checkMinReq(objKeys, misplaced));
        const struct = `margin-bottom:6px; padding:6px 10px; background:#fef2f2; color:#991b1b; border-radius:4px; font-size:11px;`;
        const structWarn = misplaced.length > 0
            ? `<div style="${struct}">✗ Structure error — address fields outside <code>user_data.address</code>: ${misplaced.join(', ')}</div>`
            : '';
        let html = typePill + structWarn + compliance + '<table class="res-table">';
        reportFields.forEach(f => {
            const val = getObjValue(parsed, f);
            if (val === undefined || val === null) return;
            const verifyId = hashKeyToVerifyId[f];
            const enc = f.startsWith('sha256_') ? detectHashEncoding(String(val)) : null;
            let status = '';
            if (verifyId && hashes[verifyId]) {
                status = hashMatches(String(val), hashes[verifyId])
                    ? '<span class="match">MATCH</span>'
                    : '<span class="no-match">ERR</span>';
            }
            status += encPill(enc);
            if (f === 'country') status += countryWarning(val);
            const statusBlock = status.trim() ? `<div class="status-line">${status}</div>` : '';
            html += `<tr><td><b>${f}</b></td><td><code>${val}</code>${statusBlock}</td></tr>`;
        });
        html += '</table>';
        target.innerHTML = html;
    }

    function persist() {
        chrome.storage.local.set({
            em: emInput.value,
            obj: objInput.value,
            verify: verifyState
        });
    }

    async function runUpdate() {
        const emRaw = emInput.value;
        const objRaw = objInput.value;

        const emKeys = getEMKeys(emRaw);
        const parsedObj = parseObj(objRaw);
        const objKeys = parsedObj ? collectObjKeys(parsedObj) : new Set();

        const tabKeys = getActiveTabId() === 'tab-obj' ? objKeys : emKeys;
        renderVerifyFields(tabKeys);

        const hashes = {};
        await Promise.all(verifyFields.map(async f => {
            const val = verifyState[f.id];
            if (!val) return;
            const normalized = f.normalize ? f.normalize(val) : val;
            hashes[f.id] = await sha256(normalized);
        }));

        renderObj(parsedObj, objRaw, hashes, objKeys);
        renderEM(emRaw, hashes, emKeys);

        persist();
    }

    // Initial load
    chrome.storage.local.get(null, (res) => {
        if (res.em) emInput.value = res.em;
        if (res.obj) objInput.value = res.obj;
        if (res.verify) verifyState = res.verify;
        if (res.activeTab) activateTab(res.activeTab);

        // Migration alter Schluessel
        const legacy = { v_email: res.v_email, v_phone: res.v_phone, v_fn: res.v_fn, v_ln: res.v_ln };
        Object.entries(legacy).forEach(([k, v]) => {
            if (v && !verifyState[k]) verifyState[k] = v;
        });

        runUpdate();
    });

    [emInput, objInput].forEach(el => el.addEventListener('input', runUpdate));

    // ---------- Capture / Recording ----------

    const recUrl        = document.getElementById('recUrl');
    const recToggle     = document.getElementById('recToggle');
    const recDot        = document.getElementById('recDot');
    const recStatusText = document.getElementById('recStatusText');
    const recCount      = document.getElementById('recCount');
    const recRing       = document.getElementById('recRing');
    const recClear      = document.getElementById('recClear');
    const recError      = document.getElementById('recError');
    const capList       = document.getElementById('capList');
    const capEmpty      = document.getElementById('capEmpty');

    const PILL_CLASS = {
        em:  'identifier-em',
        pn:  'identifier-pn',
        fn0: 'identifier-name',
        ln0: 'identifier-name',
        sa0: 'identifier-addr',
        co0: 'identifier-addr',
        ct0: 'identifier-addr',
        st0: 'identifier-addr',
        zp0: 'identifier-addr'
    };
    const PILL_LABEL = {
        em:  'Email',
        pn:  'Phone',
        fn0: 'First Name',
        ln0: 'Last Name',
        sa0: 'Street',
        ct0: 'City',
        st0: 'State',
        zp0: 'Zip',
        co0: 'Country'
    };
    const PILL_ORDER = ['em', 'pn', 'fn0', 'ln0', 'sa0', 'ct0', 'st0', 'zp0', 'co0'];

    let captures = [];
    let recording = false;
    let filterEmOnly = true;

    function normalizeOrigin(input) {
        if (!input) return null;
        let s = input.trim();
        if (!s) return null;
        if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
        try {
            const u = new URL(s);
            return `${u.protocol}//${u.host}/*`;
        } catch (e) { return null; }
    }

    function shortenUrl(url, host) {
        try {
            const u = new URL(url);
            return host + u.pathname;
        } catch (e) { return url; }
    }

    function formatTime(ts) {
        const d = new Date(ts);
        return d.toLocaleTimeString('de-DE', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
    }

    function renderPills(em) {
        if (!em) return '<span class="cap-pill none" title="No em parameter in this request">no em</span>';
        const keys = getEMKeys(em);
        const ordered = PILL_ORDER.filter(k => keys.has(k));
        if (ordered.length === 0) return '<span class="cap-pill none" title="em present but no recognized identifier tokens">no identifiers</span>';
        return ordered.map(k => {
            const cls = PILL_CLASS[k] || '';
            const label = PILL_LABEL[k] || k;
            return `<span class="cap-pill ${cls}" title="${label}">${k}</span>`;
        }).join('');
    }

    function renderCaptures() {
        recCount.textContent = captures.length;
        const visible = filterEmOnly ? captures.filter(c => !!c.em) : captures;
        if (visible.length === 0) {
            capList.innerHTML = '';
            capList.hidden = true;
            capEmpty.hidden = false;
            capEmpty.textContent = (captures.length === 0)
                ? 'No captures yet — start recording to collect requests.'
                : 'No captures with em — uncheck the filter to see all requests.';
            return;
        }
        capList.hidden = false;
        capEmpty.hidden = true;
        capList.innerHTML = visible.slice().reverse().map(c => {
            const realIdx = captures.indexOf(c);
            return `<div class="cap-card ${c.em ? '' : 'no-em'}" data-idx="${realIdx}">
                <div class="cap-card-head">
                    <span class="cap-time">${formatTime(c.ts)}</span>
                    <span class="cap-method">${c.method}</span>
                    <span class="cap-host">${shortenUrl(c.url, c.host)}</span>
                </div>
                <div class="cap-card-pills">${renderPills(c.em)}</div>
            </div>`;
        }).join('');
        capList.querySelectorAll('.cap-card').forEach(card => {
            card.addEventListener('click', () => {
                const idx = Number(card.dataset.idx);
                const cap = captures[idx];
                if (!cap || !cap.em) return;
                emInput.value = cap.em;
                runUpdate();
                emInput.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            });
        });
    }

    const recUrlReload = document.getElementById('recUrlReload');

    function setRecordingUI(rec) {
        recording = rec;
        recDot.classList.toggle('live', rec);
        recStatusText.textContent = rec ? 'recording' : 'idle';
        recToggle.textContent = rec ? 'Stop' : 'Permit & Record';
        recToggle.classList.toggle('primary', !rec);
        recToggle.classList.toggle('danger', rec);
        recUrl.disabled = rec;
        recUrlReload.disabled = rec;
    }

    function fillUrlFromActiveTab() {
        try {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (tabs && tabs[0] && tabs[0].url) {
                    try {
                        const u = new URL(tabs[0].url);
                        if (u.protocol.startsWith('http')) {
                            recUrl.value = `${u.protocol}//${u.host}/*`;
                            showError('');
                        }
                    } catch (e) {}
                }
            });
        } catch (e) {}
    }

    recUrlReload.addEventListener('click', () => {
        if (recording) return;
        fillUrlFromActiveTab();
    });

    function showError(msg) {
        if (!msg) { recError.hidden = true; recError.textContent = ''; return; }
        recError.hidden = false;
        recError.textContent = msg;
    }

    async function startRecordingFlow() {
        showError('');
        const origin = normalizeOrigin(recUrl.value);
        if (!origin) {
            showError('Invalid URL — provide e.g. https://example.com');
            return;
        }
        try {
            const granted = await chrome.permissions.request({ origins: [origin] });
            if (!granted) {
                showError('Permission denied — recording cannot start without site access.');
                return;
            }
        } catch (e) {
            showError('Permission request failed: ' + e.message);
            return;
        }
        chrome.runtime.sendMessage({ type: 'startRecording' }, (res) => {
            if (res && res.ok) setRecordingUI(true);
        });
    }

    function stopRecordingFlow() {
        chrome.runtime.sendMessage({ type: 'stopRecording' }, (res) => {
            if (res && res.ok) setRecordingUI(false);
        });
    }

    recToggle.addEventListener('click', () => {
        if (recording) stopRecordingFlow();
        else startRecordingFlow();
    });

    const recFilterEm = document.getElementById('recFilterEm');
    recFilterEm.addEventListener('change', () => {
        filterEmOnly = recFilterEm.checked;
        chrome.storage.local.set({ recFilterEm: filterEmOnly });
        renderCaptures();
    });

    recClear.addEventListener('click', () => {
        captures = [];
        renderCaptures();
        try {
            chrome.runtime.sendMessage({ type: 'clearCaptures' }, () => {
                // Swallow lastError if the SW callback path fails; broadcast will keep us in sync.
                void chrome.runtime.lastError;
            });
        } catch (e) { /* ignore */ }
    });

    const recExport = document.getElementById('recExport');
    recExport.addEventListener('click', async () => {
        const exportSet = filterEmOnly ? captures.filter(c => !!c.em) : captures;
        if (exportSet.length === 0) {
            showError('Nothing to export.');
            setTimeout(() => showError(''), 2000);
            return;
        }
        const payload = {
            exportedAt: new Date().toISOString(),
            filter: filterEmOnly ? 'em-only' : 'all',
            count: exportSet.length,
            captures: exportSet.map(c => ({
                ts: c.ts,
                tsIso: new Date(c.ts).toISOString(),
                method: c.method,
                host: c.host,
                url: c.url,
                em: c.em
            }))
        };
        const json = JSON.stringify(payload, null, 2);
        try {
            await navigator.clipboard.writeText(json);
            const original = recExport.textContent;
            recExport.textContent = 'Copied!';
            setTimeout(() => { recExport.textContent = original; }, 1500);
        } catch (e) {
            showError('Clipboard write failed: ' + e.message);
        }
    });

    chrome.runtime.onMessage.addListener((msg) => {
        if (!msg || !msg.type) return;
        if (msg.type === 'captureAdded') {
            captures.push(msg.capture);
            // The background already trims to RING_SIZE, mirror locally
            const ring = Number(recRing.textContent) || 50;
            if (captures.length > ring) captures = captures.slice(-ring);
            renderCaptures();
        } else if (msg.type === 'capturesCleared') {
            captures = [];
            renderCaptures();
        } else if (msg.type === 'stateChanged') {
            setRecordingUI(!!msg.recording);
        }
    });

    // Initial state pull from background + filter persistence
    chrome.storage.local.get('recFilterEm', (res) => {
        // Default to true if never set
        filterEmOnly = (res.recFilterEm === undefined) ? true : !!res.recFilterEm;
        recFilterEm.checked = filterEmOnly;
        renderCaptures();
    });

    chrome.runtime.sendMessage({ type: 'getState' }, (res) => {
        if (!res) return;
        captures = Array.isArray(res.captures) ? res.captures : [];
        if (res.ringSize) recRing.textContent = String(res.ringSize);
        setRecordingUI(!!res.recording);
        renderCaptures();
    });

    // Pre-fill recUrl with the active tab origin (best effort)
    fillUrlFromActiveTab();
});
