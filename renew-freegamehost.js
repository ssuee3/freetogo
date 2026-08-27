/**
 * FreeGameHost 自动续期（puppeteer-real-browser 版）
 *
 * 过 Cloudflare Turnstile 的核心：connect({ turnstile: true }) 每约 4 秒扫描并点击
 * Turnstile checkbox。续期按钮点下去后，站点用 window.turnstile.render(..., { callback })
 * 拿到 token 会自动 POST /api/client/freeservers/{uuid}/renew，脚本只等成功/失败 UI。
 *
 * 流程：启动过盾浏览器 → 打开登录页 → 关 cookie 弹窗 → 填凭证 → 点 LOGIN
 *   → 等离开 /auth/login → 打开服务器页 → 读剩余时间/冷却 → 点 RENEW +8 HOURS
 *   → 等 Turnstile 自动求解并提交 → 检查成功提示或剩余时间增加 → TG 通知 + 截图。
 *
 * 环境变量：
 *   EMAIL            登录邮箱
 *   PASSWORD         登录密码
 *   SERVER_ID        服务器短 ID，默认 09758a67（appa）
 *   IS_PROXY         "true" 时挂代理
 *   PROXY_SERVER     代理地址，默认 socks5://127.0.0.1:1080
 *   SESSION_COOKIES  可选，已登录会话 cookie（Cookie header 或 Chrome 导出的 JSON），存在时优先复用会话
 *   TG_BOT_TOKEN     Telegram bot token
 *   TG_CHAT_ID       Telegram chat id
 */

const fs = require('fs');
const path = require('path');
const { connect } = require('puppeteer-real-browser');

const EMAIL = process.env.EMAIL || '';
const PASSWORD = process.env.PASSWORD || '';
const SERVER_ID = (process.env.SERVER_ID || '09758a67').trim();
const IS_PROXY = (process.env.IS_PROXY || 'false').toLowerCase() === 'true';
const PROXY_SERVER = (process.env.PROXY_SERVER || '').trim() || 'socks5://127.0.0.1:1080';
const SESSION_COOKIES = (process.env.SESSION_COOKIES || '').trim();
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';

const BASE_URL = 'https://panel.freegamehost.xyz';
const LOGIN_URL = `${BASE_URL}/auth/login`;
const ARTIFACTS_DIR = path.join(__dirname, 'artifacts');

