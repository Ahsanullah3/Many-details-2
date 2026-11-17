const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const os = require('os');
const path = require('path');

puppeteer.use(StealthPlugin());

// =========================================================
// CONFIG — SPEED OPTIMIZED
// =========================================================
const CONCURRENCY = Number(process.env.CONCURRENCY || '6');                 // ↑ 4→6
const MAX_URLS_PER_RUN = Number(process.env.MAX_URLS_PER_RUN || '150');
const FLUSH_EVERY = 5;
const REQUIRED_COLS = 34;
const MAX_CONSECUTIVE_BLOCK_STREAKS = Number(process.env.MAX_BLOCK_STREAK || '6');
const MAX_CONSECUTIVE_ERRORS = 6;
const MAX_RUNTIME_MS = 60 * 60 * 1000;
const RECYCLE_BROWSER_EVERY = Number(process.env.RECYCLE_BROWSER_EVERY || '15'); // ↑ 2→15

const RETRY_BLOCKED = process.env.RETRY_BLOCKED !== '0';

const HEADFUL = process.env.HEADFUL === '1';
const CHROME_PATH = process.env.CHROME_PATH || '';
const CHROME_CHANNEL = process.env.CHROME_CHANNEL || '';

const BLOCK_RESOURCES = process.env.BLOCK_RESOURCES === '1';
const INCLUDE_PAGE_TEXT = true;
const DEBUG_DUMP = process.env.DEBUG_DUMP === '1';

const VIEWPORT_W = Number(process.env.VIEWPORT_W || '1400');
const VIEWPORT_H = Number(process.env.VIEWPORT_H || '900');
const NAV_DELAY_MIN = Number(process.env.NAV_DELAY_MIN || '200');            // ↓ 500→200
const NAV_DELAY_MAX = Number(process.env.NAV_DELAY_MAX || '900');            // ↓ 2000→900
const HYDRATE_TIMEOUT = Number(process.env.HYDRATE_TIMEOUT || '8000');       // ↓ 12s→8s
const HYDRATE_SETTLE = Number(process.env.HYDRATE_SETTLE || '400');          // ↓ 800→400
const HISTORY_WAIT_MS = Number(process.env.HISTORY_WAIT_MS || '12000');      // ↓ 20s→12s
const HISTORY_FALLBACK_MS = Number(process.env.HISTORY_FALLBACK_MS || '5000'); // ↓ 8s→5s
const SHOW_MORE_SETTLE_MS = Number(process.env.SHOW_MORE_SETTLE_MS || '500'); // ↓ 900→500
const SCROLL_STEP_DELAY = Number(process.env.SCROLL_STEP_DELAY || '150');    // ↓ 350→150
const SCROLL_STEP_PX = Number(process.env.SCROLL_STEP_PX || '600');          // ↑ 400→600

// Captcha
const CAPTCHA_HOLD_MS = Number(process.env.CAPTCHA_HOLD_MS || '30000');      // ✅ 30s
const WARMUP_URL = process.env.WARMUP_URL || 'https://www.zillow.com/';
const WARMUP_SETTLE = Number(process.env.WARMUP_SETTLE || '1500');           // ↓ 4000→1500

const HEADER_START_COL = 9;
const HEADERS = [
    "Price", "Street", "City", "State", "Zipcode", "Final URL", "Agent Details", "Sold Price",
    "Status", "Description", "Full Address", "Price Per Sqft", "Beds", "Baths", "Sqft", "Lot Size",
    "Listed For Sale", "Sold On", "MLS", "Property Type", "Year Built", "HOA",
    "Price History", "Facts & Features", "Page Text (Formatted)"
];
const OVERWRITE_HEADERS = process.env.OVERWRITE_HEADERS === '1';

console.log(`🧩 Resource blocking: ${BLOCK_RESOURCES ? 'ON' : 'OFF'} | headful: ${HEADFUL} | pageText: ON | warmup: ${WARMUP_URL}`);

const isSkipStatus = (st) => /BLOCKED|No data|Error|Empty parse|no history|captcha/i.test(String(st || ''));
const isDoneStatus = (st) => /✅/.test(String(st || ''));

const delay = (ms) => new Promise(r => setTimeout(r, ms));
const jitter = (min, max) => min + Math.floor(Math.random() * Math.max(1, max - min));

const MAX_CELL_LEN = 49000;
const MAX_PAGETEXT_LEN = 49900;
const safeCell = (v, limit = MAX_CELL_LEN) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return s.length > limit ? s.slice(0, limit) + "…[truncated]" : s;
};

const AD_HOSTS = /doubleclick|googletagmanager|google-analytics|googlesyndication|facebook\.net|facebook\.com|criteo|taboola|adsrvr|tiktok|snapchat|hotjar|fullstory|bing\.com|quantserve|scorecardresearch/i;

// =========================================================
// CAPTCHA DETECTION & SOLVER
// =========================================================
async function detectCaptcha(page) {
    return page.evaluate(() => {
        if (document.querySelector('.px-captcha-container')) return 'press-hold';
        const iframe = document.querySelector('iframe[title*="Human verification" i], iframe[title*="captcha" i]');
        if (iframe) return 'iframe';
        const bodyText = document.body ? document.body.textContent : '';
        if (/Press\s*&\s*Hold|confirm you are a human|not a bot/i.test(bodyText)) return 'text';
        if (document.querySelector('.px-captcha-refid')) return 'refid';
        return null;
    }).catch(() => null);
}

