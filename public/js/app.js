// --- Elements ---
const chatContainer = document.getElementById('chatContainer');
const chatContent = document.getElementById('chatContent');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const queueBtn = document.getElementById('queueBtn');
const scrollToBottomBtn = document.getElementById('scrollToBottom');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const refreshBtn = document.getElementById('refreshBtn');
const stopBtn = document.getElementById('stopBtn');
const stopBarBtn = document.getElementById('stopBarBtn');
const queueTray = document.getElementById('queueTray');
const queueBadge = document.getElementById('queueBadge');
const queuePreview = document.getElementById('queuePreview');
const queueSendNowBtn = document.getElementById('queueSendNowBtn');
const queueClearBtn = document.getElementById('queueClearBtn');
const newChatBtn = document.getElementById('newChatBtn');
const historyBtn = document.getElementById('historyBtn');

const activeChatTitle = document.getElementById('activeChatTitle');
const historyCountBadge = document.getElementById('historyCountBadge');
const drawerCountTag = document.getElementById('drawerCountTag');
const historySearchInput = document.getElementById('historySearchInput');
const clearSearchBtn = document.getElementById('clearSearchBtn');

const modeBtn = document.getElementById('modeBtn');
const modelBtn = document.getElementById('modelBtn');
const modalOverlay = document.getElementById('modalOverlay');
const modalList = document.getElementById('modalList');
const modalTitle = document.getElementById('modalTitle');
const modeText = document.getElementById('modeText');
const modelText = document.getElementById('modelText');
const historyLayer = document.getElementById('historyLayer');
const historyList = document.getElementById('historyList');

const restartModalOverlay = document.getElementById('restartModalOverlay');
const restartProgressOverlay = document.getElementById('restartProgressOverlay');
const restartProgressTitle = document.getElementById('restartProgressTitle');
const restartProgressDesc = document.getElementById('restartProgressDesc');
const restartCountdownVal = document.getElementById('restartCountdownVal');

// --- State ---
let autoRefreshEnabled = true;
let userIsScrolling = false;
let userScrollLockUntil = 0;
let lastScrollPosition = 0;
let ws = null;
let idleTimer = null;
let lastHash = '';
let currentMode = 'Fast';
let chatIsOpen = true;
let currentChatTitle = 'Current Conversation';
let cachedConversations = [];

// --- Toast Notification ---
function showToast(message, duration = 3000) {
    let toast = document.getElementById('ag-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'ag-toast';
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.style.opacity = '1';
    toast.style.transform = 'translateX(-50%) translateY(0)';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(-50%) translateY(-10px)';
    }, duration);
}

// --- Auth Utilities ---
async function fetchWithAuth(url, options = {}) {
    if (!options.headers) options.headers = {};
    options.headers['ngrok-skip-browser-warning'] = 'true';
    try {
        const res = await fetch(url, options);
        return res;
    } catch (e) {
        throw e;
    }
}
const USER_SCROLL_LOCK_DURATION = 3000;

// --- Sync State (Desktop is Always Priority) ---
async function fetchAppState() {
    try {
        const res = await fetchWithAuth('/app-state');
        const data = await res.json();

        if (data.mode && data.mode !== 'Unknown') {
            modeText.textContent = data.mode;
            modeBtn.classList.toggle('active', data.mode === 'Planning');
            currentMode = data.mode;
        }

        if (data.model && data.model !== 'Unknown') {
            modelText.textContent = data.model;
        }
    } catch (e) { }
}

// --- SSL Banner ---
const sslBanner = document.getElementById('sslBanner');

async function checkSslStatus() {
    if (window.location.protocol === 'https:') return;
    if (localStorage.getItem('sslBannerDismissed')) return;
    if (sslBanner) sslBanner.style.display = 'flex';
}

async function enableHttps() {
    const btn = document.getElementById('enableHttpsBtn');
    if (btn) {
        btn.textContent = 'Generating...';
        btn.disabled = true;
    }

    try {
        const res = await fetchWithAuth('/generate-ssl', { method: 'POST' });
        const data = await res.json();

        if (data.success && sslBanner) {
            sslBanner.innerHTML = `
                <span>✅ ${data.message}</span>
                <button onclick="location.reload()">Reload After Restart</button>
            `;
            sslBanner.style.background = 'linear-gradient(90deg, #22c55e, #16a34a)';
        } else if (btn) {
            btn.textContent = 'Failed - Retry';
            btn.disabled = false;
        }
    } catch (e) {
        if (btn) {
            btn.textContent = 'Error - Retry';
            btn.disabled = false;
        }
    }
}

function dismissSslBanner() {
    if (sslBanner) sslBanner.style.display = 'none';
    localStorage.setItem('sslBannerDismissed', 'true');
}

checkSslStatus();

// --- Models (Matching Desktop IDE Providers & Submodels) ---
const MODELS = [
    "Gemini 3.7 Flash High",
    "Gemini 3.6 Flash Medium",
    "Gemini 3.5 Flash Medium",
    "Gemini 3.1 Pro Low",
    "Claude Sonnet 4.6 (Thinking)",
    "Claude Opus 4.6 (Thinking)",
    "GPT-OSS 120B (Medium)"
];

// --- Modal Dialog System (Models, Modes) ---
function openModal(title, options, onSelect) {
    if (!modalTitle || !modalList || !modalOverlay) return;
    modalTitle.textContent = title;
    modalList.innerHTML = '';

    const currentVal = (title === 'Select Model' ? (modelText ? modelText.textContent.trim() : '') : (modeText ? modeText.textContent.trim() : ''));

    options.forEach(opt => {
        const div = document.createElement('div');
        div.className = 'modal-option';
        if (currentVal && (opt.toLowerCase().includes(currentVal.toLowerCase()) || currentVal.toLowerCase().includes(opt.toLowerCase()))) {
            div.style.background = 'rgba(34, 197, 94, 0.15)';
            div.style.color = '#4ade80';
            div.style.fontWeight = '600';
        }
        div.textContent = opt;
        div.onclick = () => {
            onSelect(opt);
            closeModal();
        };
        modalList.appendChild(div);
    });

    modalOverlay.classList.add('show');
}

function closeModal() {
    if (modalOverlay) modalOverlay.classList.remove('show');
}
window.closeModal = closeModal;

if (modalOverlay) {
    modalOverlay.onclick = (e) => {
        if (e.target === modalOverlay) closeModal();
    };
}

// Mode Selector Trigger (Fast / Planning)
if (modeBtn) {
    modeBtn.addEventListener('click', () => {
        openModal('Select Mode', ['Fast', 'Planning'], async (mode) => {
            const prev = modeText ? modeText.textContent : 'Fast';
            if (modeText) modeText.textContent = 'Setting...';
            showToast(`Switching mode to ${mode}...`);
            try {
                const res = await fetchWithAuth('/set-mode', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mode })
                });
                const data = await res.json();
                if (data.success) {
                    currentMode = mode;
                    if (modeText) modeText.textContent = mode;
                    modeBtn.classList.toggle('active', mode === 'Planning');
                    showToast(`✅ Mode set to ${mode}`);
                    setTimeout(fetchAppState, 800);
                } else {
                    showToast(`❌ Error: ${data.error || 'Failed to change mode'}`);
                    if (modeText) modeText.textContent = prev;
                }
            } catch (e) {
                showToast(`❌ Error: ${e.message}`);
                if (modeText) modeText.textContent = prev;
            }
        });
    });
}

