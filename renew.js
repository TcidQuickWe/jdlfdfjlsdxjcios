const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');
const http = require('http');
const { INJECTED_SCRIPT, bypassTurnstile } = require('./turnstile/turnstile');

// 启用 stealth 插件
chromium.use(stealth);

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const USER_DATA_DIR = path.join(__dirname, 'ChromeData_Katabump');
const DEBUG_PORT = 9222;
const HEADLESS = false;
// const HTTP_PROXY = ""
// --- Proxy Configuration ---
const HTTP_PROXY = process.env.HTTP_PROXY; // e.g., http://user:pass@1.2.3.4:8080 or http://1.2.3.4:8080
let PROXY_CONFIG = null;

if (HTTP_PROXY) {
    try {
        const proxyUrl = new URL(HTTP_PROXY);
        PROXY_CONFIG = {
            server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
            username: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
            password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined
        };
        console.log(`[Proxy] Configuration detected: Server=${PROXY_CONFIG.server}, Auth=${PROXY_CONFIG.username ? 'Yes' : 'No'}`);
    } catch (e) {
        console.error('[Proxy] Invalid HTTP_PROXY format. Expected: http://user:pass@host:port or http://host:port');
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
        console.log('[Proxy] SOCKS proxy detected, skipping HTTP validation.');
        return true;
    }

    console.log('[Proxy] Validating proxy connection...');
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
        console.log('[Proxy] Connection successful!');
        return true;
    } catch (error) {
        console.error('[Proxy] Connection failed: ' + error.message);
        return false;
    }
}

// 辅助函数：检测端口是否开放
function checkPort(port) {
    return new Promise((resolve) => {
        const req = http.get(`http://localhost:${port}/json/version`, (res) => {
            resolve(true);
        });
        req.on('error', () => resolve(false));
        req.end();
    });
}

// --- 续期状态缓存 ---
const STATE_FILE = 'renewal-state.json';

function loadRenewalState() {
    try {
        if (fs.existsSync(STATE_FILE)) {
            return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        }
    } catch (e) { }
    return null;
}

function saveRenewalState(skipUntilISO) {
    try {
        fs.writeFileSync(STATE_FILE, JSON.stringify({
            skipUntil: skipUntilISO,
            updatedAt: new Date().toISOString()
        }));
        console.log(`[Cache] Renewal state saved, skipping until: ${skipUntilISO}`);
    } catch (e) {
        console.error('[Cache] Failed to save state:', e.message);
    }
}

function parseNextDate(dateStr) {
    let d = new Date(dateStr);
    if (!isNaN(d.getTime())) return d;
    d = new Date(dateStr + ' ' + new Date().getFullYear());
    if (!isNaN(d.getTime())) return d;
    return new Date(Date.now() + 24 * 60 * 60 * 1000);
}

// 辅助函数：启动原生 Chrome
async function launchNativeChrome() {
    console.log('Checking if Chrome is already running on port ' + DEBUG_PORT + '...');
    if (await checkPort(DEBUG_PORT)) {
        console.log('Chrome is already open.');
        return;
    }

    console.log('Launching native Chrome...');
    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        `--user-data-dir=${USER_DATA_DIR}`,
        '--no-first-run',
        '--no-default-browser-check',
    ];

    if (PROXY_CONFIG) {
        // Chrome 命令行只接受 server 地址，认证需要在 playright 层或者插件层处理
        // 这里我们要 strip 掉 username:password
        args.push(`--proxy-server=${PROXY_CONFIG.server}`);
        // 确保 Chrome 自身请求 localhost (如 CDP) 不走代理
        args.push('--proxy-bypass-list=<-loopback>');
    }

    if (HEADLESS) {
        args.push('--headless=new');
    }

    const chrome = spawn(CHROME_PATH, args, {
        detached: true,
        stdio: 'ignore'
    });
    chrome.unref();

    console.log('Waiting for Chrome to initialize...');
    for (let i = 0; i < 20; i++) {
        if (await checkPort(DEBUG_PORT)) break;
        await new Promise(r => setTimeout(r, 1000));
    }

    if (!await checkPort(DEBUG_PORT)) {
        console.error('Chrome failed to start on port ' + DEBUG_PORT);
        if (!checkPort(DEBUG_PORT)) {
            try { chrome.kill(); } catch (e) { }
        }
        throw new Error('Chrome launch failed');
    }
}