function log(msg) {
    const t = new Date().toTimeString().slice(0, 8);
    console.log(`[${t}] [INFO] ${msg}`);
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

function humanWait(minS = 2, maxS = 4) {
    return sleep((minS + Math.random() * (maxS - minS)) * 1000);
}

function nowBeijing() {
    const d = new Date();
    const beijing = new Date(d.getTime() + 8 * 3600 * 1000);
    const pad = (n) => String(n).padStart(2, '0');
    return `${beijing.getUTCFullYear()}-${pad(beijing.getUTCMonth() + 1)}-${pad(beijing.getUTCDate())} ${pad(beijing.getUTCHours())}:${pad(beijing.getUTCMinutes())}:${pad(beijing.getUTCSeconds())}`;
}

function maskEmail(email) {
    if (!email) return '（未配置）';
    if (email.includes('@')) {
        const [name, domain] = email.split('@', 2);
        if (name.length > 4) return `${name.slice(0, 2)}****${name.slice(-2)}@${domain}`;
        return `${name}@${domain}`;
    }
    return email.length > 2 ? email.slice(0, 2) + '****' : email + '****';
}

function maskIp(ip) {
    const p = String(ip || '').split('.');
    if (p.length === 4) return `${p[0]}.${p[1]}.***.${p[3]}`;
    return '未知';
}

function timeToSeconds(t) {
    if (!t) return 0;
    const m = String(t).trim().match(/(\d{1,2}):(\d{2}):(\d{2})/);
    if (!m) return 0;
    return +m[1] * 3600 + +m[2] * 60 + +m[3];
}

function formatHms(sec) {
    const s = Math.max(0, Math.floor(sec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(h)}:${pad(m)}:${pad(r)}`;
}

async function screenshot(page, name) {
    try {
        await page.screenshot({ path: path.join(ARTIFACTS_DIR, name), fullPage: true });
        log(`📸 截图: artifacts/${name}`);
    } catch (e) {
        log(`⚠️ 截图失败 ${name}: ${e.message}`);
    }
}

async function sendTelegram(message) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
        log('⚠️ 未配置 TG_BOT_TOKEN / TG_CHAT_ID，跳过推送。');
        return;
    }
    try {
        const res = await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: TG_CHAT_ID, text: message }),
        });
        if (res.ok) log('✅ TG 推送已发送');
        else log(`❌ TG 推送失败: HTTP ${res.status}`);
    } catch (e) {
        log(`❌ TG 推送异常: ${e.message}`);
    }
}

function formatNotification(fields = {}, clock = nowBeijing) {
    const {
        status = '',
        account = EMAIL,
        remain = '',
        cooldown = '',
        ip = '',
        note = '',
        error = '',
    } = fields;
    const lines = ['🎮 FreeGameHost 续期通知', ''];
    if (status) lines.push(status);
    lines.push(`👤 账户: ${maskEmail(account)}`);
    lines.push(`🖥️ 服务器: ${SERVER_ID}`);
    if (remain) lines.push(`🕒 剩余时间: ${remain}`);
    if (cooldown) lines.push(`❄️ 冷却剩余: ${cooldown}`);
    if (note && (!remain || !note.includes(remain)) && !/renewed successfully/i.test(note)) {
        lines.push(`📝 ${note}`);
    }
    if (ip) lines.push(`🌐 出口IP: ${maskIp(ip)}`);
    if (error) {
        const err = String(error).replace(/\s+/g, ' ').trim();
        lines.push(`⚠️ ${err.length > 180 ? `${err.slice(0, 180)}…` : err}`);
    }
    lines.push(`⏱️ ${clock()}`);
    return lines.join('\n');
}

function normalizeCookie(cookie) {
    const c = { ...cookie };
    if (c.expirationDate && !c.expires) c.expires = Math.floor(c.expirationDate);
    delete c.expirationDate;
    if (!c.domain && !c.url) c.url = BASE_URL;
    if (!c.path) c.path = '/';
    return c;
}

function parseSessionCookies(raw) {
    if (!raw) return [];
    const s = String(raw).trim();
    if (!s) return [];

    if (s.startsWith('[')) {
        const parsed = JSON.parse(s);
        if (!Array.isArray(parsed)) throw new Error('SESSION_COOKIES JSON 必须是数组');
        return parsed
            .filter((c) => c && c.name && typeof c.value !== 'undefined')
            .map(normalizeCookie);
    }

    return s.split(';')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => {
            const idx = part.indexOf('=');
            if (idx <= 0) return null;
            return normalizeCookie({ name: part.slice(0, idx).trim(), value: part.slice(idx + 1).trim() });
        })
        .filter(Boolean);
}

async function restoreSession(page) {
    if (!SESSION_COOKIES) return false;
    let cookies;
    try {
        cookies = parseSessionCookies(SESSION_COOKIES);
    } catch (e) {
        log(`⚠️ SESSION_COOKIES 解析失败: ${e.message}`);
        return false;
    }
    if (!cookies.length) return false;

    log(`🍪 尝试注入已登录 cookie（${cookies.length} 个）`);
    try {
        await page.setCookie(...cookies);
        await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await humanWait(2, 4);
        if (isLoggedInUrl(page.url()) && !page.url().includes('/auth/login')) {
            log(`✅ 已复用登录态，当前: ${page.url()}`);
            return true;
        }
        log(`⚠️ 注入 cookie 后仍未登录，当前: ${page.url()}，回退账号密码登录`);
        return false;
    } catch (e) {
        log(`⚠️ 注入 cookie 失败: ${e.message}`);
        return false;
    }
}

async function launchRealBrowser() {
    const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1280,1600',
        '--disable-blink-features=AutomationControlled',
    ];
    if (IS_PROXY) args.push(`--proxy-server=${PROXY_SERVER}`);

    const chromePath = fs.existsSync('/usr/bin/google-chrome')
        ? '/usr/bin/google-chrome'
        : fs.existsSync('/usr/bin/google-chrome-stable')
            ? '/usr/bin/google-chrome-stable'
            : undefined;

    log('🚀 启动浏览器（puppeteer-real-browser / turnstile）');
    let browser;
    let page;
    try {
        ({ browser, page } = await connect({
            headless: false,
            turnstile: false,
            disableXvfb: true,
            customConfig: chromePath ? { chromePath } : {},
            connectOption: {
                defaultViewport: null,
            },
            args,
        }));
    } catch (e) {
        throw new Error(`浏览器启动失败: ${e.message}`);
    }
    await page.setViewport({ width: 1280, height: 1600 });
    return { browser, page };
}

async function getTurnstileToken(page) {
    try {
        return await page.evaluate(() => {
            try {
                if (window.turnstile && typeof window.turnstile.getResponse === 'function') {
                    const r = window.turnstile.getResponse();
                    if (r && r.length > 20) return r;
                }
            } catch (e) { /* ignore */ }
            const el = document.querySelector('[name="cf-turnstile-response"]');
            return el && el.value && el.value.length > 20 ? el.value : '';
        });
    } catch (e) {
        return '';
    }
}

// 站点续期用的是 compact（约 150x140）+ auto，不是 puppeteer-real-browser 默认点的 300x65 勾选框。
// 勾选框在左侧；compact 偏顶部，normal 垂直居中。
function turnstileClickPoint(box) {
    if (!box || box.width < 20 || box.height < 20) return null;
    const x = box.x + Math.min(28, Math.max(12, box.width * 0.18));
    const y = box.height >= 100 ? box.y + 30 : box.y + box.height / 2;
    return { x, y };
}

function isClickInViewport(pt, viewport) {
    if (!pt || !viewport) return false;
    return pt.x >= 0 && pt.y >= 0 && pt.x < viewport.width && pt.y < viewport.height;
}

const TURNSTILE_AUTO_WAIT_S = 8;

function turnstileAction({ hasToken, hasIframe, iframeAgeS, clicksOnThisWidget }) {
    if (hasToken || !hasIframe) return 'wait';
    if (clicksOnThisWidget === 0 && iframeAgeS < TURNSTILE_AUTO_WAIT_S) return 'wait-auto';
    if (clicksOnThisWidget === 0) return 'click';
    return 'wait';
}

async function findTurnstileIframeBoxes(page) {
    const boxes = [];
    for (const frame of page.frames()) {
        if (!/challenges\.cloudflare\.com/i.test(frame.url() || '')) continue;
        try {
            const el = await frame.frameElement();
            if (!el) continue;
            const box = await el.boundingBox();
            if (box && box.width >= 20 && box.height >= 20) {
                boxes.push({ x: box.x, y: box.y, width: box.width, height: box.height, via: 'frame' });
            }
        } catch (e) { /* cross-origin / detached */ }
    }
    try {
        const extra = await page.evaluate(() => {
            const out = [];
            const walk = (root) => {
                for (const el of root.querySelectorAll('iframe')) {
                    const src = el.src || '';
                    if (!/challenges\.cloudflare\.com|turnstile/i.test(src)) continue;
                    const r = el.getBoundingClientRect();
                    if (r.width >= 20 && r.height >= 20) {
                        out.push({ x: r.x, y: r.y, width: r.width, height: r.height, via: 'dom' });
                    }
                }
                for (const el of root.querySelectorAll('*')) {
                    if (el.shadowRoot) walk(el.shadowRoot);
                }
            };
            walk(document);
            return out;
        });
        for (const b of extra) boxes.push(b);
    } catch (e) { /* ignore */ }
    return boxes;
}

async function scrollTurnstileIntoView(page) {
    try {
        await page.evaluate(() => {
            const walk = (root) => {
                for (const el of root.querySelectorAll('iframe')) {
                    if (/challenges\.cloudflare\.com|turnstile/i.test(el.src || '')) {
                        el.scrollIntoView({ block: 'center', inline: 'center' });
                    }
                }
                for (const el of root.querySelectorAll('*')) {
                    if (el.shadowRoot) walk(el.shadowRoot);
                }
            };
            walk(document);
        });
    } catch (e) { /* ignore */ }
    for (const frame of page.frames()) {
        if (!/challenges\.cloudflare\.com/i.test(frame.url() || '')) continue;
        try {
            const el = await frame.frameElement();
            if (el) await el.evaluate((node) => node.scrollIntoView({ block: 'center', inline: 'center' }));
        } catch (e) { /* ignore */ }
    }
    await sleep(400);
}

async function clickTurnstileWidgets(page) {
    await scrollTurnstileIntoView(page);
    const viewport = page.viewport() || { width: 1280, height: 1600 };
    const boxes = await findTurnstileIframeBoxes(page);
    const seen = new Set();
    let clicked = 0;
    for (const box of boxes) {
        const key = `${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)}x${Math.round(box.height)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const pt = turnstileClickPoint(box);
        if (!pt) continue;
        if (!isClickInViewport(pt, viewport)) {
            log(`⚠️ Turnstile 点击点在视口外 ${Math.round(pt.x)},${Math.round(pt.y)} viewport=${viewport.width}x${viewport.height}，跳过`);
            continue;
        }
        try {
            await page.mouse.move(pt.x, pt.y, { steps: 8 });
            await sleep(120);
            await page.mouse.click(pt.x, pt.y);
            clicked += 1;
            if (clicked === 1) {
                log(`🖱️ 点击坐标 ${Math.round(pt.x)},${Math.round(pt.y)} box=${Math.round(box.x)},${Math.round(box.y)} ${Math.round(box.width)}x${Math.round(box.height)}`);
            }
        } catch (e) { /* ignore */ }
    }
    return { clicked, boxes: boxes.length, size: boxes[0] ? `${Math.round(boxes[0].width)}x${Math.round(boxes[0].height)}` : '' };
}

function cfFrameUrls(page) {
    return page.frames()
        .map((f) => f.url() || '')
        .filter((u) => /challenges\.cloudflare\.com/i.test(u));
}

function isVisibleBox(box) {
    return !!(box && box.width >= 8 && box.height >= 8);
}

async function clickBox(page, box) {
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y, { steps: 6 });
    await sleep(80);
    await page.mouse.click(x, y);
}