// Model Selector Trigger
if (modelBtn) {
    modelBtn.addEventListener('click', () => {
        openModal('Select Model', MODELS, async (model) => {
            const prev = modelText ? modelText.textContent : '';
            if (modelText) modelText.textContent = 'Setting...';
            showToast(`Switching AI model to ${model}...`);
            try {
                const res = await fetchWithAuth('/set-model', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model })
                });
                const data = await res.json();
                if (data.success) {
                    if (modelText) modelText.textContent = model;
                    showToast(`✅ AI model switched to ${model}`);
                    setTimeout(fetchAppState, 800);
                } else {
                    showToast(`❌ Error: ${data.error || 'Failed to switch model'}`);
                    if (modelText) modelText.textContent = prev;
                }
            } catch (e) {
                showToast(`❌ Error: ${e.message}`);
                if (modelText) modelText.textContent = prev;
            }
        });
    });
}


// --- Message Queue & Agent State UI ---
let currentQueueItems = [];

async function refreshQueueStatus() {
    try {
        const res = await fetchWithAuth('/api/queue');
        if (res.ok) {
            const data = await res.json();
            updateQueueUI(data.items || []);
            if (data.isAgentBusy !== undefined) {
                updateAgentBusyState(data.isAgentBusy);
            }
        }
    } catch (e) { }
}

function updateQueueUI(items) {
    currentQueueItems = items || [];
    if (!queueTray) return;

    if (currentQueueItems.length > 0) {
        queueTray.style.display = 'flex';
        if (queueBadge) queueBadge.textContent = `${currentQueueItems.length} Queued`;
        const first = currentQueueItems[0];
        const previewText = first.text.length > 35 ? first.text.substring(0, 35) + '...' : first.text;
        if (queuePreview) queuePreview.textContent = `Next: "${previewText}"`;
    } else {
        queueTray.style.display = 'none';
    }
}

function updateAgentBusyState(isBusy) {
    if (stopBtn) {
        if (isBusy) {
            stopBtn.classList.add('is-active');
            stopBtn.title = 'Stop active agent execution (Ctrl+D)';
        } else {
            stopBtn.classList.remove('is-active');
            stopBtn.title = 'Stop agent execution';
        }
    }
    if (stopBarBtn) {
        stopBarBtn.style.display = isBusy ? 'flex' : 'none';
    }
}

if (queueSendNowBtn) {
    queueSendNowBtn.addEventListener('click', async () => {
        queueSendNowBtn.disabled = true;
        showToast('⚡ Force-sending next queued message...');
        try {
            const res = await fetchWithAuth('/api/queue/send-now', { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                showToast('🚀 Message sent to agent!');
                setTimeout(loadSnapshot, 300);
            } else {
                showToast('Send failed: ' + (data.error || 'Unknown error'));
            }
        } catch (e) {
            showToast('Error: ' + e.message);
        } finally {
            queueSendNowBtn.disabled = false;
            refreshQueueStatus();
        }
    });
}

if (queueClearBtn) {
    queueClearBtn.addEventListener('click', async () => {
        queueClearBtn.disabled = true;
        try {
            const res = await fetchWithAuth('/api/queue/clear', { method: 'POST' });
            const data = await res.json();
            showToast(`🗑️ Cleared ${data.cleared || 0} queued message(s)`);
            updateQueueUI([]);
        } catch (e) {
            showToast('Clear failed: ' + e.message);
        } finally {
            queueClearBtn.disabled = false;
        }
    });
}

// --- WebSocket ---
function connectWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}`);

    ws.onopen = () => {
        console.log('WS Connected');
        updateStatus(true);
        loadSnapshot();
    };

    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data.type === 'snapshot_update' && autoRefreshEnabled && !userIsScrolling) {
                loadSnapshot();
            } else if (data.type === 'queue_update') {
                updateQueueUI(data.items || []);
            }
        } catch (e) { }
    };

    ws.onclose = () => {
        console.log('WS Disconnected');
        updateStatus(false);
        setTimeout(connectWebSocket, 2000);
    };
}

function updateStatus(connected) {
    if (connected) {
        statusDot.classList.remove('disconnected');
        statusDot.classList.add('connected');
        statusText.textContent = 'Live';
    } else {
        statusDot.classList.remove('connected');
        statusDot.classList.add('disconnected');
        statusText.textContent = 'Reconnecting';
    }
}

// --- Rendering ---
async function loadSnapshot() {
    try {
        const snapshotController = new AbortController();
        const snapshotTimeout = setTimeout(() => snapshotController.abort(), 8000);
        const response = await fetchWithAuth('/snapshot', { signal: snapshotController.signal });
        clearTimeout(snapshotTimeout);
        if (!response.ok) {
            if (response.status === 503) {
                chatIsOpen = false;
                showEmptyState();
                return;
            }
            throw new Error('Failed to load');
        }

        chatIsOpen = true;
        const data = await response.json();
        if (data.isAgentBusy !== undefined) {
            updateAgentBusyState(data.isAgentBusy);
        } else if (data.html) {
            const isBusy = data.html.includes('input-send-button-cancel-tooltip') ||
                           data.html.includes('lucide-square') ||
                           data.html.includes('bg-red-500');
            updateAgentBusyState(isBusy);
        }

        // Capture scroll state BEFORE updating content
        const scrollPos = chatContainer.scrollTop;
        const scrollHeight = chatContainer.scrollHeight;
        const clientHeight = chatContainer.clientHeight;
        const isNearBottom = scrollHeight - scrollPos - clientHeight < 120;
        const isUserScrollLocked = Date.now() < userScrollLockUntil;

        if (data.stats) {
            const kbs = Math.round((data.stats.htmlSize + data.stats.cssSize) / 1024);
            const nodes = data.stats.nodes;
            const statsText = document.getElementById('statsText');
            if (statsText) statsText.textContent = `${nodes} Nodes · ${kbs}KB`;
        }

        // CSS Injection
        let styleTag = document.getElementById('cdp-styles');
        if (!styleTag) {
            styleTag = document.createElement('style');
            styleTag.id = 'cdp-styles';
            document.head.appendChild(styleTag);
        }

        const darkModeOverrides = `
${data.css || ''}

:root {
    --bg-app: #181818;
    --text-main: #CCCCCC;
    --text-muted: #858585;
    --border-color: #2B2B2B;
}

/* Global Mobile Resets inside chat */
#conversation, #conversation *, #chat, #chat *, #cascade, #cascade * {
    box-sizing: border-box !important;
    min-width: 0 !important;
}

[style*="container-type"], [class*="container-"] {
    container-type: normal !important;
}

