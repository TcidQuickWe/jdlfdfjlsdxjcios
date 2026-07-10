/**
 * Captcha bypass module
 *
 * Two strategies:
 * 1. Turnstile (Cloudflare, cross-origin iframe, Shadow DOM):
 *    Injected script hooks Element.prototype.attachShadow to capture
 *    checkbox position → CDP native click.
 * 2. ALTCHA (same-origin, regular DOM):
 *    Direct frame.evaluate() to find checkbox → JS .click().
 */

const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;

    try {
        function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
        Object.defineProperty(MouseEvent.prototype, 'screenX', { value: rand(800, 1200) });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { value: rand(400, 600) });
    } catch (e) { }

    try {
        var orig = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function(init) {
            var root = orig.call(this, init);
            if (root) {
                var scan = function() {
                    var cb = root.querySelector('input[type="checkbox"]');
                    if (cb) {
                        var r = cb.getBoundingClientRect();
                        if (r.width > 0 && r.height > 0) {
                            window.__turnstile_data = {
                                x: r.left + r.width / 2,
                                y: r.top + r.height / 2,
                                isTop: false
                            };
                            return true;
                        }
                    }
                    return false;
                };
                if (!scan()) {
                    var mo = new MutationObserver(function() {
                        if (scan()) mo.disconnect();
                    });
                    mo.observe(root, { childList: true, subtree: true });
                }
            }
            return root;
        };
    } catch (e) { }
})();
`;

/**
 * Iterate all frames looking for captcha checkbox and click it.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>} true if a click was dispatched
 */
async function attemptTurnstileCdp(page) {
    const frames = page.frames();
    for (const frame of frames) {
        // --- Path 1: Turnstile in cross-origin iframe (via injected __turnstile_data) ---
        try {
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);
            if (data && !data.isTop) {
                const iframeElement = await frame.frameElement();
                if (!iframeElement) continue;
                const box = await iframeElement.boundingBox();
                if (!box) continue;
                var cx = box.x + data.x;
                var cy = box.y + data.y;
                const client = await page.context().newCDPSession(page);
                await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
                await new Promise(r => setTimeout(r, 50 + Math.random() * 100));
                await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
                await client.detach();
                console.log('   >> [Turnstile] CDP click sent.');
                return true;
            }
        } catch (e) { }

        // --- Path 2: ALTCHA in top frame (direct JS click, no injection needed) ---
        try {
            const clicked = await frame.evaluate(() => {
                var cb = document.querySelector(
                    '.altcha-checkbox input[type="checkbox"], ' +
                    'altcha-widget input[type="checkbox"], ' +
                    'input[type="checkbox"][id^="altcha_checkbox_"]'
                );
                if (cb && cb.offsetParent !== null) {
                    cb.click();
                    return true;
                }
                return false;
            });
            if (clicked) {
                console.log('   >> [ALTCHA] JS click sent.');
                return true;
            }
        } catch (e) { }
    }
    return false;
}

/**
 * Check if captcha verification succeeded.
 * Looks for: Success! text, cf-turnstile-response token, altcha state.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<boolean>}
 */
async function checkTurnstileSuccess(page) {
    // 1) Token fields on main page
    try {
        const hasToken = await page.evaluate(() => {
            const sels = [
                'input[name="cf-turnstile-response"]',
                'textarea[name="cf-turnstile-response"]',
                'input[name="g-recaptcha-response"]',
                'input[name="h-captcha-response"]',
                '[name="altcha"]',
                'input[name="altcha"]',
            ];
            for (const s of sels) {
                const el = document.querySelector(s);
                if (el && el.value && String(el.value).length > 20) return true;
            }
            const w = document.querySelector('[data-turnstile-response], .cf-turnstile[data-response]');
            if (w) {
                const v = w.getAttribute('data-turnstile-response') || w.getAttribute('data-response') || '';
                if (v.length > 20) return true;
            }
            return false;
        });
        if (hasToken) return true;
    } catch (e) { }

    // 2) Success text in cloudflare iframes
    const frames = page.frames();
    for (const f of frames) {
        const url = f.url() || '';
        if (url.includes('cloudflare') || url.includes('challenges.cloudflare') || url.includes('turnstile')) {
            try {
                if (await f.getByText('Success!', { exact: false }).isVisible({ timeout: 400 })) {
                    return true;
                }
            } catch (e) { }
            try {
                const ok = await f.evaluate(() => {
                    const t = (document.body && document.body.innerText) || '';
                    return /success/i.test(t);
                });
                if (ok) return true;
            } catch (e) { }
        }
    }

    // 3) ALTCHA verified state
    try {
        const altchaOk = await page.evaluate(() => {
            const w = document.querySelector('altcha-widget, .altcha');
            if (!w) return false;
            if (w.getAttribute('data-state') === 'verified') return true;
            if (w.classList && w.classList.contains('altcha--verified')) return true;
            const cb = document.querySelector('.altcha-checkbox input[type="checkbox"]');
            return !!(cb && cb.checked);
        });
        if (altchaOk) return true;
    } catch (e) { }

    return false;
}

/**
 * High-level captcha bypass flow:
 * 1. Poll for the checkbox up to `findAttempts` times.
 * 2. If found and clicked, optionally wait for verification.
 * 3. If no success signal, try one more click.
 *
 * @param {import('playwright').Page} page
 * @param {object} [options]
 * @param {number}  [options.findAttempts=15]
 * @param {number}  [options.waitAfterClickMs=8000]
 * @param {boolean} [options.waitForSuccess=true]
 * @param {number}  [options.successTimeoutMs=10000]
 * @param {string}  [options.label='']
 * @returns {Promise<{clicked: boolean, success: boolean}>}
 */
async function bypassTurnstile(page, options = {}) {
    const {
        findAttempts = 15,
        waitAfterClickMs = 8000,
        waitForSuccess = true,
        successTimeoutMs = 15000,
        label = ''
    } = options;

    const tag = label ? `[${label}] ` : '';

    // Already solved?
    if (await checkTurnstileSuccess(page)) {
        console.log(`   >> ${tag}Captcha already verified.`);
        return { clicked: false, success: true };
    }

    let clicked = false;
    for (let i = 0; i < findAttempts; i++) {
        clicked = await attemptTurnstileCdp(page);
        if (clicked) {
            console.log(`   >> ${tag}Click on attempt ${i + 1}/${findAttempts}.`);
            break;
        }
        console.log(`   >> ${tag}Attempt ${i + 1}/${findAttempts}: not found...`);
        await new Promise(r => setTimeout(r, 1000));
    }

    if (!clicked) {
        if (await checkTurnstileSuccess(page)) {
            console.log(`   >> ${tag}No click needed, token present.`);
            return { clicked: false, success: true };
        }
        console.log(`   >> ${tag}Not found after ${findAttempts} attempts.`);
        return { clicked: false, success: false };
    }

    let success = false;
    if (waitForSuccess) {
        const deadline = Date.now() + successTimeoutMs;
        while (Date.now() < deadline) {
            if (await checkTurnstileSuccess(page)) {
                success = true;
                console.log(`   >> ${tag}Verification passed.`);
                break;
            }
            await new Promise(r => setTimeout(r, 1000));
        }
        // One more click if still not verified
        if (!success) {
            console.log(`   >> ${tag}No signal, retrying captcha click...`);
            try {
                for (const frame of page.frames()) {
                    await frame.evaluate(() => { try { delete window.__turnstile_data; } catch (e) {} }).catch(() => {});
                }
            } catch (e) { }
            await new Promise(r => setTimeout(r, 1500));
            const reclicked = await attemptTurnstileCdp(page);
            if (reclicked) {
                const deadline2 = Date.now() + Math.min(successTimeoutMs, 12000);
                while (Date.now() < deadline2) {
                    if (await checkTurnstileSuccess(page)) {
                        success = true;
                        console.log(`   >> ${tag}Verification passed after reclick.`);
                        break;
                    }
                    await new Promise(r => setTimeout(r, 1000));
                }
            }
        }
        if (!success) {
            console.log(`   >> ${tag}No verification signal within ${successTimeoutMs}ms.`);
        }
    } else {
        await new Promise(r => setTimeout(r, waitAfterClickMs));
    }

    return { clicked, success };
}

module.exports = {
    INJECTED_SCRIPT,
    attemptTurnstileCdp,
    checkTurnstileSuccess,
    bypassTurnstile
};