async function hasBlockingOverlay(page) {
    try {
        return await page.evaluate(() => {
            const sels = ['.fc-dialog', '.fc-dialog-container'];
            const visible = (el) => {
                const r = el.getBoundingClientRect();
                if (r.width < 120 || r.height < 120) return false;
                const st = window.getComputedStyle(el);
                return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
            };
            return sels.some((s) => Array.from(document.querySelectorAll(s)).some(visible));
        });
    } catch (e) {
        return false;
    }
}

async function forceHideCmp(page) {
    try {
        return await page.evaluate(() => {
            const sels = [
                '.fc-consent-root',
                '.fc-dialog-overlay',
                '.fc-dialog-container',
                '[class*="fc-consent"]',
            ];
            let count = 0;
            for (const s of sels) {
                document.querySelectorAll(s).forEach((el) => {
                    el.style.setProperty('display', 'none', 'important');
                    el.style.setProperty('pointer-events', 'none', 'important');
                    el.setAttribute('aria-hidden', 'true');
                    count += 1;
                });
            }
            return count;
        });
    } catch (e) {
        return 0;
    }
}

async function findConsentBox(page) {
    const selectors = [
        'button.fc-cta-consent',
        '.fc-button.fc-cta-consent',
        'button[aria-label="Consent"]',
        'button[aria-label="同意"]',
        'button[aria-label="Accept"]',
    ];
    const contexts = [page, ...page.frames().filter((f) => f !== page.mainFrame())];
    for (const ctx of contexts) {
        for (const sel of selectors) {
            try {
                const el = await ctx.$(sel);
                if (!el) continue;
                const box = await el.boundingBox();
                if (!isVisibleBox(box)) continue;
                const text = await el.evaluate((node) => (node.innerText || node.textContent || '').trim()).catch(() => sel);
                return { box, text: text || sel, via: sel };
            } catch (e) { /* cross-origin iframe */ }
        }
    }

    try {
        const found = await page.evaluate(() => {
            const labels = ['同意', 'consent', 'accept', 'i agree', 'accept all', 'agree', 'accept all cookies'];
            const visible = (el) => {
                const r = el.getBoundingClientRect();
                if (r.width < 8 || r.height < 8) return false;
                const st = window.getComputedStyle(el);
                if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
                return true;
            };
            const nodes = Array.from(document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]'));
            const hit = nodes.find((el) => {
                if (!visible(el)) return false;
                const t = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().toLowerCase().replace(/\s+/g, ' ');
                return labels.includes(t);
            });
            if (!hit) return null;
            const r = hit.getBoundingClientRect();
            return {
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height,
                text: (hit.innerText || hit.getAttribute('aria-label') || '').trim(),
            };
        });
        if (found && isVisibleBox(found)) {
            return { box: found, text: found.text, via: 'visible-text' };
        }
    } catch (e) { /* ignore */ }
    return null;
}

