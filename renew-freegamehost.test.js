const test = require('node:test');
const assert = require('node:assert/strict');
process.env.SERVER_ID = 'testsrv1';
const { parseSessionCookies, turnstileClickPoint, formatNotification, turnstileAction, isClickInViewport, buildChromeArgs, turnstileWidgetKey } = require('./renew-freegamehost');

test('parseSessionCookies parses cookie header string for puppeteer setCookie', () => {
    const cookies = parseSessionCookies('pterodactyl_session=abc%3D; XSRF-TOKEN=token; theme=dark');

    assert.deepEqual(cookies, [
        { name: 'pterodactyl_session', value: 'abc%3D', url: 'https://panel.freegamehost.xyz', path: '/' },
        { name: 'XSRF-TOKEN', value: 'token', url: 'https://panel.freegamehost.xyz', path: '/' },
        { name: 'theme', value: 'dark', url: 'https://panel.freegamehost.xyz', path: '/' },
    ]);
});

test('parseSessionCookies normalizes Chrome exported cookie JSON', () => {
    const raw = JSON.stringify([
        {
            name: 'pterodactyl_session',
            value: 'abc',
            domain: 'panel.freegamehost.xyz',
            path: '/',
            expirationDate: 1790000000,
            httpOnly: true,
            secure: true,
        },
    ]);

    assert.deepEqual(parseSessionCookies(raw), [
        {
            name: 'pterodactyl_session',
            value: 'abc',
            domain: 'panel.freegamehost.xyz',
            path: '/',
            expires: 1790000000,
            httpOnly: true,
            secure: true,
        },
    ]);
});

test('turnstileClickPoint aims at checkbox of normal 300x65 widget', () => {
    const p = turnstileClickPoint({ x: 100, y: 200, width: 300, height: 65 });
    assert.equal(p.x, 128);
    assert.equal(p.y, 232.5);
});

test('turnstileClickPoint aims at top-left checkbox of compact 150x140 widget', () => {
    const p = turnstileClickPoint({ x: 50, y: 80, width: 150, height: 140 });
    assert.equal(p.x, 77);
    assert.equal(p.y, 110);
});

test('turnstileClickPoint rejects invisible boxes', () => {
    assert.equal(turnstileClickPoint(null), null);
    assert.equal(turnstileClickPoint({ x: 0, y: 0, width: 10, height: 10 }), null);
});

test('isClickInViewport rejects the CI miss at y=1202 in 1280x1200', () => {
    assert.equal(isClickInViewport({ x: 958, y: 1202 }, { width: 1280, height: 1200 }), false);
    assert.equal(isClickInViewport({ x: 958, y: 800 }, { width: 1280, height: 1200 }), true);
    assert.equal(isClickInViewport({ x: -1, y: 100 }, { width: 1280, height: 1200 }), false);
});

test('turnstileAction waits for auto before the first click', () => {
    assert.equal(turnstileAction({ hasToken: true, hasIframe: true, iframeAgeS: 0, clicksOnThisWidget: 0 }), 'wait');
    assert.equal(turnstileAction({ hasToken: false, hasIframe: false, iframeAgeS: 0, clicksOnThisWidget: 0 }), 'wait');
    assert.equal(turnstileAction({ hasToken: false, hasIframe: true, iframeAgeS: 3, clicksOnThisWidget: 0 }), 'wait-auto');
    assert.equal(turnstileAction({ hasToken: false, hasIframe: true, iframeAgeS: 8, clicksOnThisWidget: 0 }), 'wait-auto');
    assert.equal(turnstileAction({ hasToken: false, hasIframe: true, iframeAgeS: 25, clicksOnThisWidget: 0 }), 'wait-auto');
    assert.equal(turnstileAction({ hasToken: false, hasIframe: true, iframeAgeS: 50, clicksOnThisWidget: 0 }), 'click');
    assert.equal(turnstileAction({ hasToken: false, hasIframe: true, iframeAgeS: 60, clicksOnThisWidget: 1 }), 'wait');
});

const clock = () => '2026-08-25 16:11:30';

