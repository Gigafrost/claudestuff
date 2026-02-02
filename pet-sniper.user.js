// ==UserScript==
// @name         Tagged.com Pet Sniper (Safe Mode)
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  Auto-buys pets (new & old). UI: Top-Right with session counter & live cooldown timer. Logic: 1% Financial Rule. Excludes Lock button. Persistent Batch Counts.
// @author       Gemini
// @match        *://*.tagged.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // --- Configuration ---
    const CONFIG = {
        // Random delay between standard purchases (2.42s - 5.7s)
        minDelay: 2420,
        maxDelay: 5700,

        // Batching Logic: Pause after buying X pets
        batchSizeMin: 10,
        batchSizeMax: 12,

        // Duration of the "long pause" between batches (15s - 20s)
        batchCooldownMin: 15000,
        batchCooldownMax: 20000,

        // The safety text we MUST see before buying to consider it "Free"
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
            // EXCLUDE the lock button so we don't try to "buy" it
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
            // Close buttons priority
            closeBtns: '.lock-pet-close, .buy-pet-complete .id-button-continue, .tag-link-close, .id-button-close'
        },
        debug: true
    };

    // --- State Variables (with Persistence) ---
    let isRunning = false;
    let isProcessing = false;
    let scanInterval = null;
    let pendingIgnoreBtn = null;

    // Load state from storage or default
    let consecutivePurchases = parseInt(sessionStorage.getItem('petBot_count')) || 0;
    let currentBatchLimit = parseInt(sessionStorage.getItem('petBot_limit')) || 10;
    let totalSessionPurchases = parseInt(sessionStorage.getItem('petBot_total')) || 0;

    // Cooldown timer state
    let cooldownTimerId = null;
    let cooldownEndTime = 0;

    // --- GUI Management ---
    function createControls() {
        if (window.top !== window.self) return;
        if (document.getElementById('petbot-controls')) return;

        const div = document.createElement('div');
        div.id = 'petbot-controls';
        Object.assign(div.style, {
            position: 'fixed', top: '20px', right: '20px', zIndex: '2147483647',
            backgroundColor: '#111', color: '#fff', padding: '15px',
            borderRadius: '8px', fontFamily: 'Arial, sans-serif',
            boxShadow: '0 4px 20px rgba(0,0,0,0.6)', minWidth: '200px',
            border: '1px solid #333'
        });

        div.innerHTML = `
            <div style="font-weight:bold; color:#4caf50; margin-bottom:10px; border-bottom:1px solid #333; padding-bottom:5px;">
                Pet Sniper v3.0
            </div>
            <div id="petbot-status" style="font-size:13px; margin-bottom:8px; color:#aaa; font-weight:bold;">Stopped</div>
            <div id="petbot-total" style="font-size:12px; margin-bottom:4px; color:#4caf50; font-weight:bold;">Session: 0 pets bought</div>
            <div id="petbot-stats" style="font-size:11px; margin-bottom:4px; color:#888;">Batch: ${consecutivePurchases}/${currentBatchLimit}</div>
            <div id="petbot-cooldown" style="font-size:12px; margin-bottom:10px; color:#3498db; font-weight:bold; min-height:16px;"></div>
            <button id="petbot-start" style="width:100%; padding:8px; background:#28a745; color:white; border:none; border-radius:4px; font-weight:bold; cursor:pointer;">START (Alt+S)</button>
            <button id="petbot-stop" style="width:100%; padding:8px; background:#d32f2f; color:white; border:none; border-radius:4px; font-weight:bold; cursor:pointer; display:none;">STOP (Esc)</button>
        `;

        document.body.appendChild(div);
        document.getElementById('petbot-start').onclick = () => triggerStart(true);
        document.getElementById('petbot-stop').onclick = () => triggerStop(true);

        // Restore total display on load
        updateStats();
    }

    function updateStatus(text, color = '#aaa') {
        const el = document.getElementById('petbot-status');
        if (el) {
            el.innerText = text;
            el.style.color = color;
        }
    }

    function updateStats() {
        // Save to storage every time we update
        sessionStorage.setItem('petBot_count', consecutivePurchases);
        sessionStorage.setItem('petBot_limit', currentBatchLimit);
        sessionStorage.setItem('petBot_total', totalSessionPurchases);

        const statsEl = document.getElementById('petbot-stats');
        if (statsEl) {
            statsEl.innerText = `Batch: ${consecutivePurchases}/${currentBatchLimit}`;
        }

        const totalEl = document.getElementById('petbot-total');
        if (totalEl) {
            totalEl.innerText = `Session: ${totalSessionPurchases} pet${totalSessionPurchases !== 1 ? 's' : ''} bought`;
        }
    }

    function updateCooldownDisplay(text) {
        const el = document.getElementById('petbot-cooldown');
        if (el) {
            el.innerText = text;
        }
    }

    function startCooldownTimer(durationMs) {
        cooldownEndTime = Date.now() + durationMs;
        clearInterval(cooldownTimerId);
        cooldownTimerId = setInterval(() => {
            const remaining = Math.max(0, cooldownEndTime - Date.now());
            if (remaining <= 0) {
                clearInterval(cooldownTimerId);
                cooldownTimerId = null;
                updateCooldownDisplay('');
                return;
            }
            const secs = Math.ceil(remaining / 1000);
            updateCooldownDisplay(`Cooldown: ${secs}s remaining`);
        }, 500);
    }

    function stopCooldownTimer() {
        clearInterval(cooldownTimerId);
        cooldownTimerId = null;
        updateCooldownDisplay('');
    }

    function toggleGui(running) {
        const start = document.getElementById('petbot-start');
        const stop = document.getElementById('petbot-stop');
        if (start && stop) {
            start.style.display = running ? 'none' : 'block';
            stop.style.display = running ? 'block' : 'none';
        }
        updateStatus(running ? "Scanning..." : "Stopped", running ? '#4caf50' : '#aaa');
        if (!running) stopCooldownTimer();
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
        const prefix = window.top !== window.self ? "[PetBot-Frame]" : "[PetBot-Top]";

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
        // Traverse up to find the pet card container
        let container = btn.closest('.buy-three-friends')
            || btn.closest('[class*="id-friends-pet"]')
            || btn.closest('.pet-list-row');

        if (!container) {
            // Fallback: walk up until we find a container with .id-value
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

    // --- Helper: Success Detection ---
    function isPurchaseSuccess() {
        // Look specifically for the div structure the user provided
        const successModal = document.querySelector('.buy-pet-complete');
        const container = document.querySelector('.id-container-confirm');

        // It must be visible to count
        if (successModal && isVisible(successModal)) return true;
        if (container && isVisible(container) && container.innerText.includes("Purchase Complete")) return true;

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

    // --- Core Logic ---

    async function scanRoutine() {
        if (!isRunning || isProcessing) return;

        // 1. GLOBAL: Error Handling
        if (hasText(CONFIG.patterns.refreshErrorMsg)) {
            updateStatus("Error! Refreshing...", "#ff5252");
            console.log("[PetBot] Refresh Error. Reloading...");
            isProcessing = true;
            await sleep(2000);
            location.reload();
            return;
        }

        // 2. GLOBAL: Unaffordable
        if (hasText(CONFIG.patterns.buyGoldMsg)) {
            handleExpensivePet("Buy Gold Msg");
            return;
        }

        // 3. GLOBAL: Success Handling (Using specific detection)
        if (isPurchaseSuccess()) {
            updateStatus("Bought! Closing...", "#4caf50");
            pendingIgnoreBtn = null;

            // Close Logic
            let xBtn = document.querySelector('.lock-pet-close');
            if (!xBtn || !isVisible(xBtn)) xBtn = document.querySelector('.buy-pet-complete .id-button-continue');
            if (!xBtn || !isVisible(xBtn)) {
                const xBtns = document.querySelectorAll(CONFIG.selectors.closeBtns);
                xBtn = Array.from(xBtns).find(isVisible);
            }

            if (xBtn) {
                safeClick(xBtn);
            } else {
                switchPetBackground();
            }

            // --- BATCH LOGIC ---
            isProcessing = true;
            consecutivePurchases++;
            totalSessionPurchases++;
            console.log(`[PetBot] Purchase confirmed! Session total: ${totalSessionPurchases}. Batch: ${consecutivePurchases}/${currentBatchLimit}`);

            if (consecutivePurchases >= currentBatchLimit) {
                const batchWait = randomDelay(CONFIG.batchCooldownMin, CONFIG.batchCooldownMax);
                updateStatus(`Batch done! Cooling down...`, "#3498db");

                // Start live cooldown timer
                startCooldownTimer(batchWait);

                // Reset stats for next batch
                consecutivePurchases = 0;
                currentBatchLimit = randomDelay(CONFIG.batchSizeMin, CONFIG.batchSizeMax);
                updateStats(); // Save reset state

                await sleep(batchWait);
                stopCooldownTimer();
            } else {
                const wait = randomDelay();
                updateStats(); // Save incremented state
                updateStatus(`Waiting ${Math.round(wait/1000)}s...`, "#999");
                await sleep(wait);
            }

            isProcessing = false;
            updateStatus("Scanning...", "#4caf50");
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
            updateStatus("Updating Price...", "#ff9800");
            safeClick(newPriceBtn);
            return;
        }

        if (buyNowBtn && !buyNowBtn.disabled) {
            const modal = buyNowBtn.closest('.id-container-confirm') || document.querySelector('.id-container-confirm');

            // A. Free?
            if (isFreePet(modal)) {
                updateStatus("Buying (Free)...", "#00e676");
                safeClick(buyNowBtn);
                return;
            }

            // B. Affordable?
            let isAffordable = false;
            if (modal) {
                const startVal = parseBigCash(modal, '.confirm-list li:first-child .confirm-cash');
                const endVal = parseBigCash(modal, '.confirm-list li.ending-cash .confirm-cash');

                if (startVal !== null && endVal !== null) {
                    const threshold = (startVal * 99n) / 100n; // 99% Rule
                    if (endVal >= threshold) isAffordable = true;
                    else console.log(`[PetBot] DENIED. Start: ${startVal}, End: ${endVal}`);
                }
            }

            if (isAffordable) {
                updateStatus("Buying (Safe)...", "#00e676");
                safeClick(buyNowBtn);
                return;
            } else {
                handleExpensivePet("Expensive", allBuyBacks);
                return;
            }
        }

        // 5b. Pet list triggers (open confirmation dialogs)

        // NEW PETS: "Buy!" button on the pet list
        if (buyNewBtn && !buyNewBtn.disabled) {
            if (isGhostPet(buyNewBtn)) {
                updateStatus("Ignoring Ghost...", "#ffa500");
                console.log("[PetBot] Ghost Pet detected (new). Ignoring.");
                const ignore = findIgnoreButton(buyNewBtn);
                if (ignore) safeClick(ignore);

                isProcessing = true;
                setTimeout(() => isProcessing = false, 1200);
                return;
            }

            // Check if the pet's listed value is safe before clicking
            if (isNewPetSafe(buyNewBtn)) {
                updateStatus("Buying New Pet...", "#2196f3");
                pendingIgnoreBtn = findIgnoreButton(buyNewBtn);
                safeClick(buyNewBtn);
                isProcessing = true;
                setTimeout(() => isProcessing = false, 1200);
                return;
            } else {
                // Value too high or unreadable — skip this pet
                updateStatus("New pet too expensive, ignoring...", "#ffa500");
                console.log("[PetBot] New pet failed safety check. Ignoring.");
                const ignore = findIgnoreButton(buyNewBtn);
                if (ignore) safeClick(ignore);

                isProcessing = true;
                setTimeout(() => isProcessing = false, 1200);
                return;
            }
        }

        // OLD PETS: "Buy Back" button
        if (buyBackBtn && !buyBackBtn.disabled) {
            if (isGhostPet(buyBackBtn)) {
                 updateStatus("Ignoring Ghost...", "#ffa500");
                 console.log("[PetBot] Ghost Pet detected. Ignoring.");
                 const ignore = findIgnoreButton(buyBackBtn);
                 if(ignore) safeClick(ignore);

                 isProcessing = true;
                 setTimeout(() => isProcessing = false, 1200);
                 return;
            }

            updateStatus("Clicking Buy Back...", "#2196f3");
            pendingIgnoreBtn = findIgnoreButton(buyBackBtn);
            safeClick(buyBackBtn);
            isProcessing = true;
            setTimeout(() => isProcessing = false, 1200);
            return;
        }

        // "Buy Again" button
        if (buyAgainBtn) {
             updateStatus("Clicking Buy Again...", "#2196f3");
             pendingIgnoreBtn = null;
             safeClick(buyAgainBtn);
             isProcessing = true;
             setTimeout(() => isProcessing = false, 1200);
             return;
        }
    }

    // --- Helper: Escape/Ignore Expensive ---
    async function handleExpensivePet(reason, availableBuyBacks = []) {
        updateStatus("Too Expensive!", "#ff5252");
        isProcessing = true;

        const closeBtn = Array.from(document.querySelectorAll(CONFIG.selectors.closeBtns)).find(isVisible);
        if (closeBtn) {
            safeClick(closeBtn);
        } else {
            // Escape Hatch logic
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
         if(backs.length > 1) safeClick(backs[1]);
    }

    // --- Init ---
    function startBot() {
        if (isRunning) return;
        isRunning = true;
        isProcessing = false;
        pendingIgnoreBtn = null;

        // Restore or Init
        if (currentBatchLimit < 10) currentBatchLimit = randomDelay(CONFIG.batchSizeMin, CONFIG.batchSizeMax);

        toggleGui(true);
        console.log(`[PetBot] Bot Started. Session total: ${totalSessionPurchases}. Batch: ${consecutivePurchases}/${currentBatchLimit}`);
        scanInterval = setInterval(scanRoutine, 250);
    }

    function stopBot() {
        if (!isRunning) return;
        isRunning = false;
        clearInterval(scanInterval);
        stopCooldownTimer();
        toggleGui(false);
        console.log("[PetBot] Bot Stopped");
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