// 直接在主文档 / 各 frame 里对「同意」按钮做原生 click，绕过坐标点击被遮罩拦截的问题
async function clickConsentNative(page) {
    const contexts = [page.mainFrame(), ...page.frames().filter((f) => f !== page.mainFrame())];
    for (const ctx of contexts) {
        try {
            const hit = await ctx.evaluate(() => {
                const labels = ['同意', 'consent', 'accept', 'i agree', 'accept all', 'agree', 'accept all cookies'];
                let btn = document.querySelector('button.fc-cta-consent, .fc-button.fc-cta-consent, button[aria-label="Consent"], button[aria-label="同意"], button[aria-label="Accept"]');
                if (!btn) {
                    const nodes = Array.from(document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]'));
                    btn = nodes.find((el) => {
                        const t = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().toLowerCase().replace(/\s+/g, ' ');
                        return labels.includes(t);
                    });
                }
                if (!btn) return '';
                btn.click();
                return (btn.innerText || btn.getAttribute('aria-label') || 'Consent').trim();
            });
            if (hit) return hit;
        } catch (e) { /* cross-origin iframe，忽略 */ }
    }
    return '';
}

async function dismissOverlays(page) {
    // 优先原生 click（不受遮罩层级 / OOPIF 坐标影响），失败再退回鼠标坐标点击
    const nativeText = await clickConsentNative(page);
    if (nativeText) {
        log(`👍 已点 cookie 弹窗: ${nativeText} (native)`);
        await sleep(1000);
        return true;
    }
    const target = await findConsentBox(page);
    if (!target) return false;
    try {
        await clickBox(page, target.box);
        log(`👍 已点 cookie 弹窗: ${target.text || 'Consent'} (${target.via})`);
        await sleep(1000);
        return true;
    } catch (e) {
        log(`⚠️ 点击 cookie 弹窗失败: ${e.message}`);
        return false;
    }
}

async function waitDismissOverlays(page, timeoutS = 18) {
    const start = Date.now();
    let clicked = false;
    while (Date.now() - start < timeoutS * 1000) {
        if (await dismissOverlays(page)) clicked = true;
        const blocking = await hasBlockingOverlay(page);
        if (!blocking && clicked) return true;
        if (!blocking && Date.now() - start > 2500) return false;
        await sleep(800);
    }
    if (await hasBlockingOverlay(page) || await findConsentBox(page)) {
        for (const frame of page.frames()) {
            if (frame === page.mainFrame()) continue;
            try {
                const el = await frame.frameElement();
                if (!el) continue;
                const box = await el.boundingBox();
                if (!isVisibleBox(box) || box.width < 280 || box.height < 240) continue;
                await page.mouse.click(box.x + box.width * 0.72, box.y + box.height * 0.84);
                log(`👍 已按 iframe 右下区域点击 cookie 同意 (${Math.round(box.width)}x${Math.round(box.height)})`);
                await sleep(1200);
                break;
            } catch (e) { /* ignore */ }
        }
    }
    if (await hasBlockingOverlay(page)) {
        const n = await forceHideCmp(page);
        log(`⚠️ cookie 弹窗未能点掉，已强制隐藏 ${n} 个遮罩以免挡登录`);
        await sleep(400);
        return true;
    }
    return clicked;
}

async function fillCredentials(page) {
    log('📧 填写登录凭证...');
    await page.waitForFunction(() => {
        const inputs = Array.from(document.querySelectorAll('input')).filter((el) => {
            const type = (el.getAttribute('type') || 'text').toLowerCase();
            return type !== 'hidden' && type !== 'checkbox' && type !== 'submit';
        });
        return inputs.length >= 2;
    }, { timeout: 20000 });

    const written = await page.evaluate((email, password) => {
        const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
        const inputs = Array.from(document.querySelectorAll('input')).filter((el) => {
            const type = (el.getAttribute('type') || 'text').toLowerCase();
            return visible(el) && type !== 'hidden' && type !== 'checkbox' && type !== 'submit';
        });
        const user = document.querySelector('input[name="username"], input[name="user"], input[type="email"], #usernameOrEmail, #username')
            || inputs.find((el) => (el.getAttribute('type') || 'text').toLowerCase() !== 'password');
        const pass = document.querySelector('input[name="password"], input[type="password"], #password')
            || inputs.find((el) => (el.getAttribute('type') || '').toLowerCase() === 'password');
        if (!user || !pass) return { ok: false, reason: 'missing-fields' };

        const setVal = (el, value) => {
            const desc = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
            el.focus();
            desc.set.call(el, value);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        setVal(user, email);
        setVal(pass, password);
        return { ok: true, emailVal: user.value || '' };
    }, EMAIL, PASSWORD);

    if (!written || !written.ok || written.emailVal !== EMAIL) {
        log('⚠️ evaluate 写入异常，回退 page.type');
        const userSel = 'input[name="username"], input[type="email"], form input:not([type="password"]):not([type="hidden"])';
        const passSel = 'input[name="password"], input[type="password"]';
        await page.click(userSel, { clickCount: 3 });
        await page.keyboard.press('Backspace');
        await page.type(userSel, EMAIL, { delay: 20 });
        await page.click(passSel, { clickCount: 3 });
        await page.keyboard.press('Backspace');
        await page.type(passSel, PASSWORD, { delay: 20 });
    }
    await sleep(400);
}

async function diagnosePage(page) {
    try {
        return await page.evaluate(() => {
            const body = document.body ? document.body.innerText.replace(/\s+/g, ' ').slice(0, 400) : '';
            const cf = document.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], .cf-turnstile');
            const tEl = document.querySelector('[name="cf-turnstile-response"]');
            const cmp = document.querySelector('.fc-consent-root, .fc-dialog, [class*="fc-consent"]');
            const buttons = Array.from(document.querySelectorAll('button')).slice(0, 12).map((el) => {
                const r = el.getBoundingClientRect();
                return `${(el.innerText || '').trim().slice(0, 24)}[${Math.round(r.width)}x${Math.round(r.height)}]`;
            });
            return {
                url: location.href,
                title: document.title,
                hasCfIframe: !!cf,
                hasTurnstileApi: !!(window.turnstile),
                hasCmp: !!cmp,
                tokenLen: tEl && tEl.value ? tEl.value.length : 0,
                buttons,
                body,
            };
        });
    } catch (e) {
        return { diagError: e.message };
    }
}

