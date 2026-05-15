document.addEventListener('DOMContentLoaded', () => {
    const TOKEN_BASE = {
        tv: 'Version',
        em: 'Email Hash',
        pn: 'Phone Hash',
        fn: 'First Name Hash',
        ln: 'Last Name Hash',
        sa: 'Street Hash',
        ct: 'City',
        st: 'State',
        zp: 'Zip',
        pc: 'Postal Code',
        rg: 'Region',
        co: 'Country'
    };

    // tokenLabel('fn0',_,_)        -> 'First Name Hash'
    // tokenLabel('fn1',_,_)        -> 'First Name Hash 2'
    // tokenLabel('em', 1, 3)       -> 'Email Hash 2'   (un-indexed token, but several occurrences)
    // tokenLabel('em', 0, 1)       -> 'Email Hash'
    function tokenLabel(key, occIdx, occTotal) {
        const m = key.match(/^([a-z]+)(\d+)?$/);
        if (!m) return key;
        const base = TOKEN_BASE[m[1]] || key;
        if (m[2] !== undefined) {
            const idx = parseInt(m[2], 10);
            return idx > 0 ? `${base} ${idx + 1}` : base;
        }
        if (occTotal && occTotal > 1) return `${base} ${occIdx + 1}`;
        return base;
    }

    function isHashToken(k)    { return /^(em|pn|fn|ln|sa)\d*$/.test(k); }
    function isCountryToken(k) { return /^co\d*$/.test(k); }

    // Gmail/Googlemail: Plus-Tag und Punkte im local-part entfernen, da Google
    // diese vor dem Hashen verwirft. Andere Domains: nur trim + lowercase.
    const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);
    function normalizeEmail(v) {
        const s = v.trim().toLowerCase();
        const at = s.lastIndexOf('@');
        if (at < 0) return s;
        const domain = s.slice(at + 1);
        if (!GMAIL_DOMAINS.has(domain)) return s;
        const local = s.slice(0, at).split('+')[0].replace(/\./g, '');
        return `${local}@${domain}`;
    }

    // Phone: alle Nicht-Ziffern entfernen, fuehrendes "+" beibehalten.
    // Default-Hash (Google Ads): MIT "+". Zusaetzlich Meta-Variante OHNE "+".
    function normalizePhone(v) {
        const cleaned = v.replace(/[^\d+]/g, '');
        if (cleaned.startsWith('+')) return '+' + cleaned.slice(1).replace(/\+/g, '');
        return cleaned.replace(/\+/g, '');
    }

    // Felder, die als Hash auftreten koennen -> Vergleichsfeld dynamisch
    const verifyFields = [
        { id: 'v_email',  label: 'Email',      placeholder: 'test@example.com', hashKeys: ['sha256_email_address', 'em'], normalize: normalizeEmail },
        { id: 'v_phone',  label: 'Phone',      placeholder: '+4912345678',      hashKeys: ['sha256_phone_number', 'pn'], normalize: normalizePhone },
        { id: 'v_fn',     label: 'First Name', placeholder: 'Max',              hashKeys: ['sha256_first_name', 'fn0'] },
        { id: 'v_ln',     label: 'Last Name',  placeholder: 'Mustermann',       hashKeys: ['sha256_last_name', 'ln0'] },
        { id: 'v_street', label: 'Street',     placeholder: 'Hauptstr. 1',      hashKeys: ['sha256_street', 'sa0'] }
    ];
    const hashKeyToVerifyId = {};
    verifyFields.forEach(f => f.hashKeys.forEach(k => { hashKeyToVerifyId[k] = f.id; }));

    // resolveVerifyId('fn0') -> 'v_fn'   resolveVerifyId('fn1') -> 'v_fn'
    function resolveVerifyId(k) {
        if (hashKeyToVerifyId[k]) return hashKeyToVerifyId[k];
        const baseKey = k.replace(/\d+$/, '0');
        if (baseKey !== k && hashKeyToVerifyId[baseKey]) return hashKeyToVerifyId[baseKey];
        return null;
    }

    // Top-level identifier fields (multi-value via array supported)
    const TOP_FIELDS  = ['email', 'sha256_email_address', 'phone_number', 'sha256_phone_number'];
    // Per-address fields (rendered once per address element)
    const ADDR_REPORT = ['first_name', 'sha256_first_name', 'last_name', 'sha256_last_name',
                         'street', 'sha256_street', 'city', 'region', 'postal_code', 'country'];

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

    // Phone-spezifisch: 'match' (Google Ads-konform mit "+"), 'meta-only'
    // (passt nur ohne fuehrendes "+", also Meta-Format), oder 'mismatch'.
    function evalMatch(observed, expected) {
        if (!expected) return 'mismatch';
        if (hashMatches(observed, expected)) return 'match';
        if (expected.metaAlt && hashMatches(observed, expected.metaAlt)) return 'meta-only';
        return 'mismatch';
    }

    function renderMatchStatus(observed, expected) {
        const kind = evalMatch(observed, expected);
        if (kind === 'match') return '<span class="match">MATCH</span>';
        if (kind === 'meta-only') {
            const tip = "Hash matched only without leading '+' — Meta CAPI format, not E.164-compliant for Google Ads.";
            return `<span class="match">MATCH</span><span class="fmt-warn" title="${tip}">META ONLY · NO '+'</span>`;
        }
        return '<span class="no-match">ERR</span>';
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

    function classifyEMInput(raw) {
        let s = (raw || '').trim();
        if (!s) return null;
        try { s = decodeURIComponent(s); } catch (e) { /* ignore */ }
        if (s.startsWith('eme=')) return 'eme';
        if (s.startsWith('em=')) return 'em';
        if (/(^|~)emkid\./.test(s) && /(^|~)ev\./.test(s) && !/(^|~)em\./.test(s)) return 'eme';
        return 'em';
    }

    function getEMKeys(raw) {
        const keys = new Set();
        if (!raw) return keys;
        let s = raw.trim();
        try { s = decodeURIComponent(s); } catch (e) { /* ignore */ }
        if (s.startsWith('eme=')) s = s.substring(4);
        else if (s.startsWith('em=')) s = s.substring(3);
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

    // Top-level field values (email/phone) — flattens arrays so multi-value
    // payloads (e.g. sha256_email_address: ['a','b']) yield separate rows.
    function getObjFieldValues(obj, key) {
        const out = [];
        if (!obj || typeof obj !== 'object') return out;
        const flatten = (v) => Array.isArray(v) ? v : [v];
        if (obj[key] !== undefined) flatten(obj[key]).forEach(v => out.push(v));
        if (obj.user_data && obj.user_data !== obj && obj.user_data[key] !== undefined) {
            flatten(obj.user_data[key]).forEach(v => out.push(v));
        }
        return out;
    }

    // Returns address objects from user_data.address or top-level address.
    // Both `address: {...}` and `address: [{...},{...}]` are normalized to an array.
    function collectAddresses(parsed) {
        if (!parsed || typeof parsed !== 'object') return [];
        const flatten = (v) => Array.isArray(v) ? v : [v];
        const src = (parsed.user_data && parsed.user_data.address !== undefined)
            ? parsed.user_data.address
            : (parsed.address !== undefined ? parsed.address : null);
        if (src === null) return [];
        return flatten(src).filter(a => a && typeof a === 'object' && !Array.isArray(a));
    }

    function renderObjRow(field, val, hashes, idx, total) {
        const verifyId = hashKeyToVerifyId[field];
        const enc = field.startsWith('sha256_') ? detectHashEncoding(String(val)) : null;
        let status = '';
        if (verifyId && hashes[verifyId]) {
            status = renderMatchStatus(String(val), hashes[verifyId]);
        }
        status += encPill(enc);
        if (field === 'country') status += countryWarning(val);
        const statusBlock = status.trim() ? `<div class="status-line">${status}</div>` : '';
        const labelSuffix = total > 1 ? ` ${idx + 1}` : '';
        return `<tr><td><b>${field}${labelSuffix}</b></td><td><code>${val}</code>${statusBlock}</td></tr>`;
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
        const visible = verifyFields.filter(f => {
            for (const ak of activeKeys) {
                if (resolveVerifyId(ak) === f.id) return true;
            }
            return false;
        });
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
        const mode = classifyEMInput(s);
        if (mode === 'eme' && s.startsWith('eme=')) s = s.substring(4);
        else if (s.startsWith('em=')) s = s.substring(3);

        const tokens = [];
        s.split('~').forEach(p => {
            const i = p.indexOf('.');
            if (i === -1) return;
            tokens.push({ k: p.substring(0, i), v: p.substring(i + 1) });
        });
        const tokenTotal = {};
        tokens.forEach(t => { tokenTotal[t.k] = (tokenTotal[t.k] || 0) + 1; });
        const tokenSeen = {};

        if (mode === 'eme') {
            let emeHtml = '<div class="enc-banner">&#9888; Encrypted parameter — cannot decode or verify. Showing visible metadata only.</div>';
            emeHtml += '<table class="res-table">';
            tokens.forEach(t => {
                const k = t.k, v = t.v;
                tokenSeen[k] = (tokenSeen[k] || 0) + 1;
                let label = k;
                if (k === 'tv') label = 'Version';
                else if (k === 'emkid') label = 'Encryption Key ID';
                else if (k === 'ev') label = 'Encrypted Value';
                let displayValue = v;
                if (k === 'ev' && v.length > 40) {
                    displayValue = v.slice(0, 40) + '…[encrypted, ' + v.length + ' chars]';
                }
                emeHtml += `<tr><td><b>${label}</b></td><td><code>${displayValue}</code></td></tr>`;
            });
            emeHtml += '</table>';
            target.innerHTML = emeHtml;
            return;
        }

        const compliance = renderCompliance(checkMinReq(emKeys));
        let html = compliance + '<table class="res-table">';
        tokens.forEach(t => {
            const k = t.k, v = t.v;
            tokenSeen[k] = (tokenSeen[k] || 0) + 1;
            const verifyId = resolveVerifyId(k);
            const enc = isHashToken(k) ? detectHashEncoding(v) : null;
            let status = '';
            if (verifyId && hashes[verifyId]) {
                status = renderMatchStatus(v, hashes[verifyId]);
            }
            status += encPill(enc);
            if (isCountryToken(k)) status += countryWarning(v);
            const statusBlock = status.trim() ? `<div class="status-line">${status}</div>` : '';
            const label = tokenLabel(k, tokenSeen[k] - 1, tokenTotal[k]);
            html += `<tr><td><b>${label}</b></td><td><code>${v}</code>${statusBlock}</td></tr>`;
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
        let html = typePill + structWarn + compliance;

        // 1) Top-level identifiers (email/phone) — multi-value via array supported
        let topRows = '';
        TOP_FIELDS.forEach(f => {
            const vals = getObjFieldValues(parsed, f);
            vals.forEach((v, i) => {
                if (v === undefined || v === null) return;
                topRows += renderObjRow(f, v, hashes, i, vals.length);
            });
        });
        if (topRows) html += '<table class="res-table">' + topRows + '</table>';

        // 2) Addresses — render each as own block when multiple
        const addresses = collectAddresses(parsed);
        addresses.forEach((addr, idx) => {
            let rows = '';
            ADDR_REPORT.forEach(f => {
                const v = addr[f];
                if (v === undefined || v === null) return;
                rows += renderObjRow(f, v, hashes, 0, 1);
            });
            if (!rows) return;
            const heading = addresses.length > 1
                ? `<h3 style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#64748b;margin:14px 0 6px;">Address ${idx + 1}</h3>`
                : '';
            html += heading + '<table class="res-table">' + rows + '</table>';
        });

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

        const emMode = classifyEMInput(emRaw);
        const emKeys = (emMode === 'eme') ? new Set() : getEMKeys(emRaw);
        const parsedObj = parseObj(objRaw);
        const objKeys = parsedObj ? collectObjKeys(parsedObj) : new Set();

        const tabKeys = getActiveTabId() === 'tab-obj' ? objKeys : emKeys;
        renderVerifyFields(tabKeys);

        const hashes = {};
        await Promise.all(verifyFields.map(async f => {
            const val = verifyState[f.id];
            if (!val) return;
            const normalized = f.normalize ? f.normalize(val) : val;
            const h = await sha256(normalized);
            if (f.id === 'v_phone' && normalized.startsWith('+')) {
                h.metaAlt = await sha256(normalized.slice(1));
            }
            hashes[f.id] = h;
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
    const recPermit     = document.getElementById('recPermit');
    const recToggle     = document.getElementById('recToggle');
    const recDot        = document.getElementById('recDot');
    const recStatusText = document.getElementById('recStatusText');
    const recCount      = document.getElementById('recCount');
    const recRing       = document.getElementById('recRing');
    const recClear      = document.getElementById('recClear');
    const recError      = document.getElementById('recError');
    const recAutoStop   = document.getElementById('recAutoStop');
    const recIncludeSubs = document.getElementById('recIncludeSubs');
    const recUdIndicator = document.getElementById('recUdIndicator');
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
    let filterIncludeGa = true;
    let includeSubdomains = false;

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

    // When the "include subdomains" toggle is on, broaden the origin to a
    // wildcard match for the base domain. Heuristic: keep the last two host
    // labels (works for most TLDs; fails for multi-label public suffixes like
    // .co.uk — the user can edit the URL field to override). Chrome match
    // patterns of the form *.example.com also cover the apex example.com.
    function normalizeOriginForPermit(input) {
        const o = normalizeOrigin(input);
        if (!o) return null;
        if (!includeSubdomains) return o;
        try {
            const u = new URL(o);
            const parts = u.host.split('.');
            const base = parts.length <= 2 ? u.host : parts.slice(-2).join('.');
            return `${u.protocol}//*.${base}/*`;
        } catch (e) { return o; }
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

    // Map nested user_data keys to the same pill tokens used for em parsing,
    // so user_data captures display the same identifier vocabulary.
    const USERDATA_KEY_TO_PILL = {
        email: 'em', email_address: 'em', sha256_email_address: 'em',
        phone_number: 'pn', sha256_phone_number: 'pn',
        first_name: 'fn0', sha256_first_name: 'fn0',
        last_name: 'ln0', sha256_last_name: 'ln0',
        street: 'sa0', sha256_street: 'sa0',
        city: 'ct0',
        region: 'st0',
        postal_code: 'zp0',
        country: 'co0'
    };

    function collectUserDataKeys(node, out) {
        if (!node || typeof node !== 'object') return out;
        if (Array.isArray(node)) { node.forEach(n => collectUserDataKeys(n, out)); return out; }
        Object.keys(node).forEach(k => {
            out.add(k);
            if (node[k] && typeof node[k] === 'object') collectUserDataKeys(node[k], out);
        });
        return out;
    }

    function userDataMarkerPill(userData) {
        return userData
            ? '<span class="cap-pill source-userdata" title="Request also carries user_data event parameters (ep.user_data.*) — click switches to em decoder when em is present, otherwise to Object Analysis">user_data</span>'
            : '';
    }

    function renderPills(em, eme, userData) {
        const pills = [];

        if (em) {
            const counts = {};
            let s = em.trim();
            try { s = decodeURIComponent(s); } catch (e) { /* ignore */ }
            if (s.startsWith('em=')) s = s.substring(3);
            s.split('~').forEach(p => {
                const i = p.indexOf('.');
                if (i === -1) return;
                const k = p.substring(0, i);
                counts[k] = (counts[k] || 0) + 1;
            });
            const keys = new Set(Object.keys(counts));
            const ordered = PILL_ORDER.filter(k => keys.has(k));

            if (ordered.length === 0) {
                pills.push('<span class="cap-pill none" title="em present but no recognized identifier tokens">no identifiers</span>');
            } else {
                let addrCount = 1;
                for (const k of keys) {
                    const m = k.match(/^(fn|ln|sa|ct|st|zp|pc|rg|co)(\d+)$/);
                    if (m) addrCount = Math.max(addrCount, parseInt(m[2], 10) + 1);
                }
                ordered.forEach(k => {
                    const cls = PILL_CLASS[k] || '';
                    const label = PILL_LABEL[k] || k;
                    let display = k, tip = label;
                    if ((k === 'em' || k === 'pn') && counts[k] > 1) {
                        display = `${k} +${counts[k] - 1}`;
                        tip = `${label} (${counts[k]} total)`;
                    }
                    pills.push(`<span class="cap-pill ${cls}" title="${tip}">${display}</span>`);
                });
                if (addrCount > 1) {
                    pills.push(`<span class="cap-pill identifier-addr" title="${addrCount} addresses total">+${addrCount - 1} addr</span>`);
                }
            }
            if (eme) pills.push('<span class="cap-pill identifier-eme" title="Also carries encrypted eme — cannot decode">eme</span>');
            pills.push(userDataMarkerPill(userData));
            return pills.filter(Boolean).join('');
        }

        if (eme) {
            pills.push('<span class="cap-pill identifier-eme" title="Encrypted parameter — cannot decode here">eme</span>');
            pills.push(userDataMarkerPill(userData));
            return pills.filter(Boolean).join('');
        }

        if (userData) {
            const keys = collectUserDataKeys(userData, new Set());
            const mapped = new Set();
            keys.forEach(k => { if (USERDATA_KEY_TO_PILL[k]) mapped.add(USERDATA_KEY_TO_PILL[k]); });
            const ordered = PILL_ORDER.filter(k => mapped.has(k));
            ordered.forEach(k => {
                const cls = PILL_CLASS[k] || '';
                const label = PILL_LABEL[k] || k;
                pills.push(`<span class="cap-pill ${cls}" title="${label} (from user_data)">${k}</span>`);
            });
            pills.push(userDataMarkerPill(userData));
            return pills.filter(Boolean).join('');
        }

        return '<span class="cap-pill none" title="No em, eme or user_data found in this request">no user data</span>';
    }

    function renderCaptures() {
        recCount.textContent = captures.length;
        const visible = captures.filter(c => {
            if (filterEmOnly && !c.em && !c.eme && !c.userData) return false;
            if (!filterIncludeGa && (c.source || 'ads') === 'ga') return false;
            return true;
        });
        if (visible.length === 0) {
            capList.innerHTML = '';
            capList.hidden = true;
            capEmpty.hidden = false;
            if (captures.length === 0) {
                capEmpty.textContent = 'No captures yet — start recording to collect requests.';
            } else if (!filterIncludeGa && captures.every(c => (c.source || 'ads') === 'ga')) {
                capEmpty.textContent = 'Only GA captures present — enable the GA filter to see them.';
            } else {
                capEmpty.textContent = 'No captures with user data — uncheck the filter to see all requests.';
            }
            return;
        }
        capList.hidden = false;
        capEmpty.hidden = true;
        capList.innerHTML = visible.slice().reverse().map(c => {
            const realIdx = captures.indexOf(c);
            const hasIdentifier = !!(c.em || c.eme || c.userData);
            const transport = c.transport || 'google';
            const source = c.source || 'ads';
            return `<div class="cap-card ${hasIdentifier ? '' : 'no-em'} source-${source} transport-${transport}" data-idx="${realIdx}">
                <button class="cap-detail-btn" data-detail-idx="${realIdx}" aria-label="Show details" title="Show details">i</button>
                <div class="cap-card-head">
                    <span class="cap-time">${formatTime(c.ts)}</span>
                    <span class="cap-method">${c.method}</span>
                    <span class="cap-host">${shortenUrl(c.url, c.host)}</span>
                </div>
                <div class="cap-card-pills">${renderPills(c.em, c.eme, c.userData)}</div>
            </div>`;
        }).join('');
        capList.querySelectorAll('.cap-card').forEach(card => {
            card.addEventListener('click', () => {
                const idx = Number(card.dataset.idx);
                const cap = captures[idx];
                if (!cap) return;
                if (cap.em || cap.eme) {
                    emInput.value = cap.em ? cap.em : 'eme=' + cap.eme;
                    activateTab('tab-em');
                    chrome.storage.local.set({ activeTab: 'tab-em' });
                    runUpdate();
                    emInput.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                } else if (cap.userData) {
                    objInput.value = JSON.stringify({ user_data: cap.userData }, null, 2);
                    activateTab('tab-obj');
                    chrome.storage.local.set({ activeTab: 'tab-obj' });
                    runUpdate();
                    objInput.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                }
            });
        });
        capList.querySelectorAll('.cap-detail-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = Number(btn.dataset.detailIdx);
                const cap = captures[idx];
                if (cap) openDetail(cap);
            });
        });
    }

    const recUrlReload = document.getElementById('recUrlReload');

    function setRecordingUI(rec) {
        recording = rec;
        recDot.classList.toggle('live', rec);
        recStatusText.textContent = rec ? 'recording' : 'idle';
        recToggle.textContent = rec ? 'Stop' : 'Start';
        recToggle.classList.toggle('primary', !rec);
        recToggle.classList.toggle('danger', rec);
    }

    function fillUrlFromActiveTab(opts) {
        const respectFocus = !!(opts && opts.respectFocus);
        if (respectFocus && document.activeElement === recUrl) return;
        try {
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                if (tabs && tabs[0] && tabs[0].url) {
                    try {
                        const u = new URL(tabs[0].url);
                        if (u.protocol.startsWith('http')) {
                            recUrl.value = `${u.protocol}//${u.host}/*`;
                            showError('');
                            refreshPermitButton();
                        }
                    } catch (e) {}
                }
            });
        } catch (e) {}
    }

    recUrl.addEventListener('input', () => refreshPermitButton());

    recUrlReload.addEventListener('click', () => fillUrlFromActiveTab());

    // Auto-update URL field when the user switches tabs or navigates the active
    // tab — only when the field is not currently focused (respect user edits).
    try {
        chrome.tabs.onActivated.addListener(() => fillUrlFromActiveTab({ respectFocus: true }));
        chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
            if (!changeInfo.url) return;
            if (!tab || !tab.active) return;
            fillUrlFromActiveTab({ respectFocus: true });
        });
    } catch (e) { /* tabs API unavailable */ }

    function showError(msg) {
        if (!msg) { recError.hidden = true; recError.textContent = ''; return; }
        recError.hidden = false;
        recError.textContent = msg;
    }

    async function isOriginPermitted(origin) {
        if (!origin) return false;
        try {
            return await chrome.permissions.contains({ origins: [origin] });
        } catch (e) {
            return false;
        }
    }

    async function refreshPermitButton() {
        const checkOrigin = normalizeOrigin(recUrl.value);
        if (!checkOrigin) {
            recPermit.textContent = 'Permit';
            recPermit.disabled = true;
            recPermit.title = 'Enter an origin to permit';
            return;
        }
        const permitted = await isOriginPermitted(checkOrigin);
        if (permitted) {
            recPermit.textContent = 'Permitted ✓';
            recPermit.disabled = true;
            recPermit.title = checkOrigin + ' is already covered by an existing permission';
        } else {
            const permitOrigin = normalizeOriginForPermit(recUrl.value) || checkOrigin;
            recPermit.textContent = 'Permit';
            recPermit.disabled = false;
            recPermit.title = 'Grant access to ' + permitOrigin;
        }
    }

    async function permitFlow() {
        showError('');
        const origin = normalizeOriginForPermit(recUrl.value);
        if (!origin) {
            showError('Invalid URL — provide e.g. https://example.com');
            return;
        }
        try {
            const granted = await chrome.permissions.request({ origins: [origin] });
            if (!granted) {
                showError('Permission denied for ' + origin);
                return;
            }
            refreshPermList();
            refreshPermitButton();
        } catch (e) {
            showError('Permission request failed: ' + e.message);
        }
    }

    async function startRecordingFlow() {
        showError('');
        const raw = recUrl.value.trim();
        if (raw) {
            const origin = normalizeOrigin(raw);
            if (!origin) {
                showError('Invalid URL — provide e.g. https://example.com, or clear the field to capture only the standard Google endpoints.');
                return;
            }
            const permitted = await isOriginPermitted(origin);
            if (!permitted) {
                showError('Site not permitted — click Permit first, or clear the URL field to capture only the standard Google endpoints.');
                return;
            }
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

    recPermit.addEventListener('click', permitFlow);
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

    const recFilterGa = document.getElementById('recFilterGa');
    recFilterGa.addEventListener('change', () => {
        filterIncludeGa = recFilterGa.checked;
        chrome.storage.local.set({ recFilterGa: filterIncludeGa });
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
        const exportSet = filterEmOnly ? captures.filter(c => !!(c.em || c.eme || c.userData)) : captures;
        if (exportSet.length === 0) {
            showError('Nothing to export.');
            setTimeout(() => showError(''), 2000);
            return;
        }
        const payload = {
            exportedAt: new Date().toISOString(),
            filter: filterEmOnly ? 'user-data-only' : 'all',
            count: exportSet.length,
            captures: exportSet.map(c => ({
                ts: c.ts,
                tsIso: new Date(c.ts).toISOString(),
                method: c.method,
                host: c.host,
                url: c.url,
                em: c.em,
                eme: c.eme || null,
                userData: c.userData || null,
                source: c.source || 'ads',
                transport: c.transport || 'google'
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
    chrome.storage.local.get(['recFilterEm', 'recFilterGa', 'recAutoStop', 'recIncludeSubs', 'recUdIndicator'], (res) => {
        // Default to true if never set
        filterEmOnly = (res.recFilterEm === undefined) ? true : !!res.recFilterEm;
        filterIncludeGa = (res.recFilterGa === undefined) ? true : !!res.recFilterGa;
        const autoStop = (res.recAutoStop === undefined) ? true : !!res.recAutoStop;
        includeSubdomains = !!res.recIncludeSubs;
        const udIndicator = !!res.recUdIndicator;
        recFilterEm.checked = filterEmOnly;
        recFilterGa.checked = filterIncludeGa;
        recAutoStop.checked = autoStop;
        recIncludeSubs.checked = includeSubdomains;
        recUdIndicator.checked = udIndicator;
        sendAutoStopOption(autoStop);
        chrome.runtime.sendMessage({ type: 'setIndicator', enabled: udIndicator });
        refreshPermitButton();
        renderCaptures();
    });

    // Long-lived port — the SW uses port.onDisconnect to detect panel close
    // and stops recording when the user has the auto-stop option enabled.
    let panelPort = null;
    try { panelPort = chrome.runtime.connect({ name: 'panel' }); } catch (e) { panelPort = null; }

    function sendAutoStopOption(autoStop) {
        if (!panelPort) return;
        try { panelPort.postMessage({ type: 'panelOption', autoStop: !!autoStop }); } catch (e) {}
    }

    recAutoStop.addEventListener('change', () => {
        const v = recAutoStop.checked;
        chrome.storage.local.set({ recAutoStop: v });
        sendAutoStopOption(v);
    });

    recIncludeSubs.addEventListener('change', () => {
        includeSubdomains = recIncludeSubs.checked;
        chrome.storage.local.set({ recIncludeSubs: includeSubdomains });
        refreshPermitButton();
    });

    recUdIndicator.addEventListener('change', () => {
        const v = recUdIndicator.checked;
        chrome.storage.local.set({ recUdIndicator: v });
        chrome.runtime.sendMessage({ type: 'setIndicator', enabled: v });
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

    // ---------- Detail Modal (TODO 3) ----------
    const detModal = document.getElementById('detailModal');
    const detMeta  = document.getElementById('detMeta');
    const detTrunc = document.getElementById('detTrunc');
    const detQuery = document.getElementById('detQuery');
    const detBody  = document.getElementById('detBody');

    function escClose(e) { if (e.key === 'Escape') closeDetail(); }

    function openDetail(cap) {
      if (!cap) return;
      detModal.hidden = false;
      document.body.style.overflow = 'hidden';
      document.addEventListener('keydown', escClose);

      detMeta.innerHTML = `${formatTime(cap.ts)} · ${escapeHtml(cap.method)} · <code>${escapeHtml(cap.url)}</code>`;
      detTrunc.hidden = !cap.truncated;
      renderParamTable(detQuery, cap.queryParams || {}, ['em']);
      renderParamTable(detBody,  cap.bodyParams === undefined ? null : cap.bodyParams, []);
    }

    function closeDetail() {
      detModal.hidden = true;
      document.body.style.overflow = '';
      document.removeEventListener('keydown', escClose);
    }

    function renderParamTable(table, params, prioKeys) {
      if (params === null) {
        table.innerHTML = '<tr><td><em>No request body</em></td></tr>';
        return;
      }
      if (params && params.__truncated__) {
        table.innerHTML = `<tr><td><em>Truncated (${params.__sizeBytes__} bytes original)</em></td></tr>`;
        return;
      }
      const keys = Object.keys(params);
      if (keys.length === 0) {
        table.innerHTML = '<tr><td><em>(empty)</em></td></tr>';
        return;
      }
      const sorted = [...keys].sort();
      const ordered = [
        ...prioKeys.filter(k => keys.includes(k)),
        ...sorted.filter(k => !prioKeys.includes(k))
      ];
      table.innerHTML = ordered.map(k => {
        const v = String(params[k]);
        const cell = v.length > 80
          ? `<details><summary><code>${escapeHtml(v.slice(0,80))}…</code></summary><code>${escapeHtml(v)}</code></details>`
          : `<code>${escapeHtml(v)}</code>`;
        return `<tr><td><b>${escapeHtml(k)}</b></td><td>${cell}</td></tr>`;
      }).join('');
    }

    function escapeHtml(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    detModal.querySelector('.modal-backdrop').addEventListener('click', closeDetail);
    detModal.querySelector('.modal-close').addEventListener('click', closeDetail);

    // ---------- Permitted Sites (TODO 1) ----------
    const STATIC_ORIGINS = new Set([
      'https://*.googleadservices.com/pagead/*',
      'https://*.googleadservices.com/ccm/*',
      'https://www.google.com/pagead/*',
      'https://www.google.com/ccm/*',
      'https://www.google-analytics.com/g/collect*',
      'https://*.google-analytics.com/g/collect*',
      'https://*.analytics.google.com/g/collect*'
    ]);
    // Chrome kollabiert die Manifest-Patterns oft zu breiteren Forms:
    //   "https://*.googleadservices.com/*"  und  "https://www.google.com/*"
    // Daher matchen wir am Host, nicht am exakten Pattern.
    function isStaticOrigin(o) {
      if (STATIC_ORIGINS.has(o)) return true;
      return /\/\/(\*\.)?googleadservices\.com\//.test(o)
          || /\/\/www\.google\.com\//.test(o)
          || /\/\/([\w*-]+\.)*google-analytics\.com\//.test(o)
          || /\/\/([\w*-]+\.)*analytics\.google\.com\//.test(o);
    }

    const permDetails = document.getElementById('permDetails');
    const permCount   = document.getElementById('permCount');
    const permList    = document.getElementById('permList');

    async function refreshPermList() {
      const perms = await chrome.permissions.getAll();
      const optional = (perms.origins || []).filter(o => !isStaticOrigin(o));
      permCount.textContent = String(optional.length);
      if (optional.length === 0) {
        permDetails.setAttribute('disabled', '');
        permDetails.open = false;
      } else {
        permDetails.removeAttribute('disabled');
      }
      permList.innerHTML = optional.map(o => `
        <li><code>${escapeHtml(o)}</code><button class="perm-revoke" data-origin="${escapeHtml(o)}" aria-label="Revoke ${escapeHtml(o)}">×</button></li>
      `).join('');
      permList.querySelectorAll('.perm-revoke').forEach(btn => {
        btn.addEventListener('click', () => revokeOrigin(btn.dataset.origin));
      });
    }

    async function revokeOrigin(origin) {
      if (recording) {
        await new Promise(resolve => {
          chrome.runtime.sendMessage({ type: 'stopRecording' }, () => {
            void chrome.runtime.lastError;
            resolve();
          });
        });
        setRecordingUI(false);
        showError('Recording gestoppt — Origin entfernt');
        setTimeout(() => showError(''), 2500);
      }
      chrome.permissions.remove({ origins: [origin] }, () => {
        void chrome.runtime.lastError;
        // refreshPermList wird via onRemoved-Listener angestossen
      });
    }

    chrome.permissions.onAdded.addListener(() => { refreshPermList(); refreshPermitButton(); });
    chrome.permissions.onRemoved.addListener(() => { refreshPermList(); refreshPermitButton(); });
    refreshPermList();
    refreshPermitButton();
});