test('cooldown notification is structured and does not duplicate remain', () => {
    const msg = formatNotification({
        status: '⏳ 续期冷却中',
        account: 'exampleuser@example.com',
        remain: '20:30:40',
        cooldown: '01:36:48',
        ip: '203.0.113.7',
    }, clock);
    assert.equal(msg, [
        '🎮 FreeGameHost 续期通知',
        '',
        '⏳ 续期冷却中',
        '👤 账户: ex****er@example.com',
        '🖥️ 服务器: testsrv1',
        '🕒 剩余时间: 20:30:40',
        '❄️ 冷却剩余: 01:36:48',
        '🌐 出口IP: 203.0.***.7',
        '⏱️ 2026-08-25 16:11:30',
    ].join('\n'));
    assert.equal((msg.match(/20:30:40/g) || []).length, 1);
});

test('success notification keeps remain once and drops success-banner note', () => {
    const msg = formatNotification({
        status: '✅ 续期成功',
        account: 'exampleuser@example.com',
        remain: '23:59:58',
        note: 'SuccessServer renewed successfully!',
        ip: '203.0.113.7',
    }, clock);
    assert.equal(msg, [
        '🎮 FreeGameHost 续期通知',
        '',
        '✅ 续期成功',
        '👤 账户: ex****er@example.com',
        '🖥️ 服务器: testsrv1',
        '🕒 剩余时间: 23:59:58',
        '🌐 出口IP: 203.0.***.7',
        '⏱️ 2026-08-25 16:11:30',
    ].join('\n'));
    assert.doesNotMatch(msg, /📝/);
    assert.doesNotMatch(msg, /SuccessServer/);
});

test('error notification truncates long dumps', () => {
    const msg = formatNotification({
        status: '❌ 续期异常',
        account: 'a@b.com',
        error: `Turnstile/续期提交超时 | ${'x'.repeat(500)}`,
    }, clock);
    assert.match(msg, /⚠️ /);
    assert.ok(msg.length < 400);
});

test('buildChromeArgs keeps window/size real-browser geometry and avoids automation flags', () => {
    const args = buildChromeArgs({ win: '1366x900' });
    assert.ok(args.includes('--window-size=1366,900'));
    assert.ok(args.includes('--disable-blink-features=AutomationControlled'));
    // 无 GPU 环境必须保留软件渲染，否则 WebGL 不可用
    assert.ok(args.includes('--enable-unsafe-swiftshader'));
    // 新 profile 首启向导会盖住站点
    assert.ok(args.includes('--no-first-run'));
    assert.ok(args.includes('--no-default-browser-check'));
});

test('buildChromeArgs clamps a malformed window size to the default', () => {
    const args = buildChromeArgs({ win: 'garbage' });
    assert.ok(args.includes('--window-size=1366,900'));
});

test('buildChromeArgs disables non-proxied WebRTC UDP only when proxied', () => {
    const direct = buildChromeArgs({});
    assert.ok(!direct.some((a) => a.startsWith('--proxy-server')));
    assert.ok(!direct.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'));

    const proxied = buildChromeArgs({ proxy: 'socks5://127.0.0.1:1080' });
    assert.ok(proxied.includes('--proxy-server=socks5://127.0.0.1:1080'));
    // 否则 WebRTC 会泄露 runner 真实 IP，与代理出口 IP 不一致
    assert.ok(proxied.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'));
});

test('turnstileWidgetKey treats a re-rendered widget as a new instance', () => {
    const a = turnstileWidgetKey('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/f/ov2/av0/rch/abc123/new/compact');
    const b = turnstileWidgetKey('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/f/ov2/av0/rch/xyz789/new/compact');
    assert.notEqual(a, b, '不同 rch 段的控件必须视为不同实例，否则计时不会重置');
    assert.equal(turnstileWidgetKey(''), '');
    assert.equal(turnstileWidgetKey('not a url'), 'not a url');
});

test('turnstileAction clicks at most once per widget after the auto window', () => {
    // TURNSTILE_NO_CLICK 在 require 时读取，此处为未设置状态
    assert.equal(
        turnstileAction({ hasToken: false, hasIframe: true, iframeAgeS: 999, clicksOnThisWidget: 0 }),
        'click'
    );
    // 已经点过一次就不再补刀，把剩下的时间全部留给 CF
    assert.equal(
        turnstileAction({ hasToken: false, hasIframe: true, iframeAgeS: 999, clicksOnThisWidget: 1 }),
        'wait'
    );
    // 内置求解器点过也算数（双重打断的根因）
    assert.equal(
        turnstileAction({ hasToken: false, hasIframe: true, iframeAgeS: 999, clicksOnThisWidget: 2 }),
        'wait'
    );
});