function isLoggedInUrl(url) {
    if (!url) return false;
    if (url.includes('/auth/login') || url.includes('/auth/password') || url.includes('/auth/register')) return false;
    return url.startsWith(BASE_URL);
}

// 点击 LOGIN 按钮；找不到按钮时回退到 form.submit()。返回是否触发了提交。
async function clickLoginButton(page) {
    const loginBox = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
        const b = btns.find((el) => {
            const t = (el.innerText || el.value || '').trim().toLowerCase();
            return t === 'login' || t === 'sign in' || t === 'log in';
        });
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    if (loginBox && isVisibleBox(loginBox)) {
        await clickBox(page, loginBox);
        return true;
    }
    return await page.evaluate(() => {
        const form = document.querySelector('form');
        if (form) { form.submit(); return true; }
        return false;
    });
}

// 登录表单用的是 reCAPTCHA v3（invisible）。点 LOGIN 会触发 grecaptcha.execute，
// 若实例尚未 render 就点，站点会报 "This recaptcha instance did not render yet."。
// 这里等 grecaptcha API 就绪 + 缓冲，尽量保证点击时实例已渲染。
async function waitRecaptchaReady(page, timeoutS = 25) {
    const ok = await page
        .waitForFunction(() => !!(window.grecaptcha && typeof window.grecaptcha.execute === 'function'), { timeout: timeoutS * 1000 })
        .then(() => true)
        .catch(() => false);
    await sleep(1800); // 给 React 把 recaptcha 实例 render 完留缓冲
    return ok;
}

// 读取登录页的报错提示，区分「凭证错误(致命)」与「recaptcha 未渲染(可重试)」
async function readLoginError(page) {
    return await page.evaluate(() => {
        const alert = Array.from(document.querySelectorAll('[role="alert"], .alert, [class*="flash"], [class*="Flash"]'))
            .map((e) => (e.textContent || '').trim().replace(/\s+/g, ' '))
            .filter(Boolean)
            .join(' | ');
        const body = document.body ? document.body.innerText.replace(/\s+/g, ' ') : '';
        return { alert, body };
    }).catch(() => ({ alert: '', body: '' }));
}

// 诊断埋点：puppeteer-real-browser 下 page.on('request'/'response') 不触发，
// 改为在页面里 hook fetch + XMLHttpRequest（axios 走 XHR），把登录相关请求记到 window.__net。
// 代理(数据中心IP)环境下登录静默卡住，用这些证据判断是「没发出提交 / 提交挂起」还是「服务端拒绝」。
let _diagAttached = false;
async function attachLoginDiagnostics(page) {
    if (_diagAttached) return;
    _diagAttached = true;
    try {
        await page.evaluateOnNewDocument(() => {
            window.__net = [];
            window.__netCursor = 0;
            const rec = (o) => { try { window.__net.push(o); if (window.__net.length > 60) window.__net.shift(); } catch (e) { /* */ } };
            const of = window.fetch;
            if (of) {
                window.fetch = function (...a) {
                    const url = (a[0] && a[0].url) || a[0];
                    const method = (a[1] && a[1].method) || (a[0] && a[0].method) || 'GET';
                    return of.apply(this, a).then(async (res) => {
                        let body = ''; try { body = (await res.clone().text()).slice(0, 300); } catch (e) { /* */ }
                        rec({ t: 'fetch', method, url: String(url), status: res.status, body });
                        return res;
                    }, (err) => { rec({ t: 'fetch-err', method, url: String(url), err: String(err) }); throw err; });
                };
            }
            const oo = XMLHttpRequest.prototype.open;
            const os = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.open = function (m, u) { this.__m = m; this.__u = u; return oo.apply(this, arguments); };
            XMLHttpRequest.prototype.send = function (...a) {
                this.addEventListener('loadend', () => {
                    let body = ''; try { body = String(this.responseText || '').slice(0, 300); } catch (e) { /* */ }
                    rec({ t: 'xhr', method: this.__m, url: String(this.__u), status: this.status, body });
                });
                return os.apply(this, a);
            };
        });
    } catch (e) {
        log(`⚠️ 诊断埋点注入失败: ${e.message}`);
    }
}