async function solvePressAndHold(page, tag) {
    const captchaType = await detectCaptcha(page);
    if (!captchaType) return true;

    console.log(`   🧩 [${tag}] Captcha detected (${captchaType}) — solving`);

    try {
        const iframeHandle = await page.$('iframe[title*="Human verification" i], iframe[title*="captcha" i], #px-captcha iframe').catch(() => null);

        if (iframeHandle) {
            const frame = await iframeHandle.contentFrame().catch(() => null);
            if (frame) {
                const btn = await frame.$('button, [role="button"], div[style*="cursor"]').catch(() => null);
                if (btn) {
                    const box = await btn.boundingBox().catch(() => null);
                    if (box) {
                        const cx = box.x + box.width / 2;
                        const cy = box.y + box.height / 2;
                        await page.mouse.move(cx, cy);
                        await delay(200);
                        await page.mouse.down();
                        console.log(`   🖱️ [${tag}] Holding ${CAPTCHA_HOLD_MS}ms...`);
                        await delay(CAPTCHA_HOLD_MS);
                        await page.mouse.move(cx + 2, cy + 1, { steps: 3 }).catch(() => {});
                        await page.mouse.up();
                        console.log(`   🖱️ [${tag}] Hold complete`);
                    }
                }
            }
        }

        // Keyboard fallback
        if (await detectCaptcha(page)) {
            console.log(`   ⌨️ [${tag}] Trying keyboard`);
            await page.keyboard.press('Tab').catch(() => {});
            await delay(300);
            await page.keyboard.down('Space');
            await delay(CAPTCHA_HOLD_MS);
            await page.keyboard.up('Space');
        }

        // DOM removal fallback
        if (await detectCaptcha(page)) {
            console.log(`   🔧 [${tag}] Removing captcha DOM`);
            await page.evaluate(() => {
                document.querySelectorAll('.px-captcha-container, #px-captcha, .px-captcha-refid').forEach(el => el.remove());
                document.documentElement.style.overflow = '';
                document.documentElement.removeAttribute('data-hdp-scroll-locked');
                document.body.style.overflow = '';
                document.body.style.position = '';
                document.querySelectorAll('[class*="backdrop" i], [class*="overlay" i]').forEach(el => {
                    const r = el.getBoundingClientRect();
                    if (r.width > window.innerWidth * 0.8 && r.height > window.innerHeight * 0.8) el.remove();
                });
            }).catch(() => {});
            await delay(800);
        }

        await delay(2500); // was 5000 — faster; cookie write usually < 2s
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 25000 }).catch(() => {});
        await delay(1200);

        const stillBlocked = await detectCaptcha(page);
        if (!stillBlocked) {
            console.log(`   ✅ [${tag}] Captcha solved`);
            return true;
        }
        console.log(`   ❌ [${tag}] Captcha unsolved`);
        return false;
    } catch (e) {
        console.log(`   ⚠️ [${tag}] Captcha error: ${e.message}`);
        return false;
    }
}