#conversation, #chat, #cascade {
    background-color: transparent !important;
    color: var(--text-main) !important;
    font-family: 'Inter', system-ui, -apple-system, sans-serif !important;
    font-size: 14.5px !important;
    position: relative !important;
    height: auto !important;
    width: 100% !important;
    max-width: 100% !important;
    display: block !important;
    overflow-x: hidden !important;
    padding-left: 0 !important;
    padding-right: 0 !important;
    margin-left: 0 !important;
    margin-right: 0 !important;
}

#conversation > div,
#conversation div[class*="overflow-"],
#conversation div[class*="grow"],
#conversation [tabindex="0"] {
    height: auto !important;
    min-height: 0 !important;
    max-height: none !important;
    overflow: visible !important;
    flex: none !important;
    display: block !important;
    width: 100% !important;
    max-width: 100% !important;
    padding-left: 2px !important;
    padding-right: 2px !important;
    margin-left: 0 !important;
    margin-right: 0 !important;
}

#conversation p, #chat p, #cascade p,
#conversation span, #chat span, #cascade span,
#conversation div, #chat div, #cascade div,
#conversation li, #chat li, #cascade li,
#conversation h1, #chat h1, #cascade h1,
#conversation h2, #chat h2, #cascade h2,
#conversation h3, #chat h3, #cascade h3,
#conversation h4, #chat h4, #cascade h4 {
    color: inherit !important;
    overflow-wrap: anywhere !important;
    word-break: break-word !important;
    max-width: 100% !important;
}

#conversation a, #chat a, #cascade a {
    color: #60a5fa !important;
    text-decoration: underline;
    overflow-wrap: anywhere !important;
    word-break: break-all !important;
}

/* User Message Bubble styling */
[role="article"],
[data-testid="user-input-step"],
.group\/user-input-step {
    width: 100% !important;
    max-width: 100% !important;
    box-sizing: border-box !important;
    overflow: visible !important;
}

.whitespace-pre-wrap, .select-text, .leading-relaxed {
    white-space: pre-wrap !important;
    word-break: break-word !important;
    overflow-wrap: anywhere !important;
    max-width: 100% !important;
}

:not(pre) > code {
    padding: 1px 4px !important;
    border-radius: 3px !important;
    background-color: rgba(255, 255, 255, 0.1) !important;
    font-size: 0.88em !important;
    font-family: 'JetBrains Mono', monospace !important;
    word-break: break-all !important;
    overflow-wrap: anywhere !important;
    white-space: pre-wrap !important;
    max-width: 100% !important;
    display: inline !important;
}

pre, code, .monaco-editor-background {
    background-color: #1a1a1a !important;
    color: #e2e8f0 !important;
    font-family: 'JetBrains Mono', monospace !important;
    border-radius: 4px;
    border: 1px solid #333333;
}

[class*="terminal"] {
    background-color: #141414 !important;
    color: #4ade80 !important;
    font-family: 'JetBrains Mono', monospace !important;
    border-radius: 4px;
    border: 1px solid #2d2d2d;
    max-height: 320px !important;
    overflow-x: auto !important;
    overflow-y: auto !important;
    height: auto !important;
    max-width: 100% !important;
    box-sizing: border-box !important;
}

[class*="terminal"]:empty,
[class*="terminal"]:not(:has(*)),
[class*="xterm"]:empty,
[class*="xterm"]:not(:has(*)) {
    display: none !important;
}

pre {
    position: relative !important;
    white-space: pre-wrap !important; 
    word-break: break-word !important;
    overflow-wrap: anywhere !important;
    padding: 8px 34px 8px 10px !important;
    margin: 6px 0 !important;
    display: block !important;
    width: 100% !important;
    max-width: 100% !important;
    box-sizing: border-box !important;
    overflow-x: auto !important;
}

pre code {
    white-space: pre-wrap !important;
    word-break: break-word !important;
    overflow-wrap: anywhere !important;
    max-width: 100% !important;
}

pre.has-copy-btn {
    padding-right: 36px !important;
}

.mobile-copy-btn {
    position: absolute !important;
    top: 4px !important;
    right: 4px !important;
    background: rgba(40, 40, 40, 0.8) !important;
    color: #94a3b8 !important;
    border: 1px solid #444 !important;
    width: 26px !important; 
    height: 26px !important;
    padding: 0 !important;
    cursor: pointer !important;
    display: flex !important;
    align-items: center !important;
    justify-content: center !important;
    border-radius: 4px !important;
    transition: all 0.2s ease !important;
    z-index: 10 !important;
}

.mobile-copy-btn:hover {
    background: rgba(34, 197, 94, 0.2) !important;
    color: #4ade80 !important;
    border-color: #22c55e !important;
}

.mobile-copy-btn svg {
    width: 14px !important;
    height: 14px !important;
    stroke: currentColor !important;
    stroke-width: 2 !important;
    fill: none !important;
}

/* Tables in markdown */
table {
    width: 100% !important;
    max-width: 100% !important;
    display: block !important;
    overflow-x: auto !important;
    border-collapse: collapse !important;
    margin: 8px 0 !important;
}



/* ==========================================
   ◆ Revert Regular Chat Text to Crisp White/Gray
   ========================================== */
#conversation p, #chat p, #cascade p,
#conversation li, #chat li, #cascade li,
#conversation h1, #chat h1, #cascade h1,
#conversation h2, #chat h2, #cascade h2,
#conversation h3, #chat h3, #cascade h3,
#conversation h4, #chat h4, #cascade h4 {
    color: #e2e8f0 !important;
}

#chatContent [class*="text-muted-foreground"]:not(.artifact-card *):not([data-testid="worked-for-collapsible"] *) {
    color: #94a3b8 !important;
}

#chatContent [class*="text-secondary-foreground"]:not(.artifact-card *):not([data-testid="worked-for-collapsible"] *) {
    color: #e2e8f0 !important;
}

/* ==========================================
   ◆ White Artifact Tabs -> Greenish Theme & Expandable
   ========================================== */
.artifact-card,
#chatContent .artifact-card,
div.border.rounded-xl.artifact-card,
div[class*="artifact-card"],
div.border.my-0\.5.rounded-xl,
button[draggable="true"],
#chatContent div:has(> button[draggable="true"]),
#chatContent button:has(svg path[d*="M320-253.85"]) {
    background: linear-gradient(135deg, rgba(34, 197, 94, 0.14) 0%, rgba(15, 28, 20, 0.85) 100%) !important;
    border: 1px solid rgba(34, 197, 94, 0.45) !important;
    border-radius: 12px !important;
    padding: 7px 14px !important;
    margin: 6px 0 !important;
    color: #86efac !important;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4), inset 0 0 12px rgba(34, 197, 94, 0.08) !important;
    cursor: pointer !important;
    display: inline-flex !important;
    flex-direction: row !important;
    align-items: center !important;
    gap: 8px !important;
    transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1) !important;
    width: auto !important;
    max-width: 100% !important;
}

.artifact-card:hover,
.artifact-card:active,
#chatContent .artifact-card:active {
    background: linear-gradient(135deg, rgba(34, 197, 94, 0.24) 0%, rgba(18, 42, 28, 0.95) 100%) !important;
    border-color: #22c55e !important;
    box-shadow: 0 0 16px rgba(34, 197, 94, 0.35) !important;
    transform: scale(0.985);
}