// 读取并打印页面里新记录的请求。all=true 时（超时诊断）打印全部已捕获请求，不过滤。
async function dumpNet(page, tag = '', all = false) {
    try {
        const items = await page.evaluate((dumpAll) => {
            const arr = window.__net || [];
            if (dumpAll) return arr.slice(-40);
            const from = window.__netCursor || 0;
            window.__netCursor = arr.length;
            return arr.slice(from);
        }, all);
        if (all) log(`🛰️${tag} 共捕获 ${items.length} 条请求：`);
        for (const it of items) {
            if (!all && !/\/auth\/login|\/api\/|recaptcha|google\.com\/recaptcha/i.test(it.url)) continue;
            if (it.t === 'fetch-err') log(`🛰️${tag} ${it.method} ${String(it.url).slice(0, 100)} 失败: ${it.err}`);
            else log(`🛰️${tag} ${it.status} ${it.method} ${String(it.url).slice(0, 90)} | ${(it.body || '').replace(/\s+/g, ' ').slice(0, 200)}`);
        }
    } catch (e) { /* ignore */ }
}

async function login(page) {
    await attachLoginDiagnostics(page);
    log('🌐 打开登录页面...');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await humanWait(2, 4);
    await waitDismissOverlays(page, 20);

    if (isLoggedInUrl(page.url()) && !page.url().includes('/auth/login')) {
        log(`✅ 已有登录态，当前: ${page.url()}`);
        return page.url();
    }

    if (await hasBlockingOverlay(page)) {
        await waitDismissOverlays(page, 10);
    }

    await fillCredentials(page);
    if (await hasBlockingOverlay(page)) {
        await waitDismissOverlays(page, 8);
        await fillCredentials(page);
    }
    await humanWait(1, 2);

    // 先尽量把 cookie 弹窗点掉，再等 reCAPTCHA 实例渲染，最后才点 LOGIN
    await clickConsentNative(page);
    const rcReady = await waitRecaptchaReady(page, 25);
    log(`🔐 reCAPTCHA ${rcReady ? '已就绪' : '未确认就绪（仍会尝试并在报错后重试）'}`);

    log('🖱️ 点击 LOGIN...');
    if (!(await clickLoginButton(page))) throw new Error('未找到 LOGIN 按钮');

    // cookie 弹窗（Google Funding Choices）经代理时常迟到几秒~十几秒才渲染，
    // 会把点击 LOGIN 「吞掉」而不提交。实测：主文档里对 .fc-cta-consent 原生 .click()
    // 能可靠关闭整个弹窗。所以每轮都无条件尝试点「同意」，点掉后补点 LOGIN。
    // 另外 reCAPTCHA 未渲染时点 LOGIN 会报 "did not render yet"，此为可重试错误。
    let relogins = 0;
    for (let i = 0; i < 50; i++) {
        await sleep(1000);
        await dumpNet(page);
        const url = page.url();
        if (isLoggedInUrl(url) && !url.includes('/auth/login')) {
            log(`✅ 登录成功，已跳转: ${url}`);
            return url;
        }
        const consentText = await clickConsentNative(page);
        if (consentText) {
            log(`👍 已点 cookie 弹窗: ${consentText} (native)`);
            await sleep(600);
            if (relogins < 6) {
                await waitRecaptchaReady(page, 8);
                await clickLoginButton(page);
                relogins += 1;
                log('🖱️ 关闭 cookie 弹窗后补点 LOGIN');
            }
            continue;
        }

        const { alert, body } = await readLoginError(page);
        const text = alert || body;
        // 凭证类错误：致命，直接抛出
        if (/these credentials do not match|invalid credentials|incorrect password/i.test(text) && i > 3) {
            await screenshot(page, 'login_error.png');
            throw new Error(`登录被拒（凭证错误）: ${(alert || text).slice(0, 120)} | ${url}`);
        }
        // reCAPTCHA 未渲染：可重试，等它渲染后重点 LOGIN
        if (/recaptcha.*(did not render|not.*render|render yet)|did not render yet/i.test(text)) {
            if (relogins < 6) {
                await waitRecaptchaReady(page, 12);
                await clickLoginButton(page);
                relogins += 1;
                log('🔁 reCAPTCHA 未就绪报错，等待渲染后重试 LOGIN');
            }
            continue;
        }
        // 仍停在登录页且无明显报错：首次点击可能被吞，择机补点
        if ((i === 15 || i === 30) && relogins < 6) {
            await clickLoginButton(page);
            relogins += 1;
            log('🖱️ 仍在登录页，重试点击 LOGIN');
        }
        if (i === 20) {
            const token = await getTurnstileToken(page);
            log(`⏳ 仍在登录页，Turnstile token 长度=${token ? token.length : 0}`);
        }
    }

    await screenshot(page, 'login_timeout.png');
    await dumpNet(page, '(超时)', true);
    const diag = await diagnosePage(page);
    throw new Error(`登录超时未离开登录页 | ${JSON.stringify(diag)}`);
}

