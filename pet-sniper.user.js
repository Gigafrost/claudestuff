// ==UserScript==
// @name         Tagged.com Pet Sniper (Safe Mode)
// @namespace    http://tampermonkey.net/
// @version      3.1
// @description  Auto-buys pets (old first, then new). Activity log UI with session counter, batch progress bar, and live cooldown timer. 1% Financial Rule. Persistent state.
// @author       Gemini
// @match        *://*.tagged.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // --- Configuration ---
    const CONFIG = {
        minDelay: 2420,
        maxDelay: 5700,

        batchSizeMin: 10,
        batchSizeMax: 12,

        batchCooldownMin: 15000,
        batchCooldownMax: 20000,

        safePriceRegex: /Less than \$0\.01/i,

        patterns: {
            buyNow: /Buy now/i,
            getNewPrice: /Get New Price/i,
            buyBack: /Buy back/i,
            buyAgain: /Buy again/i,
            buyNew: /^Buy!$/i,
            buyGoldMsg: /Buy Gold to increase your cash/i,
            refreshErrorMsg: /An error occur+ed.*?refresh/i
        },
        selectors: {
            potentialButtons: [
                'input[type="button"]:not(.id-button-lockpet)',
                'button:not(.id-button-lockpet)',
                '.btn:not(.id-button-lockpet)',
                '.greenBtn:not(.id-button-lockpet)',
                '.greenBtnBig',
                '.green_btn_big',
                '.id-button-buy',
                '.id-button-yes',
                '.id-button-new-price',
                '.btn-buy'
            ].join(', '),
            ignoreBtn: '.id-button-ignore, .btn-ignore',
            closeBtns: '.lock-pet-close, .buy-pet-complete .id-button-continue, .tag-link-close, .id-button-close'
        },
        debug: true,
        maxLogEntries: 20
    };

    // --- State Variables (with Persistence) ---
    let isRunning = false;
    let isProcessing = false;
    let scanInterval = null;
    let pendingIgnoreBtn = null;

    let consecutivePurchases = parseInt(sessionStorage.getItem('petBot_count')) || 0;
    let currentBatchLimit = parseInt(sessionStorage.getItem('petBot_limit')) || 10;
    let totalSessionPurchases = parseInt(sessionStorage.getItem('petBot_total')) || 0;

    // Cooldown timer state
    let cooldownTimerId = null;
    let cooldownEndTime = 0;

    // Activity log
    let activityLog = JSON.parse(sessionStorage.getItem('petBot_log') || '[]');

    // --- GUI Management ---
    function createControls() {
        if (window.top !== window.self) return;
        if (document.getElementById('petbot-controls')) return;

        const div = document.createElement('div');
        div.id = 'petbot-controls';
        Object.assign(div.style, {
            position: 'fixed', top: '15px', right: '15px', zIndex: '2147483647',
            backgroundColor: '#111', color: '#fff', padding: '0',
            borderRadius: '10px', fontFamily: "'Segoe UI', Arial, sans-serif",
            boxShadow: '0 4px 24px rgba(0,0,0,0.7)', width: '260px',
            border: '1px solid #333', overflow: 'hidden'
        });

        div.innerHTML = `
            <div style="background:#1a1a1a; padding:10px 14px; border-bottom:1px solid #333; display:flex; justify-content:space-between; align-items:center;">
                <span style="font-weight:bold; color:#4caf50; font-size:13px;">Pet Sniper v3.1</span>
                <span id="petbot-state" style="font-size:11px; padding:2px 8px; border-radius:10px; font-weight:bold; background:#333; color:#888;">STOPPED</span>
            </div>

            <div style="padding:10px 14px 6px;">
                <div style="display:flex; justify-content:space-between; align-items:baseline; margin-bottom:6px;">
                    <span style="font-size:11px; color:#888;">Session Purchases</span>
                    <span id="petbot-total" style="font-size:18px; font-weight:bold; color:#4caf50;">0</span>
                </div>

                <div style="margin-bottom:8px;">
                    <div style="display:flex; justify-content:space-between; font-size:10px; color:#666; margin-bottom:3px;">
                        <span>Batch Progress</span>
                        <span id="petbot-batch-text">0 / 10</span>
                    </div>
                    <div style="background:#222; border-radius:4px; height:8px; overflow:hidden;">
                        <div id="petbot-batch-bar" style="background:linear-gradient(90deg,#4caf50,#81c784); height:100%; width:0%; border-radius:4px; transition:width 0.3s ease;"></div>
                    </div>
                </div>

                <div id="petbot-cooldown-wrap" style="display:none; margin-bottom:8px; padding:6px 8px; background:#0d253d; border:1px solid #1a4a7a; border-radius:6px;">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <span style="font-size:11px; color:#5dade2;">Cooldown</span>
                        <span id="petbot-cooldown-time" style="font-size:14px; font-weight:bold; color:#5dade2; font-family:monospace;">--</span>
                    </div>
                    <div style="background:#1a3a5c; border-radius:3px; height:4px; overflow:hidden; margin-top:4px;">
                        <div id="petbot-cooldown-bar" style="background:#3498db; height:100%; width:100%; border-radius:3px; transition:width 0.5s linear;"></div>
                    </div>
                </div>
            </div>

            <div style="padding:0 14px;">
                <div style="font-size:10px; color:#555; text-transform:uppercase; letter-spacing:1px; margin-bottom:4px;">Activity Log</div>
                <div id="petbot-log" style="max-height:160px; overflow-y:auto; background:#0a0a0a; border-radius:6px; padding:4px 0; font-family:'Consolas','Courier New',monospace; font-size:11px; border:1px solid #222;"></div>
            </div>

            <div style="padding:10px 14px;">
                <button id="petbot-start" style="width:100%; padding:8px; background:#28a745; color:white; border:none; border-radius:6px; font-weight:bold; cursor:pointer; font-size:12px;">START (Alt+S)</button>
                <button id="petbot-stop" style="width:100%; padding:8px; background:#d32f2f; color:white; border:none; border-radius:6px; font-weight:bold; cursor:pointer; font-size:12px; display:none;">STOP (Esc)</button>
            </div>
        `;

        document.body.appendChild(div);
        document.getElementById('petbot-start').onclick = () => triggerStart(true);
        document.getElementById('petbot-stop').onclick = () => triggerStop(true);

        // Render persisted state
        updateStats();
        renderLog();
    }

    // --- Activity Log ---
    function logActivity(text, color = '#aaa') {
        const now = new Date();
        const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        activityLog.push({ time, text, color });
        if (activityLog.length > CONFIG.maxLogEntries) {
            activityLog = activityLog.slice(-CONFIG.maxLogEntries);
        }
        // Persist log
        try { sessionStorage.setItem('petBot_log', JSON.stringify(activityLog)); } catch(e) {}
        renderLog();
        if (CONFIG.debug) console.log(`[PetBot] ${text}`);
    }

    function renderLog() {
        const el = document.getElementById('petbot-log');
        if (!el) return;
        el.innerHTML = activityLog.map(entry =>
            `<div style="color:${entry.color}; padding:2px 8px; border-bottom:1px solid #151515; line-height:1.4;">` +
            `<span style="color:#444; margin-right:6px;">${entry.time}</span>${entry.text}</div>`
        ).join('');
        el.scrollTop = el.scrollHeight;
    }

    // --- Stats & Cooldown Display ---
    function updateStats() {
        sessionStorage.setItem('petBot_count', consecutivePurchases);
        sessionStorage.setItem('petBot_limit', currentBatchLimit);
        sessionStorage.setItem('petBot_total', totalSessionPurchases);

        const totalEl = document.getElementById('petbot-total');
        if (totalEl) totalEl.innerText = totalSessionPurchases;

        const batchText = document.getElementById('petbot-batch-text');
        if (batchText) batchText.innerText = `${consecutivePurchases} / ${currentBatchLimit}`;

        const batchBar = document.getElementById('petbot-batch-bar');
        if (batchBar) {
            const pct = currentBatchLimit > 0 ? Math.min(100, (consecutivePurchases / currentBatchLimit) * 100) : 0;
            batchBar.style.width = pct + '%';
            // Color shift as batch fills up
            if (pct >= 80) batchBar.style.background = 'linear-gradient(90deg,#ff9800,#ffb74d)';
            else batchBar.style.background = 'linear-gradient(90deg,#4caf50,#81c784)';
        }
    }

    function setStateIndicator(text, bgColor, textColor) {
        const el = document.getElementById('petbot-state');
        if (el) {
            el.innerText = text;
            el.style.background = bgColor;
            el.style.color = textColor;
        }
    }

    let cooldownDuration = 0;

    function startCooldownTimer(durationMs) {
        cooldownEndTime = Date.now() + durationMs;
        cooldownDuration = durationMs;
        clearInterval(cooldownTimerId);

        const wrap = document.getElementById('petbot-cooldown-wrap');
        if (wrap) wrap.style.display = 'block';

        setStateIndicator('COOLDOWN', '#0d253d', '#5dade2');

        cooldownTimerId = setInterval(() => {
            const remaining = Math.max(0, cooldownEndTime - Date.now());
            if (remaining <= 0) {
                clearInterval(cooldownTimerId);
                cooldownTimerId = null;
                const w = document.getElementById('petbot-cooldown-wrap');
                if (w) w.style.display = 'none';
                return;
            }
            const secs = Math.ceil(remaining / 1000);
            const timeEl = document.getElementById('petbot-cooldown-time');
            if (timeEl) timeEl.innerText = secs + 's';

            const bar = document.getElementById('petbot-cooldown-bar');
            if (bar && cooldownDuration > 0) {
                bar.style.width = ((remaining / cooldownDuration) * 100) + '%';
            }
        }, 500);
    }

    function stopCooldownTimer() {
        clearInterval(cooldownTimerId);
        cooldownTimerId = null;
        const wrap = document.getElementById('petbot-cooldown-wrap');
        if (wrap) wrap.style.display = 'none';
    }

    function toggleGui(running) {
        const start = document.getElementById('petbot-start');
        const stop = document.getElementById('petbot-stop');
        if (start && stop) {
            start.style.display = running ? 'none' : 'block';
            stop.style.display = running ? 'block' : 'none';
        }
        if (running) {
            setStateIndicator('RUNNING', '#1b3a1b', '#4caf50');
        } else {
            setStateIndicator('STOPPED', '#333', '#888');
            stopCooldownTimer();
        }
        if (running) updateStats();
    }

    // --- Communication & Helpers ---
    function triggerStart(fromGui = false) {
        if (fromGui) { startBot(); broadcastCommand('START'); } else { startBot(); }
    }
    function triggerStop(fromGui = false) {
        if (fromGui) { stopBot(); broadcastCommand('STOP'); } else { stopBot(); }
    }
    function broadcastCommand(action) {
        const frames = window.frames;
        for (let i = 0; i < frames.length; i++) {
            try { frames[i].postMessage({ type: 'PETBOT_CMD', action: action }, '*'); } catch(e) { }
        }
    }
    window.addEventListener('message', (event) => {
        if (event.data && event.data.type === 'PETBOT_CMD') {
            if (event.data.action === 'START') startBot();
            if (event.data.action === 'STOP') stopBot();
        }
    });

    function isVisible(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && (el.offsetWidth > 0 || el.offsetHeight > 0);
    }

    function findIgnoreButton(startNode) {
        let parent = startNode.parentElement;
        for (let i = 0; i < 4; i++) {
            if (!parent) return null;
            const btn = parent.querySelector(CONFIG.selectors.ignoreBtn);
            if (btn) return btn;
            parent = parent.parentElement;
        }
        return null;
    }

    function safeClick(element) {
        if (!element) return;
        try { element.scrollIntoView({block: "center", inline: "center"}); } catch(e){}

        const eventTypes = ['mouseover', 'mousedown', 'mouseup', 'click', 'pointerdown', 'pointerup'];
        eventTypes.forEach(type => {
            try {
                const event = new MouseEvent(type, { view: window, bubbles: true, cancelable: true, buttons: 1 });
                element.dispatchEvent(event);
            } catch (e) {}
        });

        setTimeout(() => {
            try { HTMLElement.prototype.click.call(element); } catch (e) {}
        }, 50);
    }

    function parseBigCash(container, selector) {
        const el = container.querySelector(selector);
        if (!el) return null;
        const titleSpan = el.querySelector('span[title]');
        const raw = titleSpan ? titleSpan.getAttribute('title') : el.innerText;
        const clean = raw.replace(/[^\d]/g, '');
        try { return clean ? BigInt(clean) : null; } catch(e) { return null; }
    }

    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const randomDelay = (min = CONFIG.minDelay, max = CONFIG.maxDelay) => Math.floor(Math.random() * (max - min + 1) + min);

    // --- Helper: Close any visible modal ---
    function closeAnyModal() {
        const btns = document.querySelectorAll(CONFIG.selectors.closeBtns);
        const closeBtn = Array.from(btns).find(isVisible);
        if (closeBtn) {
            safeClick(closeBtn);
            return true;
        }
        return false;
    }

    // --- Helper: Ghost Pet Detector ---
    function isGhostPet(btn) {
        if (btn.closest('.ghost-pet')) return true;
        const row = btn.closest('.pet-list-row') || btn.closest('.pet-list-cell');
        if (row) {
            if (row.innerText && row.innerText.includes("Ghost Pet")) return true;
            const imgs = row.querySelectorAll('img');
            for (let img of imgs) {
                if (img.alt && img.alt.includes("Ghost Pet")) return true;
            }
        }
        return false;
    }

    // --- Helper: New Pet Safety Check ---
    function isNewPetSafe(btn) {
        let container = btn.closest('.buy-three-friends')
            || btn.closest('[class*="id-friends-pet"]')
            || btn.closest('.pet-list-row');

        if (!container) {
            container = btn.parentElement;
            for (let i = 0; i < 6 && container; i++) {
                if (container.querySelector('.id-value')) break;
                container = container.parentElement;
            }
        }

        if (!container) return false;

        const valueEl = container.querySelector('.id-value');
        if (!valueEl) return false;

        const isSafe = CONFIG.safePriceRegex.test(valueEl.innerText);
        if (CONFIG.debug) console.log(`[PetBot] New pet value check: "${valueEl.innerText.trim()}" => safe=${isSafe}`);
        return isSafe;
    }

    // --- Helper: Free Pet Check ---
    function isFreePet(modal) {
        if (!modal) return false;
        const costEl = modal.querySelector('.confirm-list .cash-neg');
        if (costEl && isVisible(costEl)) {
            const isFree = CONFIG.safePriceRegex.test(costEl.innerText);
            if(CONFIG.debug && isFree) console.log("[PetBot] Free pet detected.");
            return isFree;
        }
        return false;
    }

    // --- Helper: Text Detection ---
    function hasText(regex) {
        const overlay = document.querySelector('.tag-overlay-body');
        if (overlay && isVisible(overlay) && regex.test(overlay.innerText)) return true;

        const elementsToCheck = [
            '.tag-message-content',
            '.confirm-cash-purchase',
            '.error-message',
            '.tag-alert'
        ];

        for (let selector of elementsToCheck) {
            const els = document.querySelectorAll(selector);
            for (let el of els) {
                if (isVisible(el) && regex.test(el.innerText)) return true;
            }
        }
        return false;
    }

    // --- Post-Purchase Handler ---
    // Called after clicking "Buy Now" (validated). Counts the purchase,
    // closes modals, and handles batch cooldown/delay.
    async function handlePostPurchase(type) {
        isProcessing = true;

        // Wait for the site to process the purchase
        await sleep(1500);

        // Check if an error appeared instead of success
        if (hasText(CONFIG.patterns.buyGoldMsg) || hasText(CONFIG.patterns.refreshErrorMsg)) {
            logActivity('Purchase failed (error detected)', '#ff5252');
            closeAnyModal();
            await sleep(500);
            isProcessing = false;
            return;
        }

        // No error — count as purchased
        consecutivePurchases++;
        totalSessionPurchases++;
        logActivity(`Bought pet #${totalSessionPurchases} (${type})`, '#4caf50');
        updateStats();

        // Try to close success modal
        closeAnyModal();

        // Batch logic
        if (consecutivePurchases >= currentBatchLimit) {
            const batchWait = randomDelay(CONFIG.batchCooldownMin, CONFIG.batchCooldownMax);
            logActivity(`Batch of ${currentBatchLimit} done! Cooling down ${Math.round(batchWait/1000)}s`, '#3498db');

            startCooldownTimer(batchWait);

            consecutivePurchases = 0;
            currentBatchLimit = randomDelay(CONFIG.batchSizeMin, CONFIG.batchSizeMax);
            updateStats();

            await sleep(batchWait);
            stopCooldownTimer();
            setStateIndicator('RUNNING', '#1b3a1b', '#4caf50');
            logActivity('Cooldown over, resuming...', '#4caf50');
        } else {
            const wait = randomDelay();
            logActivity(`Waiting ${(wait/1000).toFixed(1)}s...`, '#666');
            await sleep(wait);
        }

        isProcessing = false;
    }

    // --- Core Logic ---

    async function scanRoutine() {
        if (!isRunning || isProcessing) return;

        // 1. Error Handling
        if (hasText(CONFIG.patterns.refreshErrorMsg)) {
            logActivity('Error detected! Refreshing page...', '#ff5252');
            isProcessing = true;
            await sleep(2000);
            location.reload();
            return;
        }

        // 2. Unaffordable
        if (hasText(CONFIG.patterns.buyGoldMsg)) {
            handleExpensivePet("Buy Gold Msg");
            return;
        }

        // 3. Close stale success modals (don't count — just clear them)
        const successModal = document.querySelector('.buy-pet-complete');
        if (successModal && isVisible(successModal)) {
            closeAnyModal();
            isProcessing = true;
            setTimeout(() => isProcessing = false, 800);
            return;
        }
        const confirmBox = document.querySelector('.id-container-confirm');
        if (confirmBox && isVisible(confirmBox) && confirmBox.innerText.includes("Purchase Complete")) {
            closeAnyModal();
            isProcessing = true;
            setTimeout(() => isProcessing = false, 800);
            return;
        }

        // 4. GATHER BUTTONS
        const allCandidates = Array.from(document.querySelectorAll(CONFIG.selectors.potentialButtons)).filter(isVisible);

        let buyNowBtn = null;
        let newPriceBtn = null;
        let buyBackBtn = null;
        let buyAgainBtn = null;
        let buyNewBtn = null;
        let allBuyBacks = [];

        for (let btn of allCandidates) {
            const val = (btn.value || btn.innerText || "").trim();
            if (CONFIG.patterns.buyNow.test(val)) buyNowBtn = btn;
            else if (CONFIG.patterns.getNewPrice.test(val)) newPriceBtn = btn;
            else if (CONFIG.patterns.buyBack.test(val)) {
                if (!buyBackBtn) buyBackBtn = btn;
                allBuyBacks.push(btn);
            }
            else if (CONFIG.patterns.buyAgain.test(val)) { if (!buyAgainBtn) buyAgainBtn = btn; }
            else if (CONFIG.patterns.buyNew.test(val)) { if (!buyNewBtn) buyNewBtn = btn; }
        }

        // 5. EXECUTION

        // 5a. Handle confirmation modals first (Get New Price / Buy Now)
        if (newPriceBtn && !newPriceBtn.disabled) {
            logActivity('Updating price...', '#ff9800');
            safeClick(newPriceBtn);
            isProcessing = true;
            setTimeout(() => isProcessing = false, 1200);
            return;
        }

        if (buyNowBtn && !buyNowBtn.disabled) {
            const modal = buyNowBtn.closest('.id-container-confirm') || document.querySelector('.id-container-confirm');

            // A. Free?
            if (isFreePet(modal)) {
                logActivity('Confirming purchase (Free)...', '#00e676');
                safeClick(buyNowBtn);
                await handlePostPurchase('Free');
                return;
            }

            // B. Affordable? (1% rule)
            let isAffordable = false;
            if (modal) {
                const startVal = parseBigCash(modal, '.confirm-list li:first-child .confirm-cash');
                const endVal = parseBigCash(modal, '.confirm-list li.ending-cash .confirm-cash');

                if (startVal !== null && endVal !== null) {
                    const threshold = (startVal * 99n) / 100n;
                    if (endVal >= threshold) isAffordable = true;
                    else console.log(`[PetBot] DENIED. Start: ${startVal}, End: ${endVal}`);
                }
            }

            if (isAffordable) {
                logActivity('Confirming purchase (Safe)...', '#00e676');
                safeClick(buyNowBtn);
                await handlePostPurchase('Safe');
                return;
            } else {
                handleExpensivePet("Expensive", allBuyBacks);
                return;
            }
        }

        // 5b. Pet list triggers — OLD PETS FIRST, then new pets

        // "Buy Back" (previously owned pets — PRIORITY)
        if (buyBackBtn && !buyBackBtn.disabled) {
            if (isGhostPet(buyBackBtn)) {
                logActivity('Skipping ghost pet', '#ffa500');
                const ignore = findIgnoreButton(buyBackBtn);
                if (ignore) safeClick(ignore);
                isProcessing = true;
                setTimeout(() => isProcessing = false, 1200);
                return;
            }

            logActivity('Clicking Buy Back...', '#2196f3');
            pendingIgnoreBtn = findIgnoreButton(buyBackBtn);
            safeClick(buyBackBtn);
            isProcessing = true;
            setTimeout(() => isProcessing = false, 1200);
            return;
        }

        // "Buy Again"
        if (buyAgainBtn) {
            logActivity('Clicking Buy Again...', '#2196f3');
            pendingIgnoreBtn = null;
            safeClick(buyAgainBtn);
            isProcessing = true;
            setTimeout(() => isProcessing = false, 1200);
            return;
        }

        // "Buy!" (new pets — only when no Buy Back available)
        if (buyNewBtn && !buyNewBtn.disabled) {
            if (isGhostPet(buyNewBtn)) {
                logActivity('Skipping ghost pet (new)', '#ffa500');
                const ignore = findIgnoreButton(buyNewBtn);
                if (ignore) safeClick(ignore);
                isProcessing = true;
                setTimeout(() => isProcessing = false, 1200);
                return;
            }

            if (isNewPetSafe(buyNewBtn)) {
                logActivity('Clicking Buy! (new pet)...', '#9c27b0');
                pendingIgnoreBtn = findIgnoreButton(buyNewBtn);
                safeClick(buyNewBtn);
                isProcessing = true;
                setTimeout(() => isProcessing = false, 1200);
                return;
            } else {
                logActivity('New pet too expensive, skipping', '#ffa500');
                const ignore = findIgnoreButton(buyNewBtn);
                if (ignore) safeClick(ignore);
                isProcessing = true;
                setTimeout(() => isProcessing = false, 1200);
                return;
            }
        }
    }

    // --- Helper: Escape/Ignore Expensive ---
    async function handleExpensivePet(reason, availableBuyBacks = []) {
        logActivity('Too expensive! Skipping...', '#ff5252');
        isProcessing = true;

        if (!closeAnyModal()) {
            if (availableBuyBacks.length === 0) {
                const allBtns = Array.from(document.querySelectorAll(CONFIG.selectors.potentialButtons));
                availableBuyBacks = allBtns.filter(b => CONFIG.patterns.buyBack.test(b.value || b.innerText));
            }

            if (availableBuyBacks.length > 1 && isVisible(availableBuyBacks[1])) {
                safeClick(availableBuyBacks[1]);

                const nextIgnore = findIgnoreButton(availableBuyBacks[1]);
                const oldIgnore = pendingIgnoreBtn;
                pendingIgnoreBtn = nextIgnore;

                setTimeout(() => {
                    if (oldIgnore) safeClick(oldIgnore);
                }, 800);

                setTimeout(() => isProcessing = false, 1500);
                return;
            }
        }

        await sleep(600);
        if (pendingIgnoreBtn && document.body.contains(pendingIgnoreBtn)) {
            safeClick(pendingIgnoreBtn);
        }
        pendingIgnoreBtn = null;
        isProcessing = false;
    }

    function switchPetBackground() {
        const allBtns = Array.from(document.querySelectorAll(CONFIG.selectors.potentialButtons));
        const backs = allBtns.filter(b => isVisible(b) && CONFIG.patterns.buyBack.test(b.value || b.innerText));
        if (backs.length > 1) safeClick(backs[1]);
    }

    // --- Init ---
    function startBot() {
        if (isRunning) return;
        isRunning = true;
        isProcessing = false;
        pendingIgnoreBtn = null;

        if (currentBatchLimit < 10) currentBatchLimit = randomDelay(CONFIG.batchSizeMin, CONFIG.batchSizeMax);

        toggleGui(true);
        logActivity('Bot started', '#4caf50');
        scanInterval = setInterval(scanRoutine, 250);
    }

    function stopBot() {
        if (!isRunning) return;
        isRunning = false;
        clearInterval(scanInterval);
        stopCooldownTimer();
        toggleGui(false);
        logActivity('Bot stopped', '#888');
    }

    if (document.readyState === 'loading') {
        window.addEventListener('DOMContentLoaded', createControls);
    } else {
        createControls();
    }

    document.addEventListener('keydown', (e) => {
        if (e.altKey && e.key.toLowerCase() === 's') {
            e.preventDefault();
            isRunning ? triggerStop(true) : triggerStart(true);
        }
        if (e.key === 'Escape') triggerStop(true);
    });

})();
