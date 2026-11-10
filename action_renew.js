const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const { INJECTED_SCRIPT, bypassTurnstile } = require('./turnstile/turnstile');

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

async function sendTelegramMessage(message) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;

    try {
        await axios.post(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
            chat_id: TG_CHAT_ID,
            text: message,
            parse_mode: 'Markdown'
        });
        console.log('[Telegram] Message sent.');
    } catch (e) {
        console.error('[Telegram] Failed to send message:', e.message);
    }
}

// 启用 stealth 插件
chromium.use(stealth);

// GitHub Actions 环境下的 Chrome 路径 (通常是 google-chrome)
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;

// 确保 localhost 不走代理
process.env.NO_PROXY = 'localhost,127.0.0.1';

// --- Proxy Configuration ---
const HTTP_PROXY = process.env.HTTP_PROXY;
let PROXY_CONFIG = null;

if (HTTP_PROXY) {
    try {
        const proxyUrl = new URL(HTTP_PROXY);
        PROXY_CONFIG = {
            server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
            username: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
            password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined
        };
        console.log(`[代理] 检测到配置: 服务器=${PROXY_CONFIG.server}, 认证=${PROXY_CONFIG.username ? '是' : '否'}`);
    } catch (e) {
        console.error('[代理] TODO HTTP_PROXY 格式无效。期望格式: http://user:pass@host:port 或 http://host:port');
        process.exit(1);
    }
}

// INJECTED_SCRIPT moved to turnstile/turnstile.js

// 辅助函数：检测代理是否可用
async function checkProxy() {
    if (!PROXY_CONFIG) {
        console.log('[DEBUG] checkProxy: no proxy config');
        return true;
    }

    const proto = new URL(PROXY_CONFIG.server).protocol;
    console.log('[DEBUG] checkProxy: protocol=' + proto);

    if (proto === 'socks5:' || proto === 'socks5h:' || proto === 'socks4:') {
        console.log('[代理] SOCKS proxy detected, skipping HTTP validation.');
        return true;
    }

    console.log('[代理] 正在验证代理连接...');
    try {
        const axiosConfig = {
            proxy: {
                protocol: 'http',
                host: new URL(PROXY_CONFIG.server).hostname,
                port: new URL(PROXY_CONFIG.server).port,
            },
            timeout: 10000
        };

        if (PROXY_CONFIG.username && PROXY_CONFIG.password) {
            axiosConfig.proxy.auth = {
                username: PROXY_CONFIG.username,
                password: PROXY_CONFIG.password
            };
        }

        await axios.get('https://www.google.com', axiosConfig);
        console.log('[代理] 连接成功！');
        return true;
    } catch (error) {
        console.error('[代理] 连接失败: ' + error.message);
        return false;
    }
}

// --- 续期状态缓存 ---
const STATE_FILE = 'renewal-state.json';

function loadRenewalState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            const raw = fs.readFileSync(STATE_FILE, 'utf8');
            console.log('[DEBUG] renewal-state.json 内容:', raw);
            return JSON.parse(raw);
        }
    } catch (e) { }
    return null;
}

function saveRenewalState(skipUntilISO, source) {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify({
            skipUntil: skipUntilISO,
            source: source || 'unknown',   // 记录来源文本，便于排查
            updatedAt: new Date().toISOString()
        }));
        console.log(`[缓存] 续期状态已保存, 下次跳过至: ${skipUntilISO} (来源: ${source || 'N/A'})`);
    } catch (e) {
        console.error('[缓存] 保存状态失败:', e.message);
    }
}

// 手动忽略缓存：设置 FORCE_RENEW=1 可绕过缓存强制运行一次
const FORCE_RENEW = process.env.FORCE_RENEW === '1' || process.env.FORCE_RENEW === 'true';

const MONTHS = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    january: 0, february: 1, march: 2, april: 3, june: 5, july: 6,
    august: 7, september: 8, october: 9, november: 10, december: 11
};