async function readRenewState(page) {
    return await page.evaluate(() => {
        const body = document.body ? document.body.innerText : '';
        const remain = (body.match(/TIME REMAINING[\s\S]{0,40}?(\d{1,2}:\d{2}:\d{2})/i) || [])[1]
            || (body.match(/(\d{2}:\d{2}:\d{2})\s*HH\s*:\s*MM\s*:\s*SS/i) || [])[1]
            || '';
        const cooldown = /renewal cooldown/i.test(body);
        const cooldownTime = (body.match(/(\d{2}:\d{2}:\d{2})\s*renewal cooldown/i) || [])[1] || '';
        const success = /server renewed successfully/i.test(body);
        const failedLoad = /failed to load\. try again/i.test(body);
        const security = /complete security check to renew/i.test(body);
        const renewBtn = Array.from(document.querySelectorAll('button')).some((el) =>
            /RENEW \+8 HOURS/i.test((el.textContent || '').replace(/\s+/g, ' '))
        );
        const flash = Array.from(document.querySelectorAll('[role="alert"], .alert, .Toastify')).map((el) =>
            (el.textContent || '').trim().replace(/\s+/g, ' ')
        ).filter(Boolean)[0] || '';
        return { remain, cooldown, cooldownTime, success, failedLoad, security, renewBtn, flash, url: location.href };
    });
}

async function openServer(page) {
    const target = `${BASE_URL}/server/${SERVER_ID}`;
    log(`📂 打开服务器页: ${target}`);
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await humanWait(2, 4);
    await dismissOverlays(page);

    for (let i = 0; i < 20; i++) {
        const st = await readRenewState(page);
        if (st.remain || st.renewBtn || st.cooldown) return st;
        await sleep(1000);
    }
    await screenshot(page, 'server_page_timeout.png');
    throw new Error('服务器详情页未出现续期区域');
}

async function clickRenew(page) {
    log('🖱️ 点击 RENEW +8 HOURS...');
    const ok = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const b = btns.find((el) => /RENEW \+8 HOURS/i.test((el.textContent || '').replace(/\s+/g, ' ')));
        if (!b || b.disabled) return false;
        b.click();
        return true;
    });
    if (!ok) {
        await screenshot(page, 'no_renew_button.png');
        throw new Error('未找到可点击的 RENEW +8 HOURS 按钮（可能在冷却中）');
    }
}

async function waitTurnstileSolved(page, timeoutS = 75) {
    log('📡 等待 Turnstile（compact/auto）求解并提交续期...');
    const before = await readRenewState(page);
    const beforeSec = timeToSeconds(before.remain);
    let clicksOnThisWidget = 0;
    let widgetWaitStart = 0;
    let retried = 0;
    let loggedToken = false;
    let iframeSeenAt = null;
    let loggedWaitAuto = false;

    for (let i = 0; i < timeoutS; i++) {
        await sleep(1000);
        const st = await readRenewState(page);
        const afterSec = timeToSeconds(st.remain);
        if (st.success || /renewed successfully/i.test(st.flash)) {
            return { ok: true, status: 'success', text: st.flash || 'Server renewed successfully!', remain: st.remain };
        }
        if (st.flash && /error|fail|invalid|cooldown|too many/i.test(st.flash) && !/successfully/i.test(st.flash)) {
            return { ok: false, status: 'failed', text: st.flash, remain: st.remain };
        }
        if (afterSec && beforeSec && afterSec - beforeSec >= 60) {
            return {
                ok: true,
                status: 'success',
                text: `剩余时间 ${formatHms(beforeSec)} → ${formatHms(afterSec)}`,
                remain: st.remain,
            };
        }
        if (st.cooldown && !st.security) {
            return {
                ok: true,
                status: 'success',
                text: `已进入冷却（${st.cooldownTime || '未知'}），视为续期已提交`,
                remain: st.remain,
            };
        }

        if (await hasBlockingOverlay(page) || await findConsentBox(page)) {
            await clickConsentNative(page);
            if (await hasBlockingOverlay(page)) await forceHideCmp(page);
        }

        const token = await getTurnstileToken(page);
        const cfUrls = cfFrameUrls(page);
        if (cfUrls.length && iframeSeenAt == null) iframeSeenAt = i;
        if (!cfUrls.length) {
            iframeSeenAt = null;
            loggedWaitAuto = false;
        }
        const iframeAgeS = iframeSeenAt == null ? 0 : i - iframeSeenAt;
        const action = turnstileAction({
            hasToken: !!token,
            hasIframe: cfUrls.length > 0,
            iframeAgeS,
            clicksOnThisWidget,
        });
        if (action === 'wait-auto' && !loggedWaitAuto) {
            loggedWaitAuto = true;
            log(`⏳ 先等 Turnstile auto（${TURNSTILE_AUTO_WAIT_S}s）: ${cfUrls[0].slice(0, 160)}`);
        }
        if (action === 'click') {
            const hit = await clickTurnstileWidgets(page);
            if (hit.clicked) {
                clicksOnThisWidget += 1;
                widgetWaitStart = i;
                log(`🖱️ 已点 Turnstile compact 控件 ${hit.size || ''}（auto 未出 token，点一次后等待）`);
            }
        } else if (token && !loggedToken) {
            loggedToken = true;
            log(`✅ Turnstile token 已就绪（长度 ${token.length}），等待站点自动提交...`);
        }

        if (i === 8 || i === 20 || i === 40) {
            log(`⏳ Turnstile 仍在求解中... action=${action} cfFrames=${cfUrls.length} tokenLen=${token ? token.length : 0} clicks=${clicksOnThisWidget} age=${iframeAgeS}s`);
        }
        if (clicksOnThisWidget >= 1 && i - widgetWaitStart >= 22 && !token && retried < 2) {
            log('⚠️ 点击后仍无 token，取消后重开弹窗...');
            await page.evaluate(() => {
                const cancel = Array.from(document.querySelectorAll('button')).find((el) =>
                    (el.textContent || '').trim().toLowerCase() === 'cancel'
                );
                if (cancel) cancel.click();
            });
            await sleep(1200);
            await clickRenew(page);
            clicksOnThisWidget = 0;
            iframeSeenAt = null;
            loggedWaitAuto = false;
            retried += 1;
        } else if (!cfUrls.length && (i === 14 || i === 32) && retried < 2) {
            log('⚠️ 未出现 Turnstile iframe，取消后重试点击 RENEW...');
            await page.evaluate(() => {
                const cancel = Array.from(document.querySelectorAll('button')).find((el) =>
                    (el.textContent || '').trim().toLowerCase() === 'cancel'
                );
                if (cancel) cancel.click();
            });
            await sleep(1200);
            await clickRenew(page);
            clicksOnThisWidget = 0;
            iframeSeenAt = null;
            loggedWaitAuto = false;
            retried += 1;
        }
        if (st.failedLoad && i > 12 && i % 15 === 0) {
            log('⚠️ Turnstile 加载失败，取消后重试点击 RENEW...');
            await page.evaluate(() => {
                const cancel = Array.from(document.querySelectorAll('button')).find((el) =>
                    (el.textContent || '').trim().toLowerCase() === 'cancel'
                );
                if (cancel) cancel.click();
            });
            await sleep(1500);
            await clickRenew(page);
            clicksOnThisWidget = 0;
            iframeSeenAt = null;
            loggedWaitAuto = false;
        }
    }

    await screenshot(page, 'turnstile_timeout.png');
    const diag = await diagnosePage(page);
    diag.cfFrames = cfFrameUrls(page).map((u) => u.slice(0, 100));
    throw new Error(`Turnstile/续期提交超时 | ${JSON.stringify(diag)}`);
}