// 从 login.json 读取用户列表
function getUsers() {
    try {
        const data = fs.readFileSync(path.join(__dirname, 'login.json'), 'utf8');
        const json = JSON.parse(data);
        return Array.isArray(json) ? json : (json.users || []);
    } catch (e) {
        console.error('Error reading login.json:', e);
        return [];
    }
}

// attemptTurnstileCdp moved to turnstile/turnstile.js

(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.log('No users found in login.json');
        return;
    }

    // 检查代理有效性
    if (PROXY_CONFIG) {
        const isValid = await checkProxy();
        if (!isValid) {
            console.error('[Proxy] Aborting due to invalid proxy.');
            process.exit(1);
        }
    }

    // 检查续期缓存
    const state = loadRenewalState();
    if (state && state.skipUntil) {
        const skipDate = new Date(state.skipUntil);
        if (skipDate > new Date()) {
            console.log(`[Cache] Next available from last check: ${state.skipUntil}, skipping this run.`);
            process.exit(0);
        }
    }

    await launchNativeChrome();

    console.log(`Connecting to Chrome instance...`);
    let browser;
    for (let k = 0; k < 5; k++) {
        try {
            browser = await chromium.connectOverCDP(`http://localhost:${DEBUG_PORT}`);
            console.log('Successfully connected!');
            break;
        } catch (e) {
            console.log(`Connection attempt ${k + 1} failed. Retrying in 2s...`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    if (!browser) {
        console.error('Failed to connect. Exiting.');
        return;
    }

    const context = browser.contexts()[0];
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.setDefaultTimeout(60000);

    // --- 代理认证处理 ---
    if (PROXY_CONFIG && PROXY_CONFIG.username) {
        console.log('[Proxy] Setting up authentication...');
        await context.setHTTPCredentials({
            username: PROXY_CONFIG.username,
            password: PROXY_CONFIG.password
        });
    } else {
        // 如果没有代理(或者代理无认证)，清除之前的认证信息，防止干扰
        await context.setHTTPCredentials(null);
    }

    // --- 关键：注入 Hook 脚本 ---
    // 这会在每次页面加载/导航前执行，确保能拦截到 Turnstile 的创建
    await page.addInitScript(INJECTED_SCRIPT);
    console.log('Injection script added to page context.');

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        console.log(`\n=== Processing User ${i + 1}/${users.length}: ${user.username} ===`);

        try {
            if (page.isClosed()) {
                page = await context.newPage();
                // Context credentials should persist, no need to re-auth per page
                await page.addInitScript(INJECTED_SCRIPT); // 新页面也要注入
            }

            // 登录逻辑保持不变...
            console.log('Checking session state...');
            if (page.url().includes('/auth/login')) {
                // Already on login logic
            } else if (page.url().includes('dashboard')) {
                await page.goto('https://dashboard.katabump.com/auth/logout');
                await page.waitForTimeout(2000);
            } else {
                await page.goto('https://dashboard.katabump.com/auth/login');
                await page.waitForTimeout(2000);
                if (page.url().includes('dashboard')) {
                    await page.goto('https://dashboard.katabump.com/auth/logout');
                    await page.waitForTimeout(2000);
                    await page.goto('https://dashboard.katabump.com/auth/login');
                }
            }

            console.log('Filling credentials...');
            try {
                const emailInput = page.getByRole('textbox', { name: 'Email' });
                await emailInput.waitFor({ state: 'visible', timeout: 5000 });
                await emailInput.fill(user.username);
                const pwdInput = page.getByRole('textbox', { name: 'Password' });
                await pwdInput.fill(user.password);
                await page.waitForTimeout(500);

                // --- Cloudflare Turnstile Bypass for Login ---
                console.log('   >> Checking for Turnstile before login (using CDP bypass)...');
                const loginTurnstile = await bypassTurnstile(page, {
                    findAttempts: 15,
                    successTimeoutMs: 10000,
                    label: 'Login'
                });
                if (loginTurnstile.clicked) {
                    console.log('   >> Turnstile clicked for login.');
                    if (loginTurnstile.success) {
                        console.log('   >> Turnstile verification successful before login.');
                    }
                } else {
                    console.log('   >> No Turnstile detected or clicked before login, proceeding anyway...');
                }
                // --------------------------------------------

                await page.getByRole('button', { name: 'Login', exact: true }).click();

                // User Request: Check for "Incorrect password or no account"
                try {
                    const errorMsg = page.getByText('Incorrect password or no account');
                    if (await errorMsg.isVisible({ timeout: 3000 })) {
                        console.error(`   >> ❌ Login failed: Incorrect password or no account for user ${user.username}`);

                        // Screenshot for login failure
                        const photoDir = path.join(__dirname, 'photo');
                        if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
                        try { await page.screenshot({ path: path.join(photoDir, `${user.username}.png`), fullPage: true }); } catch (e) { }

                        // Skip to next user
                        continue;
                    }
                } catch (e) { }

            } catch (e) {
                // 可能已经登录了，或者是其他 UI 状态
                console.log('Login form interaction error (maybe already logged in?):', e.message);
            }

            console.log('Waiting for "See" link...');
            try {
                await page.getByRole('link', { name: 'See' }).first().waitFor({ timeout: 15000 });
                await page.waitForTimeout(1000);
                await page.getByRole('link', { name: 'See' }).first().click();
            } catch (e) {
                console.log('Could not find "See" button. Checking if already on detail page or login failed.');
                if (page.url().includes('login')) {
                    console.error('Login failed for user ' + user.username);
                    continue;
                }
            }

            let renewSuccess = false;
            // 2. 一个扁平化的主循环：尝试 Renew 整个流程 (最多 20 次)
            for (let attempt = 1; attempt <= 20; attempt++) {
                let hasCaptchaError = false;

                // 1. 如果是重试 (attempt > 1)，说明之前失败了或者刚刷新完页面
                // 我们直接开始寻找 Renew 按钮
                console.log(`\n[Attempt ${attempt}/20] Looking for Renew button...`);

                const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();
                try {
                    // 稍微等待一下，防止页面刚刷新还没渲染出来
                    await renewBtn.waitFor({ state: 'visible', timeout: 5000 });
                } catch (e) { }

                if (await renewBtn.isVisible()) {
                    await renewBtn.click();
                    console.log('Renew button clicked. Waiting for modal...');

                    const modal = page.locator('#renew-modal');
                    try { await modal.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) {
                        console.log('Modal did not appear? Retrying...');
                        continue;
                    }

                    // A. 在模态框里晃晃鼠标
                    try {
                        const box = await modal.boundingBox();
                        if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
                    } catch (e) { }

                    // B. 找 Turnstile (小重试)
                    console.log('Checking for Turnstile (using CDP bypass)...');
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

                        // User Requested: Screenshot BEFORE final click (Regardless of CDP status)
                        const photoDir = path.join(__dirname, 'photo');
                        if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
                        const tsScreenshotName = `${user.username}_Turnstile_${attempt}.png`;
                        try {
                            await page.screenshot({ path: path.join(photoDir, tsScreenshotName), fullPage: true });
                            console.log(`   >> 📸 Snapshot saved: ${tsScreenshotName}`);
                        } catch (e) {
                            console.log('   >> Failed to take Turnstile snapshot:', e.message);
                        }

                        // User Request: 找不到的话这个循环直接下一步点击renew，然后检测有没有Please complete the captcha to continue
                        console.log('   >> Clicking Renew confirm button (regardless of Turnstile status)...');
                        await confirmBtn.click();

                        try {
                            // 1. Check for "Please complete the captcha" error
                            const startVerifyTime = Date.now();
                            while (Date.now() - startVerifyTime < 3000) {
                                // A. Captcha Error
                                if (await page.getByText('Please complete the captcha to continue').isVisible()) {
                                    console.log('   >> ⚠️ Error detected: "Please complete the captcha".');
                                    hasCaptchaError = true;
                                    break;
                                }

                                // B. Not Renew Time Error
                                // content: "You can't renew your server yet. You will be able to as of 02 February (in 3 day(s))."
                                const notTimeLoc = page.getByText("You can't renew your server yet");
                                if (await notTimeLoc.isVisible()) {
                                    const text = await notTimeLoc.innerText();
                                    const match = text.match(/as of\s+(.*?)\s+\(/);
                                    let dateStr = match ? match[1] : 'Unknown Date';
                                    console.log(`   >> ⏳ Cannot renew yet. Next renewal available as of: ${dateStr}`);

                                    // 保存下次可用时间到缓存
                                    if (dateStr !== 'Unknown Date') {
                                        const nextDate = parseNextDate(dateStr);
                                        saveRenewalState(nextDate.toISOString());
                                    }

                                    // Treat this as a "successful" run so we don't retry loop
                                    renewSuccess = true;
                                    // Manually close modal
                                    try {
                                        const closeBtn = modal.getByLabel('Close');
                                        if (await closeBtn.isVisible()) await closeBtn.click();
                                    } catch (e) { }
                                    break; // Break loop
                                }

                                await page.waitForTimeout(200);
                            }
                        } catch (e) { }

                        if (renewSuccess) break; // 如果是因为还没到时间，直接跳出大循环

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
                            // 续期成功: 4 天后再检查
                            const nextRenew = new Date(Date.now() + 4 * 24 * 60 * 60 * 1000);
                            saveRenewalState(nextRenew.toISOString());
                            renewSuccess = true;
                            // 成功了！退出循环
                            break;
                        } else {
                            console.log('   >> Modal still open but no error? Weird. Retrying loop...');
                            // 可以选择 continue 或只是重试下一次循环，这里我们选择刷新重来，确保稳健
                            await page.reload();
                            await page.waitForTimeout(3000);
                            continue;
                        }
                    } else {
                        console.log('   >> Verify button inside modal not found? Refreshing...');
                        await page.reload();
                        await page.waitForTimeout(3000);
                        continue;
                    }

                } else {
                    console.log('Renew button not found (Server might be already renewed or page load error).');
                    // 如果是还没加载出来，那我们可能不需要 break，而是重试几次?
                    // 但这里为了简化逻辑，如果经过 waitFor 5s 还不是 visible，我们假设已经续期了或者不在列表里
                    // 但考虑到用户想要的是 retry，如果真的没找到，也许我们应该 break
                    break;
                }
            }

        } catch (err) {
            console.error(`Error processing user ${user.username}:`, err);
        }

        // Snapshot before handling next user (Normal end of loop)
        const photoDir = path.join(__dirname, 'photo');
        if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
        const screenshotPath = path.join(photoDir, `${user.username}.png`);
        try {
            await page.screenshot({ path: screenshotPath, fullPage: true });
            console.log(`Saved screenshot to: ${screenshotPath}`);
        } catch (e) {
            console.log('Failed to take screenshot:', e.message);
        }

        console.log(`Finished User ${user.username}\n`);
    }

    console.log('All users processed.');
    console.log('Closing browser connection.');
    await browser.close();
})();