// 把各种日期文案解析成 UTC 零点的 Date。解析失败返回 null（不再伪造日期）
function parseNextDate(dateStr) {
    if (!dateStr) return null;
    let s = String(dateStr).trim();
    if (!s) return null;

    // 去掉常见前缀噪声，取最后一段像日期的内容
    s = s.replace(/^.*?(?:as of|available|until|on)\s*[:：]?\s*/i, '').trim();
    // 去掉序数后缀 13th -> 13
    s = s.replace(/(\d+)(st|nd|rd|th)/gi, '$1');
    s = s.replace(/[,]/g, ' ').replace(/\s+/g, ' ').trim();

    let y = null, m = null, d = null;

    // 1) ISO / 斜杠格式: 2026-11-13, 2026/11/13
    let mm = s.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (mm) {
        y = +mm[1]; m = +mm[2] - 1; d = +mm[3];
    }

    // 2) 美式: 11/13/2026
    if (y === null) {
        mm = s.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
        if (mm) { m = +mm[1] - 1; d = +mm[2]; y = +mm[3]; }
    }

    // 3) 英文月份: November 13 2026 / Nov 13 / 13 Nov 2026
    // 注意匹配顺序：先试「日 月」形式（13 Nov），
    // 否则 "13 Nov 2026" 会被「月 日」正则误读成 月份=13（无效）。
    if (y === null) {
        const rev = s.match(/(\d{1,2})\s+([A-Za-z]{3,9})(?:\s+(\d{4}))?/);
        const fwd = s.match(/([A-Za-z]{3,9})\s+(\d{1,2})(?:\s+(\d{4}))?/);
        if (rev && MONTHS[rev[2].toLowerCase()] !== undefined) {
            d = +rev[1]; m = MONTHS[rev[2].toLowerCase()];
            y = rev[3] ? +rev[3] : null;
        } else if (fwd && MONTHS[fwd[1].toLowerCase()] !== undefined) {
            m = MONTHS[fwd[1].toLowerCase()]; d = +fwd[2];
            y = fwd[3] ? +fwd[3] : null;
        }
    }

    // 4) 中文: 11月13日 / 2026年11月13日
    if (y === null) {
        mm = s.match(/(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月\s*(\d{1,2})\s*日?/);
        if (mm) {
            y = mm[1] ? +mm[1] : null;
            m = +mm[2] - 1; d = +mm[3];
        }
    }

    if (m === null || d === null) {
        console.log('[日期] 无法解析: ' + JSON.stringify(dateStr));
        return null;
    }

    if (y === null) {
        // 没写年份：如果该日期已过去，则认为是明年
        const now = new Date();
        y = now.getUTCFullYear();
    }

    if (y < 2024 || y > 2100 || m < 0 || m > 11 || d < 1 || d > 31) {
        console.log('[日期] 数值异常: ' + JSON.stringify(dateStr) + ' -> y=' + y + ' m=' + m + ' d=' + d);
        return null;
    }

    const out = new Date(Date.UTC(y, m, d));
    if (isNaN(out.getTime())) return null;
    return out;
}

function checkPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}/json/version`, (res) => {
            resolve(true);
        });
        req.on('error', () => resolve(false));
        req.end();
    });
}

async function launchChrome() {
    console.log('检查 Chrome 是否已在端口 ' + DEBUG_PORT + ' 上运行...');
    if (await checkPort(DEBUG_PORT)) {
        console.log('Chrome 已开启。');
        return;
    }

    console.log(`正在启动 Chrome (路径: ${CHROME_PATH})...`);

    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--no-first-run',
        '--no-default-browser-check',
        // '--headless=new', // (已被注释) 使用 xvfb-run 时不需要 headless 模式，这样可以模拟有头浏览器增加成功率
        '--disable-gpu',
        '--window-size=1280,720',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--user-data-dir=/tmp/chrome_user_data'
    ];

    if (PROXY_CONFIG) {
        args.push(`--proxy-server=${PROXY_CONFIG.server}`);
        args.push('--proxy-bypass-list=<-loopback>');
    }
    // 添加针对 Linux 环境的额外稳定性参数
    args.push('--disable-dev-shm-usage'); // 避免共享内存不足


    const chrome = spawn(CHROME_PATH, args, {
        detached: true,
        stdio: 'ignore'
    });
    chrome.unref();

    console.log('正在等待 Chrome 初始化...');
    for (let i = 0; i < 20; i++) {
        if (await checkPort(DEBUG_PORT)) break;
        await new Promise(r => setTimeout(r, 1000));
    }

    if (!await checkPort(DEBUG_PORT)) {
        console.error('Chrome 无法在端口 ' + DEBUG_PORT + ' 上启动');
        throw new Error('Chrome 启动失败');
    }
}

function getUsers() {
    // 从环境变量读取 JSON 字符串
    // GitHub Actions Secret: USERS_JSON = [{"username":..., "password":...}]
    try {
        if (process.env.USERS_JSON) {
            const parsed = JSON.parse(process.env.USERS_JSON);
            return Array.isArray(parsed) ? parsed : (parsed.users || []);
        }
    } catch (e) {
        console.error('解析 USERS_JSON 环境变量错误:', e);
    }
    return [];
}

// attemptTurnstileCdp moved to turnstile/turnstile.js

(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.log('未在 process.env.USERS_JSON 中找到用户');
        process.exit(1);
    }

    if (PROXY_CONFIG) {
        const isValid = await checkProxy();
        if (!isValid) {
            console.error('[代理] 代理无效，终止运行。');
            process.exit(1);
        }
    }

    // 检查续期缓存: 如果还没到可用时间, 直接跳过
    //
    // 时区说明：CI（GitHub Actions / CircleCI）跑在 UTC，
    // 但站点可用时间是以北京时间为准的"日期"。
    // 若用 getUTCDate() 判断"今天"，在北京时间 00:00-08:00 这段
    // UTC 还停留在前一天，会白白多跳过一次运行。
    // 这里统一换算到 UTC+8 再比较日期。
    const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;
    const toBeijingDay = (dt) => {
        const t = new Date(dt.getTime() + TZ_OFFSET_MS);
        return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
    };

    const state = loadRenewalState();
    let staleCache = true;

    if (FORCE_RENEW) {
        console.log('[缓存] FORCE_RENEW=1, 忽略缓存强制运行。');
        staleCache = false;
    } else if (state && state.skipUntil) {
        const skipDate = new Date(state.skipUntil);
        if (isNaN(skipDate.getTime()) || skipDate.getFullYear() < 2024) {
            console.log(`[缓存] skipUntil(${state.skipUntil}) 无效, 忽略旧缓存。`);
        } else {
            const skipDay = toBeijingDay(skipDate);
            const todayDay = toBeijingDay(new Date());
            if (skipDay > todayDay) {
                const daysLeft = Math.round((skipDay - todayDay) / 86400000);
                console.log(`[缓存] 下次可用(北京): ${new Date(skipDay).toISOString().slice(0, 10)}, 今天(北京): ${new Date(todayDay).toISOString().slice(0, 10)}, 还差 ${daysLeft} 天, 跳过本次运行。`);
                process.exit(0);
            }
            console.log(`[缓存] 缓存已到期(可用日 ${new Date(skipDay).toISOString().slice(0, 10)} <= 今天 ${new Date(todayDay).toISOString().slice(0, 10)}), 继续执行。`);
            staleCache = false;
        }
    }

    // 随机延迟 0-9 分钟, 避免固定时间模式被检测
    // 忽略旧缓存时直接运行, 不延迟
    if (!staleCache) {
        const randomDelayMs = Math.floor(Math.random() * 540000);
        const delayMin = Math.round(randomDelayMs / 60000);
        if (delayMin > 0) {
            console.log(`[延迟] 随机等待 ${delayMin} 分钟...`);
            await new Promise(r => setTimeout(r, randomDelayMs));
        }
    }

    await launchChrome();

    console.log(`正在连接 Chrome...`);
    let browser;
    for (let k = 0; k < 5; k++) {
        try {
            browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
            console.log('连接成功！');
            break;
        } catch (e) {
            console.log(`连接尝试 ${k + 1} 失败。2秒后重试...`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    if (!browser) {
        console.error('连接失败。退出。');
        process.exit(1);
    }

    const context = browser.contexts()[0];
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.setDefaultTimeout(60000);

    if (PROXY_CONFIG && PROXY_CONFIG.username) {
        console.log('[代理] 正在设置认证...');
        await context.setHTTPCredentials({
            username: PROXY_CONFIG.username,
            password: PROXY_CONFIG.password
        });
    } else {
        await context.setHTTPCredentials(null);
    }

    await page.addInitScript(INJECTED_SCRIPT);
    console.log('注入脚本已添加。');

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        console.log(`\n=== 正在处理用户 ${i + 1}/${users.length} ===`); // 隐去具体邮箱 logging

        try {
            if (page.isClosed()) {
                page = await context.newPage();
                // Context credentials apply
                await page.addInitScript(INJECTED_SCRIPT);
            }

            // --- 登录逻辑 (简略版，逻辑一致) ---
            if (page.url().includes('dashboard')) {
                await page.goto('https://dashboard.katabump.com/auth/logout');
                await page.waitForTimeout(2000);
            }
            // 总是先去登录页
            await page.goto('https://dashboard.katabump.com/auth/login');
            await page.waitForTimeout(2000);
            if (page.url().includes('dashboard')) {
                // 如果登出没成功，再次登出
                await page.goto('https://dashboard.katabump.com/auth/logout');
                await page.waitForTimeout(2000);
                await page.goto('https://dashboard.katabump.com/auth/login');
            }

            console.log('正在输入凭据...');
            let loginOk = false;
            for (let loginAttempt = 1; loginAttempt <= 3; loginAttempt++) {
                try {
                    if (!page.url().includes('/auth/login')) {
                        await page.goto('https://dashboard.katabump.com/auth/login', { waitUntil: 'domcontentloaded' });
                        await page.waitForTimeout(2000);
                    }

                    const emailInput = page.getByRole('textbox', { name: 'Email' });
                    await emailInput.waitFor({ state: 'visible', timeout: 8000 });
                    await emailInput.fill('');
                    await emailInput.fill(user.username);
                    const pwdInput = page.getByRole('textbox', { name: 'Password' });
                    await pwdInput.fill('');
                    await pwdInput.fill(user.password);
                    await page.waitForTimeout(500);

                    // --- Cloudflare Turnstile Bypass for Login ---
                    console.log(`   >> 登录尝试 ${loginAttempt}/3: 检查 Turnstile...`);
                    const loginTurnstile = await bypassTurnstile(page, {
                        findAttempts: 20,
                        successTimeoutMs: 18000,
                        waitForSuccess: true,
                        label: 'Login'
                    });
                    if (loginTurnstile.clicked) {
                        console.log('   >> Turnstile 已点击。');
                    }
                    if (loginTurnstile.success) {
                        console.log('   >> 登录前 Turnstile 验证成功。');
                    } else {
                        console.log(`   >> Turnstile 未通过 (尝试 ${loginAttempt}/3)，刷新后重试...`);
                        await page.goto('https://dashboard.katabump.com/auth/login', { waitUntil: 'domcontentloaded' });
                        await page.waitForTimeout(3000);
                        continue;
                    }

                    await page.getByRole('button', { name: 'Login', exact: true }).click();

                    // wrong password
                    try {
                        const errorMsg = page.getByText('Incorrect password or no account');
                        if (await errorMsg.isVisible({ timeout: 2500 })) {
                            console.error(`   >> ❌ 登录失败: 用户 ${i + 1} 账号或密码错误`);
                            await sendTelegramMessage(`❌ *登录失败*\n用户: ${i + 1}\n原因: 账号或密码错误`);
                            loginOk = false;
                            break;
                        }
                    } catch (e) { }

                    // captcha error toast / text
                    try {
                        const captchaErr = page.getByText(/Please complete captcha|complete captcha/i);
                        if (await captchaErr.isVisible({ timeout: 2000 })) {
                            console.log('   >> 检测到 captcha 错误提示');
                        }
                    } catch (e) { }

                    console.log('   >> 等待登录跳转...');
                    try {
                        await page.waitForURL(url => !String(url).includes('/auth/login'), { timeout: 25000 });
                        console.log(`   >> 已跳转: ${page.url()}`);
                        loginOk = true;
                        break;
                    } catch (e) {
                        const cur = page.url();
                        console.log(`   >> 登录跳转超时, 当前 URL: ${cur}`);
                        if (cur.includes('error=captcha') || cur.includes('captcha')) {
                            console.log(`   >> captcha 失败 (尝试 ${loginAttempt}/3)，刷新重试...`);
                            await page.goto('https://dashboard.katabump.com/auth/login', { waitUntil: 'domcontentloaded' });
                            await page.waitForTimeout(3000);
                            continue;
                        }
                        if (cur.includes('/auth/login')) {
                            await page.waitForTimeout(2000);
                            continue;
                        }
                    }
                } catch (e) {
                    console.log(`登录错误 (尝试 ${loginAttempt}/3):`, e.message);
                    try {
                        await page.goto('https://dashboard.katabump.com/auth/login', { waitUntil: 'domcontentloaded' });
                        await page.waitForTimeout(2000);
                    } catch (re) { }
                }
            }

            if (!loginOk || page.url().includes('/auth/login')) {
                console.error(`   >> ❌ 登录失败，仍在登录页。title=${await page.title().catch(() => '')}`);
                try {
                    const bodyText = await page.locator('body').innerText({ timeout: 3000 });
                    console.log('   >> 页面摘要:', bodyText.replace(/\s+/g, ' ').slice(0, 300));
                } catch (e) { }
                await sendTelegramMessage(`❌ *登录失败*\n用户: ${i + 1}\n原因: captcha/跳转失败`);
                continue;
            }

            await page.waitForLoadState('domcontentloaded').catch(() => {});
            await page.waitForTimeout(2000);

            // 确保在 dashboard
            if (!page.url().includes('dashboard.katabump.com') || page.url().includes('/auth/')) {
                console.log('   >> 导航到 dashboard...');
                await page.goto('https://dashboard.katabump.com/', { waitUntil: 'domcontentloaded' });
                await page.waitForTimeout(2000);
            }

            console.log(`正在寻找 "See" 链接... URL=${page.url()}`);
            let seeFound = false;
            for (let seeAttempt = 1; seeAttempt <= 3; seeAttempt++) {
                try {
                    const seeCandidates = [
                        page.getByRole('link', { name: /^See$/i }),
                        page.getByRole('button', { name: /^See$/i }),
                        page.getByRole('link', { name: /查看|View|Manage|Details/i }),
                        page.getByRole('button', { name: /查看|View|Manage|Details/i }),
                        page.locator('a, button, [role="link"], [role="button"]').filter({ hasText: /^(See|查看|View|Manage)$/i }),
                        page.locator('a[href*="server"], a[href*="manage"], a[href*="detail"]'),
                    ];
                    let seeLoc = null;
                    for (const cand of seeCandidates) {
                        try {
                            const first = cand.first();
                            if (await first.isVisible({ timeout: 1500 }).catch(() => false)) {
                                seeLoc = first;
                                break;
                            }
                        } catch (e) { }
                    }
                    if (!seeLoc) {
                        seeLoc = page.locator('a:visible, button:visible').filter({ hasText: /See|查看/i }).first();
                        await seeLoc.waitFor({ state: 'visible', timeout: 8000 });
                    }
                    await page.waitForTimeout(500);
                    await seeLoc.click();
                    seeFound = true;
                    console.log(`   >> "See" 已点击 (尝试 ${seeAttempt}/3)`);
                    break;
                } catch (e) {
                    console.log(`未找到 "See" 按钮 (尝试 ${seeAttempt}/3), URL=${page.url()}, err=${e.message}`);
                    try {
                        const links = await page.locator('a:visible, button:visible').evaluateAll(els =>
                            els.slice(0, 40).map(el => (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40)).filter(Boolean)
                        );
                        console.log('   >> 可见链接/按钮:', JSON.stringify(links));
                    } catch (de) {
                        console.log('   >> 无法列出页面元素:', de.message);
                    }
                    if (seeAttempt < 3) {
                        await page.waitForTimeout(3000);
                        if (page.url().includes('/auth/login')) {
                            console.log('   >> 仍在登录页, 放弃 See 重试');
                            break;
                        }
                        try {
                            await page.goto('https://dashboard.katabump.com/', { waitUntil: 'domcontentloaded' });
                            await page.waitForTimeout(3000);
                        } catch (re) { }
                    }
                }
            }
            if (!seeFound) {
                console.log(`三次均未找到 "See" 按钮，跳过该用户。URL=${page.url()}`);
                continue;
            }

            // --- Renew 逻辑 ---
            let renewSuccess = false;
            // 2. 一个扁平化的主循环：尝试 Renew 整个流程 (最多 20 次)
            for (let attempt = 1; attempt <= 20; attempt++) {
                let hasCaptchaError = false;

                // 1. 如果是重试 (attempt > 1)，说明之前失败了或者刚刷新完页面
                // 我们直接开始寻找 Renew 按钮
                console.log(`\n[尝试 ${attempt}/20] 正在寻找 Renew 按钮...`);

                const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();
                try {
                    // 稍微等待一下，防止页面刚刷新还没渲染出来
                    await renewBtn.waitFor({ state: 'visible', timeout: 5000 });
                } catch (e) { }

                if (await renewBtn.isVisible()) {
                    await renewBtn.click();
                    console.log('Renew 按钮已点击。等待模态框...');

                    const modal = page.locator('#renew-modal');
                    try { await modal.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) {
                        console.log('模态框未出现？重试中...');
                        continue;
                    }

                    // A. 在模态框里晃晃鼠标
                    try {
                        const box = await modal.boundingBox();
                        if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
                    } catch (e) { }

                    // B. 找 Turnstile (小重试)
                    console.log('正在检查 Turnstile (使用 CDP 绕过)...');
                    const renewTurnstile = await bypassTurnstile(page, {
                        findAttempts: 30,
                        waitAfterClickMs: 8000,
                        waitForSuccess: true,
                        successTimeoutMs: 8000,
                        label: 'Renew'
                    });
                    const isTurnstileSuccess = renewTurnstile.success;

                    // D. 准备点击确认
                    const confirmBtn = modal.getByRole('button', { name: 'Renew' });
                    if (await confirmBtn.isVisible()) {

                        // User Request: 找不到的话这个循环直接下一步点击renew，然后检测有没有Please complete the captcha to continue
                        console.log('   >> 点击 Renew 确认按钮 (无论 Turnstile 状态如何)...');
                        await confirmBtn.click();

                        try {
                            // 1. Check for Errors (Captcha or Date limit)
                            const startVerifyTime = Date.now();
                            while (Date.now() - startVerifyTime < 3000) {
                                // A. Captcha Error
                                if (await page.getByText('Please complete the captcha to continue').isVisible()) {
                                    console.log('   >> ⚠️ 检测到错误: "Please complete the captcha".');
                                    hasCaptchaError = true;
                                    break;
                                }

                                // B. Not Renew Time Error
                                let notTimeLoc = page.getByText("You can't renew your server yet");
                                let notTimeVisible = await notTimeLoc.isVisible();
                                if (!notTimeVisible) {
                                    notTimeLoc = page.getByText("暂无法续期");
                                    notTimeVisible = await notTimeLoc.isVisible();
                                }
                                if (notTimeVisible) {
                                    const text = await notTimeLoc.innerText();
                                    // 从整段文案中提取日期部分。
                                    // 原正则 /(?:as of\s+|:?\s*)(.*?)(?:\s*\(|$)/ 缺少前置锚点，
                                    // 会把 "You can't renew..." 整段吞进去，导致后续解析失败。
                                    let dateStr = 'Unknown Date';
                                    const patterns = [
                                        /as of\s+([^\n(]+)/i,                              // as of November 13, 2026
                                        /available\s*[:：]?\s*([^\n(]+)/i,                 // Available: ...
                                        /下次可用\s*[:：]?\s*([^\n，,。]+)/,                 // 下次可用: 2026-11-13
                                        /(\d{4}[-/]\d{1,2}[-/]\d{1,2})/,                   // 2026-11-13
                                        /(\d{1,2}\s*月\s*\d{1,2}\s*日)/,                   // 11月13日
                                        /([A-Za-z]{3,9}\s+\d{1,2}(?:st|nd|rd|th)?,?\s*\d{4})/  // November 13, 2026
                                    ];
                                    for (const re of patterns) {
                                        const mm = text.match(re);
                                        if (mm && mm[1]) { dateStr = mm[1].trim(); break; }
                                    }
                                    console.log(`   >> ⏳ 暂无法续期。下次可用时间: ${dateStr}`);

                                    // 保存下次可用时间到缓存（解析失败则不写缓存，避免伪造日期）
                                    if (dateStr !== 'Unknown Date') {
                                        const nextDate = parseNextDate(dateStr);
                                        if (nextDate) {
                                            saveRenewalState(nextDate.toISOString(), dateStr);
                                        } else {
                                            console.log('   >> ⚠️ 日期解析失败，不写缓存（本次不做跳过判断）');
                                        }
                                    }

                                    await sendTelegramMessage(`⏳ *暂无法续期 (跳过)*\n用户: ${i + 1}\n原因: 还没到时间\n下次可用: ${dateStr}`);

                                    renewSuccess = true; // Mark as done to stop retries
                                    try {
                                        const closeBtn = modal.getByLabel('Close');
                                        if (await closeBtn.isVisible()) await closeBtn.click();
                                    } catch (e) { }
                                    break;
                                }
                                await page.waitForTimeout(200);
                            }
                        } catch (e) { }

                        if (renewSuccess) break; // Break loop if not time yet

                        if (hasCaptchaError) {
                            console.log('   >> Error found. Refreshing page to reset Turnstile...');
                            await page.reload();
                            await page.waitForTimeout(3000);
                            continue; // 刷新后，重新开始大循环
                        }

                        // F. 检查成功 (模态框消失)
                        await page.waitForTimeout(2000);
                        if (!await modal.isVisible()) {
                            console.log('   >> ✅ Modal closed. Renew successful!');

                            await sendTelegramMessage(`✅ *续期成功*\n用户: ${i + 1}\n状态: 服务器已成功续期！`);
                            // 续期成功: 4 天后再检查
                            const nextRenew = new Date();
                            nextRenew.setUTCDate(nextRenew.getUTCDate() + 4);
                            nextRenew.setUTCHours(0, 0, 0, 0);
                            saveRenewalState(nextRenew.toISOString());
                            renewSuccess = true;
                            break;
                        } else {
                            console.log('   >> 模态框仍打开但无错误？重试循环...');
                            await page.reload();
                            await page.waitForTimeout(3000);
                            continue;
                        }
                    } else {
                        console.log('   >> 未找到模态框内的验证按钮？刷新中...');
                        await page.reload();
                        await page.waitForTimeout(3000);
                        continue;
                    }

                } else {
                    console.log('未找到 Renew 按钮 (服务器可能已续期或页面加载错误)。');
                    break;
                }
            }
        } catch (err) {
            console.error(`Error processing user:`, err);
        }

        console.log(`用户 ${i + 1} 处理完成\n`);
    }

    console.log('完成。');
    await browser.close();
    process.exit(0);
})();