async function renew(page) {
    const before = await openServer(page);
    log(`🕒 续期前剩余: ${before.remain || '未知'} | 冷却: ${before.cooldown ? (before.cooldownTime || '是') : '否'}`);

    if (before.cooldown && !before.renewBtn) {
        await screenshot(page, 'renewal_cooldown.png');
        return {
            ok: false,
            status: 'cooldown',
            text: `续期冷却中（${before.cooldownTime || '未知'}），剩余 ${before.remain || '未知'}`,
            remain: before.remain,
            cooldownTime: before.cooldownTime || '',
        };
    }

    if (!before.renewBtn) {
        await screenshot(page, 'no_renew_button.png');
        throw new Error('页面上没有 RENEW +8 HOURS 按钮');
    }

    await clickRenew(page);
    await humanWait(1, 2);

    const result = await waitTurnstileSolved(page, 80);
    if (result.ok) {
        log(`✅ 续期成功: ${result.text}`);
        await screenshot(page, 'renewal_ok.png');
        return result;
    }
    log(`❌ 续期失败: ${result.text}`);
    await screenshot(page, 'renewal_fail.png');
    return result;
}

async function main() {
    if (!SESSION_COOKIES && (!EMAIL || !PASSWORD)) {
        log('❌ 请设置 SESSION_COOKIES，或设置环境变量 EMAIL 和 PASSWORD');
        process.exit(1);
    }
    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

    let browser;
    let page;
    try {
        ({ browser, page } = await launchRealBrowser());
    } catch (e) {
        log(`❌ ${e.message}`);
        await sendTelegram(formatNotification({ status: '❌ 登录失败', error: e.message }));
        process.exit(1);
    }

    let egressIp = '';
    try {
        if (IS_PROXY) log(`🔗 挂载代理: ${PROXY_SERVER}`);
        else log('🍭 未使用代理，直连访问');
        await page.goto('https://api.ip.sb/ip', { waitUntil: 'domcontentloaded', timeout: 20000 });
        egressIp = await page.evaluate(() => (document.body.innerText || '').trim()).catch(() => '');
        log(`📍 当前出口IP: ${maskIp(egressIp)}`);
    } catch (e) {
        log(`⚠️ 获取出口 IP 失败: ${e.message}`);
    }

    try {
        if (!(await restoreSession(page))) await login(page);
    } catch (e) {
        log(`❌ 登录失败: ${e.message}`);
        await sendTelegram(formatNotification({ status: '❌ 登录失败', ip: egressIp, error: e.message }));
        try { await browser.close(); } catch (x) {}
        process.exit(1);
    }

    try {
        const r = await renew(page);
        const payload = {
            remain: r.remain,
            cooldown: r.cooldownTime,
            ip: egressIp,
        };
        if (r.ok) {
            await sendTelegram(formatNotification({
                ...payload,
                status: '✅ 续期成功',
                note: r.text,
            }));
        } else if (r.status === 'cooldown') {
            await sendTelegram(formatNotification({
                ...payload,
                status: '⏳ 续期冷却中',
            }));
        } else {
            await sendTelegram(formatNotification({
                ...payload,
                status: '❌ 续期可能失败',
                error: r.text,
            }));
            process.exitCode = 1;
        }
    } catch (e) {
        log(`❌ 续期异常: ${e.message}`);
        await screenshot(page, 'renew_error.png');
        await sendTelegram(formatNotification({ status: '❌ 续期异常', error: e.message }));
        process.exitCode = 1;
    } finally {
        try { await browser.close(); } catch (e) {}
    }
    log('🏁 脚本执行完毕');
}

if (require.main === module) {
    main().catch((e) => {
        console.error(e);
        process.exit(1);
    });
}

module.exports = {
    parseSessionCookies,
    turnstileClickPoint,
    turnstileAction,
    isClickInViewport,
    formatNotification,
};