// =========================================================
// WARM-UP
// =========================================================
async function warmUpSession(page, tag) {
    try {
        await page.goto(WARMUP_URL, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await delay(WARMUP_SETTLE);
        const warmupCaptcha = await detectCaptcha(page);
        if (warmupCaptcha) {
            console.log(`   🧩 [${tag}] Captcha on warmup`);
            await solvePressAndHold(page, tag);
        }
        await page.evaluate(() => window.scrollBy(0, 150)).catch(() => {});
        await delay(500);
        await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
        await delay(200);
        return true;
    } catch (e) {
        return false;
    }
}

// =========================================================
// BROWSER
// =========================================================
async function launchBrowser() {
    const userDataDir = path.join(os.tmpdir(), `zillow-profile-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        `--window-size=${VIEWPORT_W},${VIEWPORT_H}`,
        '--autoplay-policy=no-user-gesture-required',
        '--lang=en-US,en',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
    ];
    const opts = { headless: HEADFUL ? false : true, userDataDir, args };
    if (CHROME_PATH) opts.executablePath = CHROME_PATH;
    else if (CHROME_CHANNEL) opts.channel = CHROME_CHANNEL;
    const browser = await puppeteer.launch(opts);
    browser.__userDataDir = userDataDir;
    return browser;
}

async function closeBrowser(browser) {
    if (!browser) return;
    try { await browser.close(); } catch (e) {}
    try { if (browser.__userDataDir) fs.rmSync(browser.__userDataDir, { recursive: true, force: true }); } catch (e) {}
}

async function newContext(browser) {
    return typeof browser.createBrowserContext === 'function'
        ? browser.createBrowserContext()
        : browser.createIncognitoBrowserContext();
}

// =========================================================
// SHEETS HELPERS
// =========================================================
async function saveWithRetry(sheet, retries = 4) {
    for (let i = 0; i < retries; i++) {
        try { await sheet.saveUpdatedCells(); return; }
        catch (error) {
            if (i === retries - 1) throw error;
            await delay((2 ** i) * 1000);
        }
    }
}

function safeValue(sheet, row, col) {
    try {
        const v = sheet.getCell(row, col).value;
        return v === null || v === undefined ? "" : String(v);
    } catch (e) { return ""; }
}

function findNextRow(sheet, afterRow, mode) {
    for (let r = afterRow + 1; r < sheet.rowCount; r++) {
        const url = safeValue(sheet, r, 0);
        if (!url || !url.includes("zillow.com")) continue;
        const status = safeValue(sheet, r, 17);
        if (isDoneStatus(status)) continue;
        const skipped = isSkipStatus(status);
        if (mode === 'fresh' && skipped) continue;
        if (mode === 'skipped' && !skipped) continue;
        return r;
    }
    return -1;
}

const urlKey = (u) => String(u).trim().split('#')[0].split('?')[0].replace(/\/+$/, '').toLowerCase();

// =========================================================
// SLOW SCROLL (faster)
// =========================================================
async function slowScrollToBottom(page, tag) {
    try {
        await page.evaluate(() => window.scrollTo(0, 0));
        await delay(200);

        let lastHeight = 0;
        let stableRounds = 0;
        const maxRounds = 50; // ↓ 90→50
        for (let round = 0; round < maxRounds; round++) {
            const info = await page.evaluate((stepPx) => {
                window.scrollBy(0, stepPx);
                return { y: window.scrollY, h: document.body.scrollHeight, inner: window.innerHeight };
            }, SCROLL_STEP_PX).catch(() => null);
            if (!info) break;

            await delay(SCROLL_STEP_DELAY);

            if (info.h !== lastHeight) {
                lastHeight = info.h;
                stableRounds = 0;
            } else {
                stableRounds++;
            }

            const atBottom = (info.y + info.inner) >= (info.h - 5);
            if (atBottom && stableRounds >= 2) break;
        }

        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await delay(400);
        await page.evaluate(() => window.scrollTo(0, Math.max(0, document.body.scrollHeight - window.innerHeight * 2)));
        await delay(250);
    } catch (e) {
        console.log(`   ⚠️ [${tag}] slowScroll error: ${e.message}`);
    }
}

// =========================================================
// PRICE HISTORY
// =========================================================
async function getPriceHistory(page, tag) {
    await slowScrollToBottom(page, tag);

    let found = await page.waitForFunction(() => {
        const norm = (s) => (s || '').replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
        const h = Array.from(document.querySelectorAll('h2,h3,h4'))
            .find(x => norm(x.textContent) === 'price history');
        if (!h) return false;
        let root = h.parentElement;
        for (let i = 0; i < 5 && root; i++) {
            const t = root.querySelector('table');
            if (t && t.querySelectorAll('tbody tr').length > 0) return true;
            root = root.parentElement;
        }
        return false;
    }, { timeout: HISTORY_WAIT_MS, polling: 300 }).then(() => true).catch(() => false);

    if (!found) {
        found = await page.waitForFunction(() => {
            return document.querySelectorAll('[data-testid="date-info"]').length > 0;
        }, { timeout: HISTORY_FALLBACK_MS, polling: 300 }).then(() => true).catch(() => false);
        if (found) console.log(`   📊 [${tag}] Heading missing but date-info cells found`);
    }

    if (!found) {
        console.log(`   📊 [${tag}] Price history DOM NOT found`);
        return { rows: [], found: false };
    }

    let prevCount = -1, clicks = 0;
    for (let i = 0; i < 20; i++) {
        const state = await page.evaluate(() => {
            const norm = (s) => (s || '').replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
            let table = null;
            const h = Array.from(document.querySelectorAll('h2,h3,h4'))
                .find(x => norm(x.textContent) === 'price history');
            if (h) {
                let root = h.parentElement;
                for (let j = 0; j < 5 && root; j++) { table = root.querySelector('table'); if (table) break; root = root.parentElement; }
            }
            if (!table) {
                const cell = document.querySelector('[data-testid="date-info"]');
                if (cell) table = cell.closest('table');
            }
            if (!table) return { count: 0, clicked: false };

            const count = table.querySelectorAll('tbody tr').length;
            const root2 = table.closest('div') || table.parentElement;
            const btn = (root2 && root2.querySelector('tfoot[data-testid="table-see-more"] button, tfoot button')) ||
                        document.querySelector('tfoot[data-testid="table-see-more"] button, tfoot button');
            if (btn && /show more|see more/i.test(btn.textContent || '')) {
                btn.scrollIntoView({ block: 'center' });
                btn.click();
                return { count, clicked: true };
            }
            return { count, clicked: false };
        }).catch(() => ({ count: 0, clicked: false }));

        if (!state.clicked) break;
        clicks++;
        await delay(SHOW_MORE_SETTLE_MS);
        if (state.count === prevCount && clicks >= 2) break;
        prevCount = state.count;
    }
    if (clicks) console.log(`   🔽 [${tag}] Expanded (${clicks} click(s))`);

    await page.evaluate(() => {
        const cell = document.querySelector('[data-testid="date-info"]');
        if (cell) cell.scrollIntoView({ block: 'start' });
    }).catch(() => {});
    await delay(300);

    const rows = await page.evaluate(() => {
        const clean = (s) => (s || '').replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
        const norm = (s) => clean(s).toLowerCase();
        let table = null;
        const h = Array.from(document.querySelectorAll('h2,h3,h4'))
            .find(x => norm(x.textContent) === 'price history');
        if (h) {
            let root = h.parentElement;
            for (let i = 0; i < 5 && root; i++) { table = root.querySelector('table'); if (table) break; root = root.parentElement; }
        }
        if (!table) {
            const cell = document.querySelector('[data-testid="date-info"]');
            if (cell) table = cell.closest('table');
        }
        if (!table) return [];

        const out = [];
        for (const tr of table.querySelectorAll('tbody tr')) {
            const dateEl = tr.querySelector('[data-testid="date-info"]');
            const label = tr.getAttribute('label') || '';
            if (!dateEl && !label) continue;

            const lm = label.match(/Date:\s*(.+?),\s*Event:\s*(.+?),\s*Price:\s*(.*)$/i);
            const cells = tr.querySelectorAll('td');
            const date = clean(dateEl && dateEl.textContent) || (lm ? clean(lm[1]) : '');
            const event = (cells[1] ? clean(cells[1].textContent) : '') || (lm ? clean(lm[2]) : '');

            let price = '', change = '', ppsf = '';
            const priceCell = tr.querySelector('[data-testid="price-money-cell"]');
            if (priceCell) {
                const first = priceCell.querySelector('span > span');
                price = clean(first && first.textContent);
                const pct = priceCell.querySelector('[data-testid="percent-display"]');
                change = clean(pct && pct.textContent);
                const last = priceCell.lastElementChild;
                const lastTxt = clean(last && last.textContent);
                if (/sqft/i.test(lastTxt)) ppsf = lastTxt;
            }
            if (!price && lm) {
                const raw = clean(lm[3]);
                if (!change) change = (raw.match(/\(([^)]+)\)/) || [])[1] || '';
                price = raw.replace(/\s*\(.*\)\s*/, '').replace(/\s*null$/i, '').trim();
            }
            if (/^[-—–]+$/.test(price)) price = '';

            let source = '';
            const next = tr.nextElementSibling;
            if (next && !next.hasAttribute('label') && !next.querySelector('[data-testid="date-info"]')) {
                source = clean(next.textContent).replace(/\s*Report\s+a\s+problem\s*$/i, '').replace(/\s*Report\s*$/i, '');
            }
            out.push({ date, event, price, change, ppsf, source });
        }
        return out;
    }).catch(() => []);

    return { rows, found: true };
}

// =========================================================
// EXTRACT ONE URL
// =========================================================
async function scrapeOneUrl(browser, url) {
    const tag = String(url).slice(-22);
    const ctx = await newContext(browser);
    let page;
    try {
        page = await ctx.newPage();
        await page.setViewport({ width: VIEWPORT_W, height: VIEWPORT_H, deviceScaleFactor: 1, hasTouch: false, isMobile: false });

        if (BLOCK_RESOURCES) {
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                const type = req.resourceType();
                if (['image', 'font', 'media'].includes(type) || AD_HOSTS.test(req.url())) req.abort().catch(() => {});
                else req.continue().catch(() => {});
            });
        }

        // Warm-up
        await warmUpSession(page, tag);

        // Navigate
        await delay(jitter(NAV_DELAY_MIN, NAV_DELAY_MAX));
        await page.goto(String(url), { waitUntil: 'domcontentloaded', timeout: 30000 }); // ↓ 45s→30s
        await page.waitForSelector('[data-testid="price"], [data-testid="description"], [data-testid="gallery-status-pill"], h1', { timeout: HYDRATE_TIMEOUT }).catch(() => {});
        if (typeof page.waitForNetworkIdle === 'function') {
            await page.waitForNetworkIdle({ idleTime: 1000, timeout: 8000 }).catch(() => {}); // ↓ 15s→8s
        }
        await delay(HYDRATE_SETTLE);

        // Captcha
        const captchaType = await detectCaptcha(page);
        if (captchaType) {
            const solved = await solvePressAndHold(page, tag);
            if (!solved) {
                if (DEBUG_DUMP) await dumpDebug(page, 'captcha');
                return { blocked: true, blockedTitle: 'captcha-unsolved' };
            }
            await page.waitForSelector('[data-testid="price"], h1', { timeout: 6000 }).catch(() => {});
            await delay(500);
        }

        const title = await page.title();
        const hasContent = await page.evaluate(() => !!document.querySelector('h1, [data-testid="price"]'));
        const blockedTitle = /pardon our interruption|robot check|access denied|denied|captcha|press & hold/i.test(title);
        if (blockedTitle || !hasContent) {
            if (DEBUG_DUMP) await dumpDebug(page, 'blocked');
            return { blocked: true, blockedTitle };
        }

        const { rows: domRows, found: tableFound } = await getPriceHistory(page, tag);

        const data = await page.evaluate((INCLUDE_PAGE_TEXT) => {
            const out = {
                price: "", street: "", city: "", state: "", zipcode: "", fullAddress: "",
                agentDetails: "", soldPrice: "", canonicalUrl: "", description: "",
                pricePerSqft: "", beds: "", baths: "", sqft: "", lotSize: "",
                listedForSale: "", soldOn: "", mls: "", propertyType: "", yearBuilt: "",
                hoa: "", priceHistoryText: "", pageText: "", factsFeaturesText: ""
            };
            const clean = (s) => (s || '').replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
            const num = (s) => {
                const str = String(s || '').replace(/,/g, '').trim();
                if (/^[-—–]+$/.test(str)) return '';
                const m = str.match(/-?\d+(\.\d+)?/);
                return m ? Number(m[0]) : '';
            };
            const $ = (sel, root = document) => root.querySelector(sel);
            const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
            const txt = (sel) => { const e = $(sel); return e ? e.textContent : ''; };

            const og = $('meta[property="og:url"]');
            const canon = $('link[rel="canonical"]');
            out.canonicalUrl = (og && og.content) || (canon && canon.href) || location.href;
            out.price = num(clean(txt('[data-testid="price"]')));

            const pill = clean(txt('[data-testid="gallery-status-pill"]'));
            const soldMatch = pill.match(/Sold\s+for\s+\$([\d,]+)/i);
            if (soldMatch) out.soldPrice = Number(soldMatch[1].replace(/,/g, ''));
            else if (/sold/i.test(pill) && out.price) out.soldPrice = out.price;

            const h1 = clean(txt('h1'));
            if (h1) {
                const parts = h1.split(',').map(clean);
                if (parts.length >= 3) {
                    out.street = parts[0];
                    out.city = parts[1];
                    const stZip = parts[2].match(/^([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);
                    if (stZip) { out.state = stZip[1]; out.zipcode = stZip[2]; }
                }
            }

            const factMap = {};
            $$('[data-testid="bed-bath-sqft-fact-container"]').forEach(c => {
                const sp = c.querySelectorAll('span');
                if (sp.length >= 2) factMap[clean(sp[1].textContent).toLowerCase()] = clean(sp[0].textContent);
            });
            if (factMap.beds)  out.beds  = num(factMap.beds)  || factMap.beds;
            if (factMap.baths) out.baths = num(factMap.baths) || factMap.baths;
            if (factMap.sqft)  out.sqft  = num(factMap.sqft)  || factMap.sqft;

            const glance = $('[aria-label="At a glance facts"]');
            if (glance) {
                for (const item of glance.querySelectorAll('[role="listitem"]')) {
                    const t = clean(item.textContent);
                    if (!t) continue;
                    const lotM = t.match(/^([\d.,]+)\s*(Acres?|sqft|sq\s*ft)\s+Lot$/i);
                    if (lotM && !out.lotSize) out.lotSize = `${lotM[1]} ${/acre/i.test(lotM[2]) ? 'Acres' : 'sqft'}`;
                    const yearM = t.match(/^Built\s+in\s+(\d{4})$/i);
                    if (yearM && !out.yearBuilt) out.yearBuilt = yearM[1];
                    if (!out.propertyType && /^(Single Family|Multi Family|Condo|Townhouse|Manufactured|Mobile|Apartment|Land|Vacant)/i.test(t)) out.propertyType = t;
                    const ppsfM = t.match(/\$([\d,]+)\s*\/\s*sqft/i);
                    if (ppsfM && !out.pricePerSqft) out.pricePerSqft = Number(ppsfM[1].replace(/,/g, ''));
                }
            }

            const fm = {};
            $$('[data-testid="fact-category"] li').forEach(li => {
                const t = clean(li.textContent);
                const i = t.indexOf(': ');
                if (i > 0) { const k = t.slice(0, i); if (!(k in fm)) fm[k] = t.slice(i + 2); }
            });
            const ffLines = [];
            $$('[data-testid="category-group"]').forEach(group => {
                const ghEl = group.querySelector('h3');
                const gh = clean(ghEl ? ghEl.textContent : '');
                if (gh) ffLines.push(`## ${gh}`);
                group.querySelectorAll('[data-testid="fact-category"]').forEach(cat => {
                    const ch = cat.querySelector('h6');
                    const items = Array.from(cat.querySelectorAll('li')).map(li => clean(li.textContent)).filter(Boolean);
                    if (!items.length) return;
                    ffLines.push(ch ? `${clean(ch.textContent)}: ${items.join('; ')}` : items.join('; '));
                });
            });
            out.factsFeaturesText = ffLines.join('\n');

            if (!out.propertyType && (fm['Home type'] || fm['Property subtype'])) out.propertyType = fm['Home type'] || fm['Property subtype'];
            if (!out.yearBuilt && fm['Year built']) out.yearBuilt = fm['Year built'];
            if (!out.lotSize && fm['Size']) out.lotSize = fm['Size'];
            if (!out.pricePerSqft && fm['Price per square foot']) out.pricePerSqft = num(fm['Price per square foot']);

            const hasHoa = fm['Has HOA'];
            const hoaFee = fm['HOA fee'] || fm['HOA fee frequency'];
            if (hoaFee) out.hoa = hoaFee;
            else if (hasHoa) out.hoa = /^no/i.test(hasHoa) ? 'No' : `Yes (${hasHoa})`;
            else out.hoa = '';

            const descEl = $('[data-testid="description"] article') || $('[data-testid="description"]');
            if (descEl) out.description = clean(descEl.textContent) || 'N/A';

            const la = $('[data-testid="attribution-LISTING_AGENT"]');
            if (la) {
                const parts = Array.from(la.querySelectorAll('span')).map(x => clean(x.textContent).replace(/,$/, '')).filter(Boolean);
                const broker = clean(txt('[data-testid="attribution-BROKER"]'));
                out.agentDetails = [parts[0], broker, parts[1]].filter(Boolean).join(' | ');
            }

            const mlsInfo = clean(txt('[role="contentinfo"][aria-label="MLS information"]'));
            if (mlsInfo) {
                const src = mlsInfo.match(/Source:\s*(.+?)\s*,\s*MLS#?:/i);
                const id = mlsInfo.match(/MLS#?:\s*([A-Za-z0-9-]+?)(?=Originating|\s|$)/i);
                if (id) out.mls = `${id[1]} - ${src ? clean(src[1]) : ''}`.replace(/ - $/, '');
            }

            if (INCLUDE_PAGE_TEXT) {
                const SKIP = new Set([
                    'SCRIPT','STYLE','NOSCRIPT','SVG','IFRAME','TEMPLATE','BUTTON',
                    'SELECT','INPUT','TEXTAREA','HEAD','LINK','META','PATH','IMG',
                    'VIDEO','AUDIO','CANVAS','OBJECT','EMBED'
                ]);
                const SKIP_TESTID = /topnav|desktop-action-bar|action-bar|footer|mobile-footer|neighborhood-ad|MstServicesAvailability|zhl-upsell|third-party|ad-frame|lightbox|px-captcha/i;
                const lines = [];
                const seen = new Set();
                const push = (s) => {
                    const t = clean(s);
                    if (!t || t.length < 2) return;
                    if (lines.length && lines[lines.length - 1] === t) return;
                    const k = t.toLowerCase();
                    if (t.length < 25 && seen.has(k)) return;
                    if (t.length < 25) seen.add(k);
                    lines.push(t);
                };
                const isHeading = (n) => /^H[1-6]$/.test(n.tagName);
                const isBlock = (n) => /^(DIV|SECTION|ARTICLE|MAIN|ASIDE|HEADER|FOOTER|UL|OL|LI|P|TABLE|TBODY|THEAD|TR|TD|TH|DL|DT|DD|FIGURE|FIGCAPTION|BLOCKQUOTE|PRE)$/.test(n.tagName);
                const walk = (n) => {
                    if (n.nodeType === 3) { push(n.nodeValue); return; }
                    if (n.nodeType !== 1) return;
                    const tag = n.tagName.toUpperCase();
                    if (SKIP.has(tag)) return;
                    if (n.getAttribute('aria-hidden') === 'true') return;
                    if (n.hidden) return;
                    const tid = n.getAttribute('data-testid') || '';
                    if (tid && SKIP_TESTID.test(tid)) return;
                    const aria = n.getAttribute('aria-label');
                    const ariaText = aria && aria.length > 2 && aria.length < 120 ? clean(aria) : '';
                    if (isHeading(n)) {
                        const t = clean(n.textContent);
                        if (t) { lines.push(''); lines.push(`## ${t}`); }
                        return;
                    }
                    if (tag === 'TABLE') {
                        for (const tr of n.querySelectorAll('tr')) {
                            const cells = Array.from(tr.querySelectorAll('th,td'))
                                .map(c => clean(c.textContent))
                                .filter(Boolean);
                            if (cells.length) push(cells.join(' | '));
                        }
                        return;
                    }
                    if (ariaText && !clean(n.textContent).startsWith(ariaText)) push(ariaText);
                    for (const c of n.childNodes) walk(c);
                    if (isBlock(n) && lines.length && lines[lines.length - 1] !== '') lines.push('');
                };
                const main = $('[data-test="hdp-not-for-sale-page-content"]')
                    || $('#layout-wrapper .layout-container')
                    || $('#layout-wrapper')
                    || document.body;
                walk(main);
                const compact = [];
                for (const l of lines) {
                    if (l === '' && compact[compact.length - 1] === '') continue;
                    compact.push(l);
                }
                out.pageText = [`TITLE: ${clean(document.title)}`, `URL: ${location.href}`, '', ...compact].join('\n').trim();
            }

            out.fullAddress = [out.street, out.city, out.state, out.zipcode].filter(Boolean).join(', ');

            // JSON fallback #1
            try {
                const nd = $('script#__NEXT_DATA__');
                const nextData = nd ? JSON.parse(nd.textContent || 'null') : null;
                const raw = nextData && nextData.props && nextData.props.pageProps && nextData.props.pageProps.componentProps && nextData.props.pageProps.componentProps.gdpClientCache;
                if (raw) {
                    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
                    for (const key of Object.keys(parsed)) {
                        const prop = parsed[key] && parsed[key].property;
                        if (!prop) continue;
                        if (!out.price && prop.price) out.price = prop.price;
                        if (!out.soldPrice && prop.lastSoldPrice) out.soldPrice = prop.lastSoldPrice;
                        const ai = prop.attributionInfo;
                        if (ai) {
                            if (!out.mls && (ai.mlsId || ai.mlsName)) out.mls = [ai.mlsId, ai.mlsName].filter(Boolean).join(' - ');
                            if (!out.agentDetails) out.agentDetails = [ai.agentName, ai.brokerName, ai.agentPhoneNumber].filter(Boolean).join(' | ');
                        }
                        if (Array.isArray(prop.priceHistory) && prop.priceHistory.length) {
                            const fmtDate = (d) => {
                                if (typeof d === 'number') { const x = new Date(d); return `${x.getUTCMonth()+1}/${x.getUTCDate()}/${x.getUTCFullYear()}`; }
                                const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
                                return m ? `${+m[2]}/${+m[3]}/${m[1]}` : String(d || '');
                            };
                            out.priceHistoryText = prop.priceHistory.map(h => {
                                const priceTxt = typeof h.price === 'number' ? `$${h.price.toLocaleString('en-US')}` : (h.price || '');
                                const change = (typeof h.priceChangeRate === 'number' && h.priceChangeRate !== 0) ? ` (${(h.priceChangeRate*100).toFixed(1)}%)` : '';
                                const ppsf = h.pricePerSquareFoot ? `$${Math.round(h.pricePerSquareFoot)}/sqft` : '';
                                return [fmtDate(h.date), h.event, priceTxt + change, ppsf, h.source ? `Source: ${h.source}` : ''].filter(Boolean).join(' | ');
                            }).join('\n');
                        }
                        break;
                    }
                }
            } catch (e) {}

            // JSON fallback #2
            try {
                if (!out.priceHistoryText) {
                    const scripts = document.querySelectorAll('script[type="application/json"], script[type="application/ld+json"]');
                    for (const sc of scripts) {
                        let j;
                        try { j = JSON.parse(sc.textContent || 'null'); } catch (e) { continue; }
                        const stack = [j];
                        let found = false;
                        while (stack.length && !found) {
                            const cur = stack.pop();
                            if (!cur || typeof cur !== 'object') continue;
                            if (Array.isArray(cur.priceHistory) && cur.priceHistory.length) {
                                const fmtDate = (d) => {
                                    if (typeof d === 'number') { const x = new Date(d); return `${x.getUTCMonth()+1}/${x.getUTCDate()}/${x.getUTCFullYear()}`; }
                                    const m = String(d || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
                                    return m ? `${+m[2]}/${+m[3]}/${m[1]}` : String(d || '');
                                };
                                out.priceHistoryText = cur.priceHistory.map(h => {
                                    const priceTxt = typeof h.price === 'number' ? `$${h.price.toLocaleString('en-US')}` : (h.price || '');
                                    const change = (typeof h.priceChangeRate === 'number' && h.priceChangeRate !== 0) ? ` (${(h.priceChangeRate*100).toFixed(1)}%)` : '';
                                    const ppsf = h.pricePerSquareFoot ? `$${Math.round(h.pricePerSquareFoot)}/sqft` : '';
                                    return [fmtDate(h.date), h.event, priceTxt + change, ppsf, h.source ? `Source: ${h.source}` : ''].filter(Boolean).join(' | ');
                                }).join('\n');
                                found = true;
                                break;
                            }
                            for (const k of Object.keys(cur)) {
                                if (cur[k] && typeof cur[k] === 'object') stack.push(cur[k]);
                            }
                        }
                        if (found) break;
                    }
                }
            } catch (e) {}

            return out;
        }, INCLUDE_PAGE_TEXT);

        if (!data.canonicalUrl) data.canonicalUrl = url;

        if (domRows.length) {
            data.priceHistoryText = domRows.map(r => {
                const priceTxt = (r.price || '') + (r.change ? ` (${r.change})` : '');
                return [r.date, r.event, priceTxt.trim(), r.ppsf, r.source].filter(Boolean).join(' | ');
            }).join('\n');
            for (const r of domRows) {
                const ev = String(r.event || '').toLowerCase();
                if (ev.includes('listed for sale') && !data.listedForSale) data.listedForSale = `${r.date} (${r.price})`;
                if (ev.includes('sold') && !data.soldOn) data.soldOn = r.date;
            }
            if (!data.mls) {
                for (const r of domRows) {
                    const m = String(r.source || '').match(/Source:\s*(.+?)\s*#\s*([A-Za-z0-9-]+)/i);
                    if (m) { data.mls = `${m[2]} - ${m[1].trim()}`; break; }
                }
            }
            console.log(`   📊 [${tag}] History: ${domRows.length} row(s)`);
        } else {
            const diag = await page.evaluate(() => {
                const norm = (s) => (s || '').replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
                return {
                    heads: Array.from(document.querySelectorAll('h1,h2,h3,h4')).map(x => norm(x.textContent)).filter(Boolean).slice(0, 40),
                    dateInfoCount: document.querySelectorAll('[data-testid="date-info"]').length,
                    tableCount: document.querySelectorAll('table').length,
                    hasNextData: !!document.querySelector('script#__NEXT_DATA__'),
                };
            }).catch(() => ({}));
            console.log(`   ⚠️ [${tag}] History: EMPTY (tableFound=${tableFound})${data.priceHistoryText ? ' — JSON fallback used' : ''}`);
            console.log(`   🔎 [${tag}] diag: date-info=${diag.dateInfoCount} tables=${diag.tableCount} nextData=${diag.hasNextData}`);
            if (DEBUG_DUMP) await dumpDebug(page, 'nohistory');
        }

        if (!data.description || data.description === 'N/A') {
            try {
                const ldDesc = await page.evaluate(() => {
                    for (const sc of document.querySelectorAll('script[type="application/ld+json"]')) {
                        try {
                            const j = JSON.parse(sc.textContent);
                            if (j && j.description && String(j.description).length > 40) return String(j.description).replace(/\r/g, '').trim();
                        } catch (e) {}
                    }
                    return "";
                });
                data.description = ldDesc || 'N/A';
            } catch (e) { data.description = data.description || 'N/A'; }
        }

        return { blocked: false, data, tableFound, domRowsFound: domRows.length };
    } finally {
        if (page) await page.close().catch(() => {});
        await ctx.close().catch(() => {});
    }
}

async function dumpDebug(page, label) {
    try {
        await page.waitForFunction(() => document.body && document.body.children.length > 0, { timeout: 3000 }).catch(() => {});
        const stamp = `${label}-${Date.now()}`;
        const dir = path.join(process.cwd(), 'debug');
        fs.mkdirSync(dir, { recursive: true });
        await page.screenshot({ path: path.join(dir, `${stamp}.png`), fullPage: true }).catch(() => {});
        fs.writeFileSync(path.join(dir, `${stamp}.html`), await page.content());
        const diag = await page.evaluate(() => ({
            bodyChildren: document.body ? document.body.children.length : 0,
            htmlOverflow: document.documentElement.style.overflow,
            scrollLocked: document.documentElement.hasAttribute('data-hdp-scroll-locked'),
            hasConsent: !!document.querySelector('[class*="consent"], [id*="consent"], [class*="cookie"]'),
            hasCaptcha: !!document.querySelector('.px-captcha-container, #px-captcha'),
            h1Count: document.querySelectorAll('h1').length,
            h2Count: document.querySelectorAll('h2').length,
            tableCount: document.querySelectorAll('table').length,
            dateInfoCount: document.querySelectorAll('[data-testid="date-info"]').length,
        })).catch(() => ({}));
        fs.writeFileSync(path.join(dir, `${stamp}.diag.json`), JSON.stringify(diag, null, 2));
        console.log(`   🧾 Debug saved: debug/${stamp}.{png,html,diag.json}`, diag);
    } catch (e) {}
}

// =========================================================
// MAIN
// =========================================================
async function runScraper() {
    const startTime = Date.now();
    console.log(`🚀 Zillow Scraper V28-Fast | concurrency ${CONCURRENCY} | max ${MAX_URLS_PER_RUN} | recycle ${RECYCLE_BROWSER_EVERY}`);

    const setOutput = (hasMore, blocked) => {
        if (process.env.GITHUB_OUTPUT) {
            fs.appendFileSync(process.env.GITHUB_OUTPUT, `has_more=${hasMore}\nblocked=${blocked}\n`);
        }
    };

    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
    const auth = new JWT({ email: creds.client_email, key: creds.private_key, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    const doc = new GoogleSpreadsheet(process.env.SPREADSHEET_ID, auth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];

    if (sheet.columnCount < REQUIRED_COLS) await sheet.resize({ rowCount: sheet.rowCount, columnCount: REQUIRED_COLS });
    await sheet.loadCells();
    console.log(`📊 Sheet: ${sheet.rowCount} rows × ${sheet.columnCount} cols`);

    try {
        let hd = 0;
        HEADERS.forEach((title, i) => {
            const col = HEADER_START_COL + i;
            if (col >= sheet.columnCount) return;
            const cell = sheet.getCell(0, col);
            if (OVERWRITE_HEADERS || !cell.value) { cell.value = title; try { cell.textFormat = { bold: true }; } catch (e) {} hd++; }
        });
        if (hd) await saveWithRetry(sheet);
    } catch (e) { console.warn(`⚠️ Headings: ${e.message}`); }

    const queue = [];
    const setCell = (r, c, v, limit) => { if (c < sheet.columnCount) sheet.getCell(r, c).value = safeCell(v, limit); };
    const applyEntry = ({ row, status, d }) => {
        setCell(row, 17, status);
        if (!d) return;
        setCell(row, 9,  d.price);
        setCell(row, 10, d.street);
        setCell(row, 11, d.city);
        setCell(row, 12, d.state);
        setCell(row, 13, d.zipcode);
        setCell(row, 14, d.canonicalUrl);
        setCell(row, 15, d.agentDetails);
        setCell(row, 16, d.soldPrice);
        setCell(row, 18, d.description);
        setCell(row, 19, d.fullAddress);
        setCell(row, 20, d.pricePerSqft);
        setCell(row, 21, d.beds);
        setCell(row, 22, d.baths);
        setCell(row, 23, d.sqft);
        setCell(row, 24, d.lotSize);
        setCell(row, 25, d.listedForSale);
        setCell(row, 26, d.soldOn);
        setCell(row, 27, d.mls);
        setCell(row, 28, d.propertyType);
        setCell(row, 29, d.yearBuilt);
        setCell(row, 30, d.hoa);
        setCell(row, 31, d.priceHistoryText);
        setCell(row, 32, d.factsFeaturesText);
        setCell(row, 33, d.pageText, MAX_PAGETEXT_LEN);
    };
    let flushChain = Promise.resolve();
    const doFlush = async () => {
        if (!queue.length) return;
        const batch = queue.splice(0, queue.length);
        batch.forEach(applyEntry);
        try {
            await saveWithRetry(sheet);
            console.log(`💾 Saved ${batch.length} row(s)`);
        } catch (e) {
            console.warn(`⚠️ Save failed (${e.message})`);
        }
    };
    const flush = () => (flushChain = flushChain.then(doFlush));

    let claimed = 0, success = 0, blockStreak = 0, errorStreak = 0;
    let totalBlocks = 0, totalErrors = 0;
    let totalWithHistory = 0, totalWithTableFound = 0;
    let cursor = -1;
    let phase = 'fresh';
    let stop = false, blockedExit = false;
    const inflight = new Map();

    const claimRow = () => {
        let r = findNextRow(sheet, cursor, phase);
        if (r === -1 && phase === 'fresh' && RETRY_BLOCKED) {
            phase = 'skipped';
            cursor = -1;
            console.log('🔁 Retrying previously skipped rows');
            r = findNextRow(sheet, cursor, phase);
        }
        if (r !== -1) cursor = r;
        return r;
    };

    async function worker(id) {
        let browser = null, used = 0;
        try {
            while (!stop) {
                if (Date.now() - startTime >= MAX_RUNTIME_MS) break;
                if (claimed >= MAX_URLS_PER_RUN) break;
                if (errorStreak >= MAX_CONSECUTIVE_ERRORS) { stop = true; break; }

                const rowIndex = claimRow();
                if (rowIndex === -1) break;
                claimed++;
                const url = String(safeValue(sheet, rowIndex, 0));
                const actualRow = rowIndex + 1;
                console.log(`🕵️ [W${id}] Row ${actualRow} (${claimed}/${MAX_URLS_PER_RUN}) [${phase}]: ${url}`);

                let recycle = false;
                try {
                    if (!browser || used >= RECYCLE_BROWSER_EVERY) {
                        await closeBrowser(browser);
                        browser = await launchBrowser();
                        used = 0;
                    }
                    used++;

                    const key = urlKey(url);
                    if (!inflight.has(key)) inflight.set(key, scrapeOneUrl(browser, url));
                    const result = await inflight.get(key);

                    if (result.blocked) {
                        console.log(`❌ [W${id}] BLOCKED on Row ${actualRow}${result.blockedTitle ? ` (${result.blockedTitle})` : ''}`);
                        queue.push({ row: rowIndex, status: result.blockedTitle === 'captcha-unsolved' ? "🧩 CAPTCHA blocked (skipped)" : "❌ BLOCKED (skipped)" });
                        blockStreak++; errorStreak = 0; totalBlocks++;
                        recycle = true;
                        if (blockStreak >= MAX_CONSECUTIVE_BLOCK_STREAKS) { stop = true; blockedExit = true; }
                    } else {
                        const d = result.data;
                        if (result.tableFound) totalWithTableFound++;
                        const hasHistory = !!(d.priceHistoryText && d.priceHistoryText.trim());
                        if (hasHistory) totalWithHistory++;

                        if (!(d.price || d.fullAddress || d.description)) {
                            console.log(`⚠️ [W${id}] Empty parse on Row ${actualRow}`);
                            queue.push({ row: rowIndex, status: "⚠️ Empty parse (skipped)" });
                            errorStreak++; totalErrors++;
                        } else {
                            const status = hasHistory ? "✅ Done" : "⚠️ Done (no history)";
                            queue.push({ row: rowIndex, status, d });
                            success++; blockStreak = 0; errorStreak = 0;
                            console.log(`✔️ [W${id}] ${d.fullAddress || '?'} | 💰 ${d.price || '?'} | 📊 Hist: ${hasHistory ? d.priceHistoryText.split('\n').length : 'NO'} | 📄 Text: ${d.pageText ? d.pageText.length : 0}c | 🏷️ ${d.mls || '—'}`);
                        }
                    }
                } catch (e) {
                    console.error(`🛑 [W${id}] Error on Row ${actualRow}: ${e.message}`);
                    queue.push({ row: rowIndex, status: "🛑 Error: " + String(e.message).slice(0, 100) });
                    errorStreak++; totalErrors++;
                    recycle = true;
                } finally {
                    inflight.delete(urlKey(url));
                }

                if (recycle) { await closeBrowser(browser); browser = null; }
                if (queue.length >= FLUSH_EVERY) flush();
            }
        } finally {
            await closeBrowser(browser);
        }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i + 1)));
    await flush();

    console.log(`\n📊 ─── RUN TOTALS ───`);
    console.log(`✅ Success: ${success} | 🚫 Blocked: ${totalBlocks} | 🛑 Errors: ${totalErrors}`);
    console.log(`📊 Rows with history: ${totalWithHistory} | 📊 History-section rows: ${totalWithTableFound}`);
    console.log(`⏱️ Runtime: ${Math.round((Date.now() - startTime) / 1000)}s`);

    if (blockedExit) {
        console.log(`🛑 ${MAX_CONSECUTIVE_BLOCK_STREAKS} consecutive blocks — stopping.`);
        setOutput(true, true);
        return;
    }

    const remaining = findNextRow(sheet, -1, 'fresh');
    const hasMore = remaining !== -1;
    setOutput(hasMore, false);
    console.log(hasMore ? `🔄 More rows remain — next run resumes at row ${remaining + 1}.` : "🎉 All fresh rows processed!");
}

runScraper().then(() => process.exit(0)).catch(err => { console.error("💥 Fatal:", err); process.exit(1); });