.artifact-card button,
.artifact-card span,
.artifact-card button span,
#chatContent .artifact-card button,
#chatContent .artifact-card span {
    color: #86efac !important;
    font-weight: 600 !important;
    font-size: 13.5px !important;
    pointer-events: auto !important;
}

.artifact-card svg,
.artifact-card button svg,
#chatContent .artifact-card svg {
    color: #4ade80 !important;
    fill: currentColor !important;
    stroke: currentColor !important;
    width: 18px !important;
    height: 18px !important;
    flex-shrink: 0 !important;
}

/* Collapsible tool steps (Ran X commands, etc.) */
button[data-testid="worked-for-collapsible"],
button[class*="tabular-nums"] {
    background: linear-gradient(135deg, rgba(34, 197, 94, 0.1) 0%, rgba(14, 26, 18, 0.8) 100%) !important;
    border: 1px solid rgba(34, 197, 94, 0.35) !important;
    color: #4ade80 !important;
    border-radius: 10px !important;
    padding: 6px 12px !important;
    margin: 4px 0 !important;
    box-shadow: 0 1px 4px rgba(0, 0, 0, 0.4) !important;
    cursor: pointer !important;
}

button[data-testid="worked-for-collapsible"] span,
button[class*="tabular-nums"] span {
    color: #86efac !important;
}

button[data-testid="worked-for-collapsible"] svg,
button[class*="tabular-nums"] svg {
    color: #4ade80 !important;
    fill: currentColor !important;
}

table th, table td {
    word-break: break-word !important;
    overflow-wrap: anywhere !important;
    padding: 4px 8px !important;
}
`;
        styleTag.textContent = darkModeOverrides;
        chatContent.innerHTML = data.html;

        addMobileCopyButtons();

        if (isUserScrollLocked) {
            const scrollPercent = scrollHeight > 0 ? scrollPos / scrollHeight : 0;
            chatContainer.scrollTop = chatContainer.scrollHeight * scrollPercent;
        } else if (isNearBottom || scrollPos === 0) {
            scrollToBottom();
        }
    } catch (e) {
        console.error('Snapshot error:', e);
    }
}

function scrollToBottom() {
    chatContainer.scrollTop = chatContainer.scrollHeight;
}

// --- Mobile Code Copy Buttons ---
function addMobileCopyButtons() {
    const codeBlocks = chatContent.querySelectorAll('pre');
    codeBlocks.forEach(pre => {
        if (pre.querySelector('.mobile-copy-btn')) return;
        pre.classList.add('has-copy-btn');

        const btn = document.createElement('button');
        btn.className = 'mobile-copy-btn';
        btn.setAttribute('aria-label', 'Copy code');
        btn.innerHTML = `<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;

        btn.onclick = (e) => {
            e.stopPropagation();
            const code = pre.querySelector('code')?.innerText || pre.innerText;
            navigator.clipboard.writeText(code).then(() => {
                btn.innerHTML = `<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>`;
                btn.style.color = '#22c55e';
                showToast('Code copied to clipboard');
                setTimeout(() => {
                    btn.innerHTML = `<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
                    btn.style.color = '';
                }, 2000);
            });
        };
        pre.appendChild(btn);
    });
}

// --- Universal Attachment Handling (Files, Code, Images, Audio, Docs) ---
let attachedFiles = [];
const fileInput = document.getElementById('fileInput');
const attachBtn = document.getElementById('attachBtn');
const attachPreview = document.getElementById('attachPreview');
const attachPreviewInner = document.getElementById('attachPreviewInner');

function getFileMeta(fileName, mimeType) {
    const ext = (fileName.split('.').pop() || '').toLowerCase();
    if (/^(jpe?g|png|gif|webp|svg|bmp|ico)$/i.test(ext) || (mimeType && mimeType.startsWith('image/'))) {
        return { isImage: true, icon: '🖼️', extLabel: ext.toUpperCase() };
    }
    if (/^(pdf)$/i.test(ext)) return { isImage: false, icon: '📕', extLabel: 'PDF' };
    if (/^(py|js|ts|jsx|tsx|html|css|json|cpp|c|h|rs|go|sh|bash|java|kt|php|rb|sql|yaml|yml|xml|md|toml)$/i.test(ext)) {
        return { isImage: false, icon: '💻', extLabel: ext.toUpperCase() };
    }
    if (/^(zip|tar|gz|7z|rar|bz2|xz)$/i.test(ext)) return { isImage: false, icon: '📦', extLabel: ext.toUpperCase() };
    if (/^(mp3|wav|ogg|m4a|flac|aac)$/i.test(ext) || (mimeType && mimeType.startsWith('audio/'))) {
        return { isImage: false, icon: '🎵', extLabel: 'AUDIO' };
    }
    if (/^(mp4|mkv|webm|mov|avi)$/i.test(ext) || (mimeType && mimeType.startsWith('video/'))) {
        return { isImage: false, icon: '🎬', extLabel: 'VIDEO' };
    }
    if (/^(txt|log|csv|tsv|env|ini|conf)$/i.test(ext)) return { isImage: false, icon: '📝', extLabel: ext.toUpperCase() };
    if (/^(docx?|xlsx?|pptx?|epub)$/i.test(ext)) return { isImage: false, icon: '📄', extLabel: ext.toUpperCase() };
    return { isImage: false, icon: '📄', extLabel: ext ? ext.toUpperCase().slice(0, 4) : 'FILE' };
}

function formatFileSize(bytes) {
    if (!bytes || bytes <= 0) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function addAttachedFile(file) {
    if (!file) return;
    const meta = getFileMeta(file.name || '', file.type || '');
    const reader = new FileReader();
    reader.onload = (ev) => {
        attachedFiles.push({
            file,
            name: file.name || 'uploaded_file',
            size: file.size || 0,
            type: file.type || 'application/octet-stream',
            isImage: meta.isImage,
            icon: meta.icon,
            extLabel: meta.extLabel,
            dataUrl: ev.target.result
        });
        renderAttachPreview();
    };
    reader.readAsDataURL(file);
}

// Backward compatibility alias
function addImageFile(file) {
    addAttachedFile(file);
}

if (attachBtn && fileInput) {
    attachBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
        const files = Array.from(e.target.files);
        for (const file of files) {
            addAttachedFile(file);
        }
        fileInput.value = '';
    });
}

// Support pasting images or files directly from clipboard (Ctrl+V / long press)
if (messageInput) {
    messageInput.addEventListener('input', () => {
        messageInput.style.height = 'auto';
        messageInput.style.height = Math.min(messageInput.scrollHeight, 140) + 'px';
    });

    messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage({ forceSend: false });
        }
    });

    messageInput.addEventListener('paste', (e) => {
        const items = (e.clipboardData || window.clipboardData)?.items;
        if (items) {
            for (const item of items) {
                if (item.kind === 'file') {
                    const file = item.getAsFile();
                    if (file) {
                        addAttachedFile(file);
                        showToast(`📎 Attached ${file.name || 'file from clipboard'}`);
                        e.preventDefault();
                    }
                }
            }
        }
    });
}

function renderAttachPreview() {
    if (!attachPreview || !attachPreviewInner) return;
    if (attachedFiles.length === 0) {
        attachPreview.style.display = 'none';
        attachPreviewInner.innerHTML = '';
        return;
    }
    attachPreview.style.display = 'block';
    attachPreviewInner.innerHTML = attachedFiles.map((item, idx) => {
        if (item.isImage) {
            return `
                <div class="attach-thumb" title="${escapeHtml(item.name)} (${formatFileSize(item.size)})">
                    <img src="${item.dataUrl}" alt="attachment" />
                    <button class="attach-thumb-remove" onclick="removeAttachedFile(${idx})">×</button>
                </div>
            `;
        }
        return `
            <div class="attach-thumb file-card" title="${escapeHtml(item.name)} (${formatFileSize(item.size)})">
                <div class="attach-file-icon">${item.icon}</div>
                <div class="attach-file-name">${escapeHtml(item.name)}</div>
                <div class="attach-file-size">${formatFileSize(item.size)}</div>
                <button class="attach-thumb-remove" onclick="removeAttachedFile(${idx})">×</button>
            </div>
        `;
    }).join('');
}

window.removeAttachedFile = function (idx) {
    attachedFiles.splice(idx, 1);
    renderAttachPreview();
};

window.removeAttachedImage = window.removeAttachedFile;

// --- Send Message (Supports direct send, queue, and force-send) ---
async function sendMessage({ forceQueue = false, forceSend = false } = {}) {
    const text = messageInput.value.trim();
    if (!text && attachedFiles.length === 0) return;

    // Optimistic frontrunning bubble in the UI
    try {
        const bubble = document.createElement('div');
        bubble.className = 'optimistic-user-bubble';
        bubble.style.cssText = 'background: #2563eb; color: #ffffff; padding: 10px 14px; border-radius: 14px 14px 2px 14px; margin: 10px 8px 10px auto; max-width: 85%; font-size: 14px; line-height: 1.5; word-break: break-word; box-shadow: 0 2px 8px rgba(37,99,235,0.25); text-align: left;';
        bubble.textContent = text || (attachedFiles.length === 1 ? `Sent file: ${attachedFiles[0].name}` : `Sent ${attachedFiles.length} file attachments`);
        chatContent.appendChild(bubble);
        chatContainer.scrollTop = chatContainer.scrollHeight;
    } catch(e) {}
    if (!text && attachedFiles.length === 0) return;

    if (sendBtn) sendBtn.disabled = true;
    if (queueBtn) queueBtn.disabled = true;
    messageInput.disabled = true;

    try {
        const uploadedItems = [];
        // Upload files first if any
        if (attachedFiles.length > 0) {
            showToast(`Uploading ${attachedFiles.length} file(s)...`);
            for (const item of attachedFiles) {
                try {
                    const res = await fetchWithAuth('/upload-file', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            name: item.name,
                            dataUrl: item.dataUrl
                        })
                    });
                    const uData = await res.json();
                    if (uData.path) {
                        uploadedItems.push({
                            path: uData.path,
                            name: item.name,
                            isImage: item.isImage
                        });
                    } else if (uData.error) {
                        console.warn('File upload error:', uData.error);
                        showToast('File upload: ' + uData.error);
                    }
                } catch (err) {
                    console.error('Failed to upload file:', err);
                }
            }
            attachedFiles = [];
            renderAttachPreview();
        }

        let messageToSend = text;
        if (uploadedItems.length > 0) {
            const fileRefs = uploadedItems.map(item => {
                if (item.isImage) {
                    return `[Uploaded Image/Screenshot: ${item.path}]`;
                }
                return `[Uploaded File: ${item.path}] (${item.name})`;
            }).join('\n');

            if (messageToSend) {
                messageToSend = `${messageToSend}\n\n${fileRefs}`;
            } else {
                messageToSend = `I have uploaded the following file(s):\n${fileRefs}\nPlease inspect them and assist me.`;
            }
        }

        if (messageToSend) {
            const res = await fetchWithAuth('/send', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: messageToSend,
                    forceQueue: forceQueue,
                    forceSend: forceSend
                })
            });
            const data = await res.json();
            if (data.queued) {
                showToast(`📋 Message added to queue (#${data.queuePosition || 1}) — auto-sends when idle`);
                refreshQueueStatus();
            } else if (data.error) {
                showToast('Error: ' + data.error);
            } else {
                showToast('✅ Prompt sent to agent');
            }
        }

        messageInput.value = '';
        messageInput.style.height = 'auto';
        setTimeout(loadSnapshot, 300);
        setTimeout(loadSnapshot, 1000);
    } catch (e) {
        showToast('Failed to send: ' + e.message);
    } finally {
        if (sendBtn) sendBtn.disabled = false;
        if (queueBtn) queueBtn.disabled = false;
        messageInput.disabled = false;
        messageInput.focus();
    }
}

if (sendBtn) sendBtn.addEventListener('click', () => sendMessage({ forceSend: false }));
if (queueBtn) queueBtn.addEventListener('click', () => sendMessage({ forceQueue: true }));


// --- Workspace & New Chat Modal Logic ---
let cachedWorkspaces = [];
let activeWsTab = 'choose';

const newChatLayer = document.getElementById('newChatLayer');
const wsFoldersList = document.getElementById('wsFoldersList');
const currentWsName = document.getElementById('currentWsName');
const newFolderNameInput = document.getElementById('newFolderNameInput');

window.showNewChatModal = showNewChatModal;
window.hideNewChatModal = hideNewChatModal;
window.switchWsTab = switchWsTab;
window.filterWorkspaces = filterWorkspaces;
window.createAndStartInNewFolder = createAndStartInNewFolder;
window.confirmStartNewChat = confirmStartNewChat;

async function showNewChatModal() {
    if (newChatLayer) newChatLayer.classList.add('show');
    fetchWorkspaces();
}

function hideNewChatModal() {
    if (newChatLayer) newChatLayer.classList.remove('show');
}

function switchWsTab(tab) {
    activeWsTab = tab;
    const tabChoose = document.getElementById('tabChooseWs');
    const tabCreate = document.getElementById('tabCreateWs');
    const panelChoose = document.getElementById('panelChooseWs');
    const panelCreate = document.getElementById('panelCreateWs');

    if (tab === 'choose') {
        if (tabChoose) tabChoose.classList.add('active');
        if (tabCreate) tabCreate.classList.remove('active');
        if (panelChoose) panelChoose.style.display = 'block';
        if (panelCreate) panelCreate.style.display = 'none';
    } else {
        if (tabCreate) tabCreate.classList.add('active');
        if (tabChoose) tabChoose.classList.remove('active');
        if (panelCreate) panelCreate.style.display = 'block';
        if (panelChoose) panelChoose.style.display = 'none';
        if (newFolderNameInput) newFolderNameInput.focus();
    }
}

async function fetchWorkspaces() {
    try {
        const res = await fetchWithAuth('/api/workspaces');
        const data = await res.json();
        if (data.success) {
            cachedWorkspaces = data.workspaces || [];
            if (currentWsName && data.currentWorkspace) {
                currentWsName.textContent = '📁 ' + (data.currentWorkspace.name || data.currentWorkspace);
            }
            renderWorkspacesList(cachedWorkspaces);
        }
    } catch (e) {
        console.error('Failed to fetch workspaces:', e);
    }
}

function renderWorkspacesList(workspaces) {
    if (!wsFoldersList) return;
    if (workspaces.length === 0) {
        wsFoldersList.innerHTML = '<div style="padding: 24px; text-align: center; color: var(--text-muted);"><div>📁</div><div>No matching folders found</div></div>';
        return;
    }

    wsFoldersList.innerHTML = workspaces.map(ws => `
        <div class="ws-folder-item" onclick="confirmStartNewChat('${escapeHtml(ws.path)}')">
            <div class="ws-item-left">
                <div class="ws-item-icon">📁</div>
                <div class="ws-item-details">
                    <div class="ws-item-name">${escapeHtml(ws.name)}</div>
                    <div class="ws-item-path">${escapeHtml(ws.path)}</div>
                </div>
            </div>
            <div class="ws-item-action">
                <span class="ws-select-tag">Select</span>
            </div>
        </div>
    `).join('');
}

function filterWorkspaces(query) {
    const q = (query || '').toLowerCase().trim();
    if (!q) {
        renderWorkspacesList(cachedWorkspaces);
        return;
    }
    const filtered = cachedWorkspaces.filter(ws =>
        (ws.name || '').toLowerCase().includes(q) || (ws.path || '').toLowerCase().includes(q)
    );
    renderWorkspacesList(filtered);
}

async function createAndStartInNewFolder() {
    const name = (newFolderNameInput?.value || '').trim();
    if (!name) {
        showToast('Please enter a folder name');
        return;
    }
    hideNewChatModal();
    await confirmStartNewChat(null, name);
}

async function confirmStartNewChat(folderPath, newFolderName) {
    hideNewChatModal();
    hideChatHistory();

    // Reset local inputs & attachments to prevent text contamination
    if (messageInput) {
        messageInput.value = '';
        messageInput.style.height = 'auto';
    }
    attachedFiles = [];
    if (typeof renderAttachPreview === 'function') renderAttachPreview();

    if (newChatBtn) {
        newChatBtn.style.opacity = '0.5';
        newChatBtn.style.pointerEvents = 'none';
    }
    showToast(folderPath || newFolderName ? '📂 Switching folder & starting chat...' : '✨ Starting new conversation...');

    currentChatTitle = 'New Conversation';
    if (activeChatTitle) activeChatTitle.textContent = 'New Conversation';

    chatContent.innerHTML = `
        <div class="loading-state">
            <div class="loading-spinner"></div>
            <p>${folderPath || newFolderName ? 'Opening workspace folder...' : 'Creating fresh session...'}</p>
        </div>
    `;

    try {
        const body = {};
        if (folderPath) body.folderPath = folderPath;
        if (newFolderName) body.newFolderName = newFolderName;

        const res = await fetchWithAuth('/new-chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await res.json();

        if (data.success) {
            showToast('✅ New conversation ready');
            setTimeout(loadSnapshot, 500);
            setTimeout(loadSnapshot, 1400);
            setTimeout(checkChatStatus, 1800);
        } else {
            showToast('Failed to start new chat: ' + (data.error || 'Unknown'));
        }
    } catch (e) {
        showToast('New chat error: ' + e.message);
    } finally {
        if (newChatBtn) {
            newChatBtn.style.opacity = '1';
            newChatBtn.style.pointerEvents = 'auto';
        }
        if (messageInput) messageInput.focus();
    }
}

// --- New Chat Logic ---
async function startNewChat() { return confirmStartNewChat(null); }
async function old_startNewChat() {
    newChatBtn.style.opacity = '0.5';
    newChatBtn.style.pointerEvents = 'none';
    showToast('✨ Starting new conversation...');

    // Optimistic UI state
    currentChatTitle = 'New Conversation';
    if (activeChatTitle) activeChatTitle.textContent = 'New Conversation';

    chatContent.innerHTML = `
        <div class="loading-state">
            <div class="loading-spinner"></div>
            <p>Creating fresh session...</p>
        </div>
    `;

    try {
        const res = await fetchWithAuth('/new-chat', { method: 'POST' });
        const data = await res.json();

        if (data.success) {
            showToast('✅ New conversation ready');
            setTimeout(loadSnapshot, 400);
            setTimeout(loadSnapshot, 1200);
            setTimeout(checkChatStatus, 1600);
        } else {
            showToast('Failed to start new chat: ' + (data.error || 'Unknown'));
        }
    } catch (e) {
        showToast('New chat error: ' + e.message);
    } finally {
        newChatBtn.style.opacity = '1';
        newChatBtn.style.pointerEvents = 'auto';
        messageInput.focus();
    }
}



if (newChatBtn) newChatBtn.addEventListener('click', showNewChatModal);

function startNewChatFromHistory() { hideChatHistory(); showNewChatModal(); }
function hideChatHistory() { if (historyLayer) historyLayer.classList.remove('show'); }

// --- Chat History Logic ---
if (historyBtn) historyBtn.addEventListener("click", showChatHistory);
window.showChatHistory = showChatHistory;
window.hideChatHistory = hideChatHistory;
window.startNewChatFromHistory = startNewChatFromHistory;
window.selectChat = selectChat;
window.refreshChatHistory = refreshChatHistory;
window.clearHistorySearch = clearHistorySearch;

async function showChatHistory() {
    historyLayer.classList.add('show');
    if (historySearchInput) {
        historySearchInput.value = '';
        if (clearSearchBtn) clearSearchBtn.style.display = 'none';
    }

    if (cachedConversations.length > 0) {
        renderHistoryList(cachedConversations);
    } else {
        historyList.innerHTML = `
            <div style="padding: 40px 20px; text-align: center; color: var(--text-muted);">
                <div class="loading-spinner" style="margin: 0 auto 12px;"></div>
                <p>Loading conversations...</p>
            </div>
        `;
    }

    refreshChatHistory(false);
}

async function refreshChatHistory(showSpinner = true) {
    const refreshIcon = document.getElementById('historyRefreshBtn');
    if (refreshIcon && showSpinner) {
        refreshIcon.style.transform = 'rotate(360deg)';
        refreshIcon.style.transition = 'transform 0.5s';
        setTimeout(() => { refreshIcon.style.transform = ''; }, 500);
    }

    try {
        const res = await fetchWithAuth('/chat-history');
        const data = await res.json();

        if (data.success && Array.isArray(data.chats)) {
            cachedConversations = data.chats;
            updateConversationBadges(cachedConversations.length);
            renderHistoryList(cachedConversations, historySearchInput?.value || '');
        } else if (cachedConversations.length === 0) {
            historyList.innerHTML = `
                <div style="padding: 40px 20px; text-align: center; color: var(--text-muted);">
                    <div style="font-size: 28px; margin-bottom: 8px;">💬</div>
                    <div style="font-weight: 600; color: #eee; margin-bottom: 4px;">No conversations found</div>
                    <div style="font-size: 13px; opacity: 0.7;">Start a new conversation to begin.</div>
                    <div class="new-chat-card-pinned" onclick="startNewChatFromHistory()" style="margin-top: 16px;">
                        ＋ Start New Conversation
                    </div>
                </div>
            `;
        }
    } catch (e) {
        if (cachedConversations.length === 0) {
            historyList.innerHTML = `
                <div style="padding: 40px 20px; text-align: center; color: var(--text-muted);">
                    <div style="font-size: 24px; margin-bottom: 8px;">⚠️</div>
                    <div style="font-weight: 500;">Connection Error</div>
                    <div style="font-size: 13px; opacity: 0.7; margin-top: 4px;">Could not load history: ${e.message}</div>
                </div>
            `;
        }
    }
}

function updateConversationBadges(count) {
    if (historyCountBadge) {
        historyCountBadge.textContent = count;
        historyCountBadge.style.display = count > 0 ? 'inline-block' : 'none';
    }
    if (drawerCountTag) {
        drawerCountTag.textContent = count;
    }
}

function renderHistoryList(chats, filterText) {
    filterText = filterText || "";
    const query = filterText.trim().toLowerCase();
    const filtered = query
        ? chats.filter(function(c) { return ((c.title || "") + " " + (c.workspace || "")).toLowerCase().includes(query); })
        : chats;

    let html = '<div class="new-chat-card-pinned" onclick="startNewChatFromHistory()"><span>＋ Start New Conversation</span></div>';

    if (filtered.length === 0) {
        html += '<div style="padding: 30px 16px; text-align: center; color: var(--text-muted);"><div style="font-size: 20px; margin-bottom: 6px;">🔍</div><div style="font-size: 13px;">No conversations matching "' + escapeHtml(filterText) + '"</div></div>';
        historyList.innerHTML = html;
        return;
    }

    filtered.forEach(function(chat) {
        const title = chat.title || chat.name || "Untitled";
        const id = chat.id || "";
        const escapedTitle = title.replace(/'/g, "\\x27").replace(/"/g, "&quot;");
        const escapedId = id.replace(/'/g, "\\x27").replace(/"/g, "&quot;");
        const isActive = chat.isSelected || (currentChatTitle && (
            currentChatTitle.toLowerCase() === title.toLowerCase() ||
            title.toLowerCase().startsWith(currentChatTitle.toLowerCase().slice(0, 15))
        ));

        const activeTag = isActive ? '<span class="active-pill-indicator">Active</span>' : "";
        const wsTag = chat.workspace ? '<span class="workspace-pill-tag">' + escapeHtml(chat.workspace) + '</span>' : "";
        const dateTag = '<span>' + escapeHtml(chat.date || "Recent") + '</span>';

        html += '<div class="history-item ' + (isActive ? "active-chat-item" : "") + '" onclick="selectChat(\'' + escapedId + '\', \'' + escapedTitle + '\', this)">' +
            '<div class="history-item-icon">' +
                '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' +
            '</div>' +
            '<div class="history-item-text">' +
                '<div class="history-item-title">' + escapeHtml(title) + '</div>' +
                '<div class="history-item-date">' + activeTag + wsTag + dateTag + '</div>' +
            '</div>' +
        '</div>';
    });

    historyList.innerHTML = html;
}

// History Search Input
if (historySearchInput) {
    historySearchInput.addEventListener("input", function(e) {
        const val = e.target.value;
        if (clearSearchBtn) clearSearchBtn.style.display = val ? "block" : "none";
        renderHistoryList(cachedConversations, val);
    });
}

function clearHistorySearch() {
    if (historySearchInput) historySearchInput.value = "";
    if (clearSearchBtn) clearSearchBtn.style.display = "none";
    renderHistoryList(cachedConversations);
}





async function selectChat(id, title, element) {
    if (element) {
        element.style.opacity = "0.6";
        const icon = element.querySelector(".history-item-icon");
        if (icon) icon.innerHTML = '<div class="loading-spinner" style="width:16px;height:16px;border-width:2px;"></div>';
    }

    currentChatTitle = title;
    if (activeChatTitle) activeChatTitle.textContent = title;

    try {
        const res = await fetchWithAuth("/select-chat", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: id, title: title })
        });
        const data = await res.json();

        if (data.success) {
            hideChatHistory();
            showToast("Switched to: " + title);
            chatContent.innerHTML = '<div class="loading-state"><div class="loading-spinner"></div><p>Loading ' + escapeHtml(title) + '...</p></div>';
            setTimeout(loadSnapshot, 300);
            setTimeout(loadSnapshot, 800);
            setTimeout(loadSnapshot, 1500);
        } else {
            showToast("Could not switch: " + (data.error || "Unknown error"));
        }
    } catch (e) {
        showToast("Select chat error: " + e.message);
    }
}

// --- Restart IDE & Reconnect Modals ---
function showRestartModal() {
    if (restartModalOverlay) restartModalOverlay.classList.add('show');
}

function closeRestartModal() {
    if (restartModalOverlay) restartModalOverlay.classList.remove('show');
}

if (refreshBtn) refreshBtn.addEventListener('click', showRestartModal);

if (restartModalOverlay) {
    restartModalOverlay.onclick = (e) => {
        if (e.target === restartModalOverlay) closeRestartModal();
    };
}

async function confirmRestartIDE() {
    closeRestartModal();
    if (restartProgressOverlay) restartProgressOverlay.style.display = 'flex';

    let secondsLeft = 12;
    if (restartCountdownVal) restartCountdownVal.textContent = `⏳ ${secondsLeft}s`;

    const stepKill = document.getElementById('stepKill');
    const stepLaunch = document.getElementById('stepLaunch');
    const stepDiscover = document.getElementById('stepDiscover');
    const stepConnect = document.getElementById('stepConnect');

    if (stepKill) stepKill.className = 'restart-step-item active';
    if (stepLaunch) stepLaunch.className = 'restart-step-item';
    if (stepDiscover) stepDiscover.className = 'restart-step-item';
    if (stepConnect) stepConnect.className = 'restart-step-item';

    try {
        await fetchWithAuth('/restart-ide', { method: 'POST' });
    } catch (e) {
        console.warn('Restart trigger error:', e.message);
    }

    const timer = setInterval(() => {
        secondsLeft--;
        if (restartCountdownVal) restartCountdownVal.textContent = `⏳ ${secondsLeft}s`;

        if (secondsLeft === 9) {
            if (stepKill) stepKill.className = 'restart-step-item done';
            if (stepLaunch) stepLaunch.className = 'restart-step-item active';
        } else if (secondsLeft === 6) {
            if (stepLaunch) stepLaunch.className = 'restart-step-item done';
            if (stepDiscover) stepDiscover.className = 'restart-step-item active';
        } else if (secondsLeft === 3) {
            if (stepDiscover) stepDiscover.className = 'restart-step-item done';
            if (stepConnect) stepConnect.className = 'restart-step-item active';
        }

        if (secondsLeft <= 0) {
            clearInterval(timer);
            if (stepConnect) stepConnect.className = 'restart-step-item done';
            if (restartProgressOverlay) restartProgressOverlay.style.display = 'none';
            showToast('✅ IDE restart complete');
            loadSnapshot();
            fetchAppState();
        }
    }, 1000);
}

async function executeQuickReconnect() {
    closeRestartModal();
    showToast('⏳ Reconnecting DevTools CDP...');

    try {
        const res = await fetchWithAuth('/reconnect-cdp', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast('✅ CDP Reconnected successfully');
            loadSnapshot();
            fetchAppState();
        } else {
            showToast('Reconnect failed: ' + (data.error || 'Not found'));
        }
    } catch (e) {
        showToast('Reconnect error: ' + e.message);
    }
}

// --- Empty State ---
function showEmptyState() {
    chatContent.innerHTML = `
        <div class="loading-state">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="color: var(--text-muted); opacity: 0.6; margin-bottom: 8px;">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
            </svg>
            <h2 style="font-size: 16px; color: #f1f5f9; margin-bottom: 6px;">No Conversation Open</h2>
            <p style="font-size: 13px; color: var(--text-muted); max-width: 260px; line-height: 1.4; margin-bottom: 16px;">
                Start a fresh conversation or pick one from history to chat with the agent.
            </p>
            <button class="new-chat-btn" onclick="startNewChat()" style="padding: 8px 18px; font-size: 13px;">
                ＋ Start New Conversation
            </button>
        </div>
    `;
}

function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// --- Quick Actions ---
function quickAction(text) {
    messageInput.value = text;
    messageInput.style.height = 'auto';
    messageInput.style.height = messageInput.scrollHeight + 'px';
    messageInput.focus();
}

// --- Stop Button Logic ---
async function handleStopAction() {
    if (stopBtn) {
        stopBtn.style.opacity = '0.5';
        stopBtn.disabled = true;
    }
    if (stopBarBtn) {
        stopBarBtn.style.opacity = '0.5';
        stopBarBtn.disabled = true;
    }
    showToast('■ Stopping generation and clearing queue...');
    try {
        const res = await fetchWithAuth('/stop', { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            const queueMsg = data.clearedQueue ? ` (${data.clearedQueue} queued msg cleared)` : '';
            showToast(`■ Agent stopped${queueMsg}`);
            updateQueueUI([]);
            updateAgentBusyState(false);
            setTimeout(loadSnapshot, 300);
            setTimeout(loadSnapshot, 1000);
        } else {
            showToast('Stop: ' + (data.error || 'No active generation found'));
        }
    } catch (e) {
        showToast('Failed to stop: ' + e.message);
    } finally {
        setTimeout(() => {
            if (stopBtn) {
                stopBtn.style.opacity = '1';
                stopBtn.disabled = false;
            }
            if (stopBarBtn) {
                stopBarBtn.style.opacity = '1';
                stopBarBtn.disabled = false;
            }
        }, 400);
    }
}

if (stopBtn) stopBtn.addEventListener('click', handleStopAction);
if (stopBarBtn) stopBarBtn.addEventListener('click', handleStopAction);

// Check chat status
async function checkChatStatus() {
    try {
        const res = await fetchWithAuth('/chat-status');
        const data = await res.json();
        chatIsOpen = data.hasChat || data.editorFound;
        if (!chatIsOpen) showEmptyState();
    } catch (e) { }
}

// Prefetch conversations count on boot
async function prefetchHistory() {
    try {
        const res = await fetchWithAuth('/chat-history');
        const data = await res.json();
        if (data.success && Array.isArray(data.chats)) {
            cachedConversations = data.chats;
            updateConversationBadges(cachedConversations.length);
        }
    } catch (e) { }
}

// --- Init ---
connectWebSocket();
fetchAppState();
setInterval(fetchAppState, 5000);
checkChatStatus();
prefetchHistory();

// --- Interactive Expandable Tool Tabs, Thoughts & Artifact Cards ---
if (chatContent) {
    chatContent.addEventListener('click', async (e) => {
        // 1. Locate interactive trigger container
        const thoughtBtn = e.target.closest('button:has(span.text-secondary-foreground), button.tabular-nums, button:has(svg), div.relative > button');
        const workedForBtn = e.target.closest('button[data-testid="worked-for-collapsible"], button[class*="tabular-nums"]');
        const artifactCard = e.target.closest('.artifact-card, div.border.rounded-xl, div:has(> button[draggable="true"])');
        const toolRow = e.target.closest('div.group.cursor-pointer, div[role="button"], button');

        let targetEl = thoughtBtn || workedForBtn || artifactCard || toolRow;

        // If not found directly, check text content of target or its closest ancestors
        if (!targetEl) {
            const candidate = e.target.closest('div, span, p, button');
            if (candidate) {
                const txt = (candidate.innerText || candidate.textContent || '').trim();
                if (/^(Thought|Thinking|Worked for|Ran\b|Explored\b|Running\b)/i.test(txt)) {
                    targetEl = candidate;
                }
            }
        }

        if (!targetEl) return;

        // Extract useful identifiers
        const rawText = (targetEl.innerText || targetEl.textContent || '').trim();
        const firstLine = rawText.split('\n')[0].trim();
        const testId = targetEl.getAttribute('data-testid') || (targetEl.querySelector('[data-testid]')?.getAttribute('data-testid')) || '';
        const ariaLabel = targetEl.getAttribute('aria-label') || '';
        const tagName = targetEl.tagName.toLowerCase();

        // Only handle clicks on relevant collapsible/tool/thought/artifact elements
        const isThought = /Thought|Thinking/i.test(firstLine);
        const isWorkedFor = /Worked for/i.test(firstLine) || testId === 'worked-for-collapsible';
        const isTool = /^(Ran|Explored|Running|Run)\b/i.test(firstLine);
        const isArtifact = targetEl.closest('.artifact-card, div.border.rounded-xl') !== null;

        if (!isThought && !isWorkedFor && !isTool && !isArtifact && !testId) {
            return; // Not an interactive chat toggle
        }

        e.preventDefault();
        e.stopPropagation();

        // Visual tactile feedback
        targetEl.style.opacity = '0.6';
        targetEl.style.transform = 'scale(0.98)';
        setTimeout(() => {
            targetEl.style.opacity = '1';
            targetEl.style.transform = '';
        }, 180);

        // Find index among elements with similar firstLine
        let matchIndex = 0;
        try {
            const allMatching = Array.from(chatContent.querySelectorAll(tagName))
                .filter(el => {
                    const t = (el.innerText || el.textContent || '').trim().split('\n')[0].trim();
                    return t && (t === firstLine || t.includes(firstLine) || firstLine.includes(t));
                });
            const idx = allMatching.indexOf(targetEl);
            if (idx >= 0) matchIndex = idx;
        } catch (e) {}

        try {
            await fetchWithAuth('/remote-click', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    testId: testId || undefined,
                    ariaLabel: ariaLabel || undefined,
                    tagName: tagName,
                    textContent: firstLine,
                    index: matchIndex
                })
            });

            // Fast refresh snapshots so user sees expanded/collapsed state immediately
            setTimeout(loadSnapshot, 150);
            setTimeout(loadSnapshot, 400);
            setTimeout(loadSnapshot, 800);
        } catch (err) {
            console.warn('Remote click error:', err);
        }
    });
}
