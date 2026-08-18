#!/usr/bin/env node
import 'dotenv/config';
import express from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { WebSocketServer } from 'ws';
import http from 'http';
import https from 'https';
import fs from 'fs';
import os from 'os';
import WebSocket from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join, basename } from 'path';
import { inspectUI } from './ui_inspector.js';
import { execSync, spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORTS = [9222, 9022, 9000, 9001, 9002, 9003];
const HEALTH_CHECK_INTERVAL = 30000; // 30s health check (reduced CDP load)
const FALLBACK_SNAPSHOT_INTERVAL = 30000; // 30s fallback check
const PUSH_FETCH_THROTTLE = 2000; // 2s throttle between snapshot broadcasts
const SERVER_PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || 'antigravity';
const AUTH_COOKIE_NAME = 'ag_auth_token';
let AUTH_TOKEN = 'ag_default_token';
let globalWss = null;

// Shared CDP connection
let cdpConnection = null;
let cdpKeepAliveTimer = null;
let reconnectAttempts = 0;
const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 30000;
let lastSnapshot = null;
let lastSnapshotHash = null;

// Performance: cache the winning context ID so we don't loop all contexts
let cachedSnapshotCtxId = null;
let cachedCascadeCtxId = null; // Cache for injectMessage cascade context
// Performance: cache CSS separately (stylesheets rarely change)
let cachedCSS = null;
let lastCSSRefresh = 0;
const CSS_CACHE_TTL = 120000; // refresh CSS every 120 seconds
const CSS_MAX_SIZE = 200000; // Cap CSS at 200KB to prevent phone stalling

// Push-based observer state
let observerInjected = false;
let lastPushTime = 0;
let lastPushFetchTime = 0; // When we last fetched a snapshot in response to a push signal
let pendingPushFetch = false; // Whether a throttled push fetch is scheduled

// Message queue — holds messages when agent is busy (terminal running)
const messageQueue = [];
const MAX_QUEUED_MESSAGES = 10;
let isProcessingQueue = false;

function broadcastQueueUpdate(wss) {
    const targetWss = wss || globalWss;
    if (!targetWss) return;
    const payload = JSON.stringify({
        type: 'queue_update',
        count: messageQueue.length,
        items: messageQueue.map(m => ({
            id: m.id,
            text: m.text,
            timestamp: m.timestamp,
            attempts: m.attempts || 0
        }))
    });
    for (const client of targetWss.clients) {
        if (client.readyState === 1) { // WebSocket.OPEN
            try { client.send(payload); } catch (e) { }
        }
    }
}

// Kill any existing process on the server port (prevents EADDRINUSE)
function killPortProcess(port) {
    try {
        if (process.platform === 'win32') {
            // Windows: Find PID using netstat and kill it
            const result = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
            const lines = result.trim().split('\n');
            const pids = new Set();
            for (const line of lines) {
                const parts = line.trim().split(/\s+/);
                const pid = parts[parts.length - 1];
                if (pid && pid !== '0') pids.add(pid);
            }
            for (const pid of pids) {
                try {
                    execSync(`taskkill /PID ${pid} /F`, { stdio: 'pipe' });
                    console.log(`⚠️  Killed existing process on port ${port} (PID: ${pid})`);
                } catch (e) { /* Process may have already exited */ }
            }
        } else {
            // Linux/macOS: Use lsof and kill
            const result = execSync(`lsof -ti:${port}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
            const pids = result.trim().split('\n').filter(p => p && p.trim() !== String(process.pid));
            for (const pid of pids) {
                try {
                    execSync(`kill -9 ${pid}`, { stdio: 'pipe' });
                    console.log(`⚠️  Killed existing process on port ${port} (PID: ${pid})`);
                } catch (e) { /* Process may have already exited */ }
            }
        }
        // Small delay to let the port be released
        return new Promise(resolve => setTimeout(resolve, 500));
    } catch (e) {
        // No process found on port - this is fine
        return Promise.resolve();
    }
}

// Get local IP address for mobile access
// Prefers real network IPs (192.168.x.x, 10.x.x.x) over virtual adapters (172.x.x.x from WSL/Docker)
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    const candidates = [];

    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            // Skip internal and non-IPv4 addresses
            if (iface.family === 'IPv4' && !iface.internal) {
                candidates.push({
                    address: iface.address,
                    name: name,
                    // Prioritize common home/office network ranges
                    priority: iface.address.startsWith('192.168.') ? 1 :
                        iface.address.startsWith('10.') ? 2 :
                            iface.address.startsWith('172.') ? 3 : 4
                });
            }
        }
    }

    // Sort by priority and return the best one
    candidates.sort((a, b) => a.priority - b.priority);
    return candidates.length > 0 ? candidates[0].address : 'localhost';
}

// Helper: HTTP GET JSON with timeout
function getJson(url, timeoutMs = 2500) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.setTimeout(timeoutMs, () => {
            req.destroy(new Error(`Timeout after ${timeoutMs}ms connecting to ${url}`));
        });
    });
}

// Find Antigravity CDP endpoint (Fast Parallel Discovery)
async function discoverCDP() {
    const checkPort = async (port) => {
        try {
            const list = await getJson(`http://127.0.0.1:${port}/json/list`, 1000);
            if (!Array.isArray(list)) return null;

            // Filter out self/3000 pages to avoid loopback
            const validList = list.filter(t => {
                const url = (t.url || "").toLowerCase();
                const title = (t.title || "").toLowerCase();
                if (url.includes(":3000") || title.includes("phone connect") || title.includes("gravityremote")) return false;
                return true;
            });

            // Priority 1: Standard Workbench (The main IDE window)
            const workbench = validList.find(t => t.url?.includes("workbench.html") || (t.title && (t.title.includes("workbench") || t.title.includes("Antigravity IDE"))));
            if (workbench && workbench.webSocketDebuggerUrl) {
                return { priority: 1, port, url: workbench.webSocketDebuggerUrl, title: workbench.title };
            }

            // Priority 2: Jetski/Launchpad (Fallback)
            const jetski = validList.find(t => t.url?.includes("jetski") || t.title === "Launchpad");
            if (jetski && jetski.webSocketDebuggerUrl) {
                return { priority: 2, port, url: jetski.webSocketDebuggerUrl, title: jetski.title };
            }

            // Priority 3: Any other valid page
            const page = validList.find(t => t.type === "page" && t.webSocketDebuggerUrl);
            if (page) {
                return { priority: 3, port, url: page.webSocketDebuggerUrl, title: page.title };
            }
            return null;
        } catch (e) {
            return null;
        }
    };

    const results = await Promise.all(PORTS.map(checkPort));
    const valid = results.filter(Boolean).sort((a, b) => a.priority - b.priority);

    if (valid.length > 0) {
        console.log(`Found target on port ${valid[0].port}:`, valid[0].title);
        return { port: valid[0].port, url: valid[0].url };
    }

    throw new Error('CDP endpoint not found on any monitored port');
}

// Connect to CDP
async function connectCDP(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
    });

    let idCounter = 1;
    const pendingCalls = new Map();
    const contexts = [];
    const CDP_CALL_TIMEOUT = 8000; // 8s timeout

    // The CDP object we'll return (need reference for callbacks)
    const cdpObj = { ws, call: null, contexts, onPush: null };

    // --- WebSocket close/error handlers for immediate reconnect ---
    ws.on('close', (code, reason) => {
        console.log(`🔌 CDP WebSocket closed (code: ${code}, reason: ${reason || 'none'})`);
        if (cdpConnection === cdpObj) {
            cdpConnection = null;
            observerInjected = false;
            cachedSnapshotCtxId = null;
        }
        stopCdpKeepAlive();
    });

    ws.on('error', (err) => {
        console.error(`❌ CDP WebSocket error: ${err.message}`);
        // 'close' event will fire after this, which handles cleanup
    });

    // --- Keepalive: ping every 15s, detect dead sockets ---
    startCdpKeepAlive(ws);

    // Single centralized message handler
    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);

            // Handle CDP method responses
            if (data.id !== undefined && pendingCalls.has(data.id)) {
                const { resolve, reject, timeoutId } = pendingCalls.get(data.id);
                clearTimeout(timeoutId);
                pendingCalls.delete(data.id);
                if (data.error) reject(data.error);
                else resolve(data.result);
            }

            // Handle push snapshots from injected MutationObserver
            if (data.method === 'Runtime.bindingCalled' && data.params?.name === 'agPushSnapshot') {
                try {
                    const payload = JSON.parse(data.params.payload);
                    if (cdpObj.onPush) cdpObj.onPush(payload);
                } catch (e) { }
            }

            // Handle execution context events
            if (data.method === 'Runtime.executionContextCreated') {
                contexts.push(data.params.context);
            } else if (data.method === 'Runtime.executionContextDestroyed') {
                const id = data.params.executionContextId;
                const idx = contexts.findIndex(c => c.id === id);
                if (idx !== -1) contexts.splice(idx, 1);
            } else if (data.method === 'Runtime.executionContextsCleared') {
                contexts.length = 0;
                observerInjected = false; // Observer lost — needs re-injection
                cachedSnapshotCtxId = null;
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ id: idCounter++, method: 'Runtime.enable', params: {} }));
                    // Re-register binding after context clear
                    ws.send(JSON.stringify({ id: idCounter++, method: 'Runtime.addBinding', params: { name: 'agPushSnapshot' } }));
                }
            }
        } catch (e) { }
    });

    const call = (method, params) => new Promise((resolve, reject) => {
        if (ws.readyState !== WebSocket.OPEN) {
            return reject(new Error(`CDP WebSocket not open (state: ${ws.readyState})`));
        }
        const id = idCounter++;
        const timeoutId = setTimeout(() => {
            if (pendingCalls.has(id)) {
                pendingCalls.delete(id);
                reject(new Error(`CDP call ${method} timed out after ${CDP_CALL_TIMEOUT}ms`));
            }
        }, CDP_CALL_TIMEOUT);
        pendingCalls.set(id, { resolve, reject, timeoutId });
        ws.send(JSON.stringify({ id, method, params }));
    });

    cdpObj.call = call;

    await call("Runtime.enable", {});
    // Register the push binding so injected scripts can call window.agPushSnapshot()
    try {
        await call("Runtime.addBinding", { name: 'agPushSnapshot' });
    } catch (e) {
        console.warn('⚠️  Runtime.addBinding not supported, falling back to polling');
    }
    await new Promise(r => setTimeout(r, 1000));

    return cdpObj;
}

// --- CDP WebSocket keepalive ---
function startCdpKeepAlive(ws) {
    stopCdpKeepAlive();
    let pongReceived = true;

    ws.on('pong', () => { pongReceived = true; });

    cdpKeepAliveTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) {
            stopCdpKeepAlive();
            return;
        }
        if (!pongReceived) {
            console.warn('💀 CDP keepalive: no pong received, terminating dead socket');
            ws.terminate(); // Force-close — triggers 'close' event
            stopCdpKeepAlive();
            return;
        }
        pongReceived = false;
        ws.ping();
    }, 15000); // Ping every 15s
}

function stopCdpKeepAlive() {
    if (cdpKeepAliveTimer) {
        clearInterval(cdpKeepAliveTimer);
        cdpKeepAliveTimer = null;
    }
}

// --- Proactive CDP reconnection helper ---
// Call this from endpoints instead of returning 503 immediately.
// Attempts a quick reconnect before giving up.
let _ensureCdpPromise = null;
async function ensureCDP() {
    if (cdpConnection && cdpConnection.ws?.readyState === WebSocket.OPEN) {
        return true; // Already connected
    }
    // Avoid multiple concurrent reconnection attempts
    if (_ensureCdpPromise) return _ensureCdpPromise;

    _ensureCdpPromise = (async () => {
        console.log('🔄 ensureCDP: attempting quick reconnect...');
        try {
            await initCDP();
            if (cdpConnection) {
                console.log('✅ ensureCDP: reconnected!');
                reconnectAttempts = 0;
                observerInjected = false;
                if (globalWss) {
                    wirePushHandler(globalWss);
                }
                injectObserver(cdpConnection).catch(() => {});
                return true;
            }
        } catch (e) {
            console.warn(`⚠️ ensureCDP: reconnect failed: ${e.message}`);
        }
        return false;
    })();

    try {
        return await _ensureCdpPromise;
    } finally {
        _ensureCdpPromise = null;
    }
}

// Lightweight "is agent busy?" probe — checks cancel buttons and active state
// Returns true if agent is busy (cancel button visible), false if idle
async function isAgentBusy(cdp) {
    if (!cdp || cdp.ws?.readyState !== WebSocket.OPEN) return true;

    const PROBE_SCRIPT = `(() => {
        const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]') ||
                       document.querySelector('button[aria-label*="Cancel" i]') ||
                       document.querySelector('button[aria-label*="Stop" i]') ||
                       document.querySelector('button[title*="Cancel" i]') ||
                       document.querySelector('button[title*="Stop" i]') ||
                       document.querySelector('button svg.lucide-square')?.closest('button') ||
                       document.querySelector('button .bg-red-500')?.closest('button') ||
                       document.querySelector('button svg.lucide-stop-circle')?.closest('button') ||
                       document.querySelector('button svg.lucide-circle-stop')?.closest('button');
        if (cancel && cancel.offsetParent !== null) return "busy";

        const editor = document.querySelector('div[contenteditable="true"][role="combobox"]') ||
                       document.querySelector('div[contenteditable="true"][aria-label="Message input"]') ||
                       document.querySelector('[data-lexical-editor="true"][contenteditable="true"]') ||
                       document.querySelector('div[contenteditable="true"][role="textbox"]') ||
                       document.querySelector('div[contenteditable="true"]');
        if (editor && editor.offsetParent !== null) return "idle";
        return "unknown";
    })()`;

    // Try default context first
    try {
        const res = await Promise.race([
            cdp.call("Runtime.evaluate", {
                expression: PROBE_SCRIPT,
                returnByValue: true
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1200))
        ]);
        const val = res.result?.value;
        if (val === "busy") return true;
        if (val === "idle") return false;
    } catch (e) { }

    // Try tracked contexts
    const ctxIds = [];
    if (cachedCascadeCtxId && cdp.contexts.some(c => c.id === cachedCascadeCtxId)) {
        ctxIds.push(cachedCascadeCtxId);
    }
    for (const ctx of cdp.contexts) {
        if (ctx.origin?.includes("extension") || ctx.name?.includes("worker")) continue;
        if (!ctxIds.includes(ctx.id)) ctxIds.push(ctx.id);
        if (ctxIds.length >= 3) break;
    }

    for (const ctxId of ctxIds) {
        try {
            const result = await Promise.race([
                cdp.call("Runtime.evaluate", {
                    expression: PROBE_SCRIPT,
                    returnByValue: true,
                    contextId: ctxId
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1200))
            ]);
            const val = result.result?.value;
            if (val === "busy") return true;
            if (val === "idle") return false;
        } catch (e) { }
    }
    return false;
}

// Lightweight pre-check: just get innerHTML length + scroll position without cloning DOM
const LIGHT_CHECK_SCRIPT = `(() => {
    const cascade = document.getElementById('conversation') || document.getElementById('chat') || document.getElementById('cascade');
    if (!cascade) return null;
    const scrollContainer = cascade.querySelector('.overflow-y-auto, [data-scroll-area]') || cascade;
    return {
        len: cascade.innerHTML.length,
        scrollTop: scrollContainer.scrollTop,
        scrollHeight: scrollContainer.scrollHeight,
        childCount: cascade.children.length
    };
})()`;

// CSS-only extraction (run infrequently)
const CSS_EXTRACT_SCRIPT = `(() => {
    const rules = [];
    let totalSize = 0;
    const MAX_CSS = 200000; // 200KB cap
    const seen = new Set();
    for (const sheet of document.styleSheets) {
        try {
            for (const rule of sheet.cssRules) {
                const text = rule.cssText;
                // Deduplicate and skip huge rules
                if (text.length > 5000) continue;
                if (seen.has(text)) continue;
                seen.add(text);
                totalSize += text.length;
                if (totalSize > MAX_CSS) break;
                rules.push(text);
            }
        } catch (e) { }
        if (totalSize > MAX_CSS) break;
    }
    return rules.join('\\n');
})()`;

let lastLightCheck = null; // {len, scrollTop, scrollHeight, childCount}

// Capture chat snapshot
async function captureSnapshot(cdp) {
    // Wait for contexts to be available (they may be briefly empty after executionContextsCleared)
    if (cdp.contexts.length === 0) {
        for (let wait = 0; wait < 3; wait++) {
            await new Promise(r => setTimeout(r, 500));
            if (cdp.contexts.length > 0) break;
        }
        if (cdp.contexts.length === 0) return null;
    }

    // --- Step 1: Resolve which context to use (cached or scan) ---
    let targetCtxId = null;

    // Try cached context first
    if (cachedSnapshotCtxId && cdp.contexts.some(c => c.id === cachedSnapshotCtxId)) {
        targetCtxId = cachedSnapshotCtxId;
    } else {
        // Scan all contexts to find the right one (lightweight check)
        cachedSnapshotCtxId = null;
        const sortedContexts = [...cdp.contexts].sort((a, b) => {
            const aDef = (a.auxData?.isDefault || a.id === 1) ? 1 : 0;
            const bDef = (b.auxData?.isDefault || b.id === 1) ? 1 : 0;
            return bDef - aDef;
        });
        for (const ctx of sortedContexts) {
            try {
                const probe = await cdp.call("Runtime.evaluate", {
                    expression: LIGHT_CHECK_SCRIPT,
                    returnByValue: true,
                    contextId: ctx.id
                });
                if (probe.result?.value && probe.result.value.len > 0) {
                    targetCtxId = ctx.id;
                    cachedSnapshotCtxId = ctx.id;
                    break;
                }
            } catch (e) { }
        }
        if (!targetCtxId) return null;
    }

    // --- Step 2: Lightweight change detection (avoids heavy DOM clone if nothing changed) ---
    try {
        const lightRes = await cdp.call("Runtime.evaluate", {
            expression: LIGHT_CHECK_SCRIPT,
            returnByValue: true,
            contextId: targetCtxId
        });
        const light = lightRes.result?.value;
        if (!light) {
            // Context went stale, invalidate cache
            cachedSnapshotCtxId = null;
            return null;
        }

        // If nothing changed since last check, skip the heavy snapshot entirely
        if (lastLightCheck && lastSnapshot &&
            light.len === lastLightCheck.len &&
            light.childCount === lastLightCheck.childCount &&
            light.scrollHeight === lastLightCheck.scrollHeight) {
            // Content same — just update scroll position if it changed
            if (light.scrollTop !== lastLightCheck.scrollTop && lastSnapshot.scrollInfo) {
                lastSnapshot.scrollInfo.scrollTop = light.scrollTop;
                lastSnapshot.scrollInfo.scrollPercent = light.scrollTop / (light.scrollHeight - (lastSnapshot.scrollInfo.clientHeight || 1)) || 0;
            }
            lastLightCheck = light;
            return '__unchanged__'; // sentinel: tells poll loop to skip broadcast
        }
        lastLightCheck = light;
    } catch (e) {
        cachedSnapshotCtxId = null;
        return null;
    }

    // --- Step 3: Full snapshot (only runs when content actually changed) ---
    const CAPTURE_SCRIPT = `(() => {
        const cascade = document.getElementById('conversation') || document.getElementById('chat') || document.getElementById('cascade');
        if (!cascade) {
            const body = document.body;
            const childIds = Array.from(body.children).map(c => c.id).filter(id => id).join(', ');
            return { error: 'chat container not found', debug: { hasBody: !!body, availableIds: childIds } };
        }
        
        const cascadeStyles = window.getComputedStyle(cascade);
        
        const scrollContainer = cascade.querySelector('.overflow-y-auto, [data-scroll-area]') || cascade;
        const scrollInfo = {
            scrollTop: scrollContainer.scrollTop,
            scrollHeight: scrollContainer.scrollHeight,
            clientHeight: scrollContainer.clientHeight,
            scrollPercent: scrollContainer.scrollTop / (scrollContainer.scrollHeight - scrollContainer.clientHeight) || 0
        };
        
        // --- Trim old messages to save phone RAM ---
        // Keep only the last ~50 message blocks (inside the actual scroll container)
        const clone = cascade.cloneNode(true);
        const scrollContainerClone = clone.querySelector('.overflow-y-auto, [data-scroll-area]') || clone;
        const msgContainer = scrollContainerClone.firstElementChild ? scrollContainerClone : scrollContainerClone;
        
        const MAX_CHILDREN = 50;
        const children = Array.from(msgContainer.children);
        if (children.length > MAX_CHILDREN) {
            const toRemove = children.length - MAX_CHILDREN;
            for (let i = 0; i < toRemove; i++) {
                msgContainer.removeChild(children[i]);
            }
            // Add a small indicator that older messages were trimmed
            const trimNote = document.createElement('div');
            trimNote.style.cssText = 'text-align:center;padding:8px;color:#666;font-size:12px;border-bottom:1px solid #333;margin-bottom:8px;';
            trimNote.textContent = '⬆ ' + toRemove + ' earlier messages not shown (scroll on desktop to see)';
            msgContainer.insertBefore(trimNote, msgContainer.firstChild);
        }
        
        try {
            const interactionSelectors = [
                '.relative.flex.flex-col.gap-8',
                '.flex.grow.flex-col.justify-start.gap-8',
                'div[class*="interaction-area"]',
                '.p-1.bg-gray-500\\/10',
                '.outline-solid.justify-between',
                '[contenteditable="true"]'
            ];

            interactionSelectors.forEach(selector => {
                clone.querySelectorAll(selector).forEach(el => {
                    try {
                        if (selector === '[contenteditable="true"]') {
                            const area = el.closest('.relative.flex.flex-col.gap-8') || 
                                         el.closest('.flex.grow.flex-col.justify-start.gap-8') ||
                                         el.closest('div[id^="interaction"]') ||
                                         el.parentElement?.parentElement;
                            if (area && area !== clone) area.remove();
                            else el.remove();
                        } else {
                            el.remove();
                        }
                    } catch(e) {}
                });
            });

            const allElements = clone.querySelectorAll('*');
            allElements.forEach(el => {
                try {
                    const text = (el.innerText || '').toLowerCase();
                    if (text.includes('review changes') || text.includes('files with changes') || text.includes('context found')) {
                        if (el.children.length < 10 || el.querySelector('button') || el.classList?.contains('justify-between')) {
                            el.style.display = 'none';
                            el.remove();
                        }
                    }
                } catch (e) {}
            });
        } catch (globalErr) { }
        
        clone.querySelectorAll('[style*="container-type"]').forEach(el => {
            el.style.containerType = 'normal';
        });
        clone.querySelectorAll('.overflow-hidden, .overflow-y-hidden, .overflow-y-auto').forEach(el => {
            el.style.overflow = 'visible';
            el.style.height = 'auto';
        });
        const html = clone.outerHTML;
        
        return {
            html: html,
            backgroundColor: cascadeStyles.backgroundColor,
            color: cascadeStyles.color,
            fontFamily: cascadeStyles.fontFamily,
            scrollInfo: scrollInfo,
            stats: {
                nodes: clone.getElementsByTagName('*').length,
                htmlSize: html.length
            }
        };
    })()`;

    try {
        const result = await cdp.call("Runtime.evaluate", {
            expression: CAPTURE_SCRIPT,
            returnByValue: true,
            contextId: targetCtxId
        });

        if (result.exceptionDetails) {
            cachedSnapshotCtxId = null;
            return null;
        }

        if (result.result?.value) {
            const val = result.result.value;
            if (val.error) {
                cachedSnapshotCtxId = null;
                return val; // pass error through
            }

            // --- Step 4: Attach CSS (from cache or fresh) ---
            const now = Date.now();
            if (!cachedCSS || (now - lastCSSRefresh) > CSS_CACHE_TTL) {
                try {
                    const cssRes = await cdp.call("Runtime.evaluate", {
                        expression: CSS_EXTRACT_SCRIPT,
                        returnByValue: true,
                        contextId: targetCtxId
                    });
                    if (cssRes.result?.value) {
                        cachedCSS = cssRes.result.value;
                        lastCSSRefresh = now;
                    }
                } catch (e) { /* keep old cache */ }
            }
            val.css = cachedCSS || '';
            if (val.stats) val.stats.cssSize = val.css.length;

            return val;
        }
    } catch (e) {
        console.log(`Snapshot context ${targetCtxId} error:`, e.message);
        cachedSnapshotCtxId = null;
    }

    return null;
}

// Inject message into Antigravity — routes through Agent Mode (Ctrl+E)
// Heavily optimized: cached context, 2s timeouts, 12s overall limit
async function injectMessage(cdp, text) {
    return Promise.race([
        _injectMessageInner(cdp, text),
        new Promise(resolve => setTimeout(() => resolve({ ok: false, error: 'inject_timeout_12s' }), 12000))
    ]);
}

async function _injectMessageInner(cdp, text) {
    let cascadeCtxId = undefined;

    const FIND_EDITOR_EXPR = `(() => {
        const editor = document.querySelector('div[contenteditable="true"][role="combobox"]') ||
                       document.querySelector('div[contenteditable="true"][aria-label="Message input"]') ||
                       document.querySelector('[data-lexical-editor="true"][contenteditable="true"]') ||
                       document.querySelector('div[contenteditable="true"][role="textbox"]') ||
                       document.querySelector('div[contenteditable="true"]');
        if (editor && editor.offsetParent !== null) return "found";
        return "not_found";
    })()`;

    // 1. Check candidate contexts in priority order
    const candidateCtxIds = [];
    if (cachedCascadeCtxId !== null && cachedCascadeCtxId !== undefined && cdp.contexts.some(c => c.id === cachedCascadeCtxId)) {
        candidateCtxIds.push(cachedCascadeCtxId);
    }
    if (cachedSnapshotCtxId !== null && cachedSnapshotCtxId !== undefined && cdp.contexts.some(c => c.id === cachedSnapshotCtxId) && !candidateCtxIds.includes(cachedSnapshotCtxId)) {
        candidateCtxIds.push(cachedSnapshotCtxId);
    }
    candidateCtxIds.push(null); // default context
    for (const ctx of cdp.contexts) {
        if (ctx.origin?.includes("extension") || ctx.name?.includes("worker")) continue;
        if (!candidateCtxIds.includes(ctx.id)) candidateCtxIds.push(ctx.id);
    }

    for (const ctxId of candidateCtxIds) {
        try {
            const probeParams = { expression: FIND_EDITOR_EXPR, returnByValue: true };
            if (ctxId !== null) probeParams.contextId = ctxId;
            const probe = await Promise.race([
                cdp.call("Runtime.evaluate", probeParams),
                new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 1200))
            ]);
            if (probe.result?.value === "found") {
                cascadeCtxId = ctxId;
                if (ctxId !== null) cachedCascadeCtxId = ctxId;
                break;
            }
        } catch (e) { }
    }

    // 3. Focus editor and thoroughly clear previous text (multi-layer clean)
    const focusParams = {
        expression: `(() => {
            let editor = document.querySelector('div[contenteditable="true"][role="combobox"]') ||
                         document.querySelector('div[contenteditable="true"][aria-label="Message input"]') ||
                         document.querySelector('[data-lexical-editor="true"][contenteditable="true"]') ||
                         document.querySelector('div[contenteditable="true"][role="textbox"]') ||
                         document.querySelector('div[contenteditable="true"]');
            if (!editor) {
                const cascadePanel = document.querySelector('#conversation, #chat, #cascade');
                if (cascadePanel) {
                    const editables = [...cascadePanel.querySelectorAll('[contenteditable="true"]')]
                        .filter(el => el.offsetParent !== null);
                    editor = editables.at(-1);
                }
            }
            if (!editor) return { ok: false, error: "editor_not_found" };
            editor.focus();
            try {
                const sel = window.getSelection();
                if (sel) {
                    sel.removeAllRanges();
                    const range = document.createRange();
                    range.selectNodeContents(editor);
                    sel.addRange(range);
                }
            } catch(e) {}
            return { ok: true };
        })()`,
        returnByValue: true
    };
    if (cascadeCtxId) focusParams.contextId = cascadeCtxId;

    try {
        const focusResult = await Promise.race([
            cdp.call("Runtime.evaluate", focusParams),
            new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000))
        ]);

        if (focusResult.result?.value?.ok === false) {
            return { ok: false, error: focusResult.result.value.error || "focus_failed" };
        }

        // Native CDP Clear: Ctrl+A -> Backspace -> Delete
        await cdp.call("Input.dispatchKeyEvent", {
            type: "keyDown", key: "a", code: "KeyA",
            modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65
        });
        await cdp.call("Input.dispatchKeyEvent", {
            type: "keyUp", key: "a", code: "KeyA",
            modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65
        });
        await cdp.call("Input.dispatchKeyEvent", {
            type: "keyDown", key: "Backspace", code: "Backspace",
            windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8
        });
        await cdp.call("Input.dispatchKeyEvent", {
            type: "keyUp", key: "Backspace", code: "Backspace",
            windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8
        });

        await new Promise(r => setTimeout(r, 60));

        // Insert text via CDP native typing
        await cdp.call("Input.insertText", { text });
        console.log(`[INJECT] Typed ${text.length} chars`);

        await new Promise(r => setTimeout(r, 200));
    } catch (e) {
        return { ok: false, error: "insert_exception: " + e.message };
    }

    // 4. Submit message (Enter key + Button click)
    try {
        await cdp.call("Input.dispatchKeyEvent", {
            type: "rawKeyDown", key: "Enter", code: "Enter",
            windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
        });
        await cdp.call("Input.dispatchKeyEvent", {
            type: "keyUp", key: "Enter", code: "Enter",
            windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13
        });

        await new Promise(r => setTimeout(r, 100));

        const clickParams = {
            expression: `(async () => {
                let submit = null;
                for (let retry = 0; retry < 5; retry++) {
                    submit = document.querySelector('[data-tooltip-id="input-send-button-send-tooltip"]') ||
                             document.querySelector('[data-tooltip-id="input-send-button-pending-tooltip"]') ||
                             document.querySelector('[data-tooltip-id*="queue" i]') ||
                             document.querySelector('button[aria-label*="Queue" i]') ||
                             document.querySelector('button[aria-label*="Interrupt" i]') ||
                             document.querySelector('button[aria-label^="Send" i]') ||
                             document.querySelector('button[aria-label*="Queue" i]') ||
                             document.querySelector('button svg.lucide-arrow-right')?.closest('button') ||
                             document.querySelector('button svg.lucide-corner-down-left')?.closest('button');
                    if (submit && !submit.disabled && submit.offsetParent !== null) break;
                    submit = null;
                    await new Promise(r => setTimeout(r, 80));
                }
                if (submit && !submit.disabled) {
                    submit.click();
                    try {
                        submit.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
                    } catch(e) {}
                    return { ok: true, method: "button_click" };
                }
                return { ok: true, method: "enter_key_submit" };
            })()`,
            returnByValue: true,
            awaitPromise: true
        };
        if (cascadeCtxId) clickParams.contextId = cascadeCtxId;

        const clickResult = await Promise.race([
            cdp.call("Runtime.evaluate", clickParams),
            new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000))
        ]);

        return clickResult.result?.value || { ok: true, method: "submitted" };
    } catch (e) {
        return { ok: true, method: "enter_fallback" };
    }
}

// Set functionality mode (Fast vs Planning)
async function setMode(cdp, mode) {
    if (!['Fast', 'Planning'].includes(mode)) return { error: 'Invalid mode' };

    const EXP = `(async () => {
        try {
            // STRATEGY: Find the element that IS the current mode indicator.
            // It will have text 'Fast' or 'Planning'.
            // It might not be a <button>, could be a <div> with cursor-pointer.
            
            // 1. Get all elements with text 'Fast' or 'Planning'
            const allEls = Array.from(document.querySelectorAll('*'));
            const candidates = allEls.filter(el => {
                // Must have single text node child to avoid parents
                if (el.children.length > 0) return false;
                const txt = el.textContent.trim();
                return txt === 'Fast' || txt === 'Planning';
            });

            // 2. Find the one that looks interactive (cursor-pointer)
            // Traverse up from text node to find clickable container
            let modeBtn = null;
            
            for (const el of candidates) {
                let current = el;
                // Go up max 4 levels
                for (let i = 0; i < 4; i++) {
                    if (!current) break;
                    const style = window.getComputedStyle(current);
                    if (style.cursor === 'pointer' || current.tagName === 'BUTTON') {
                        modeBtn = current;
                        break;
                    }
                    current = current.parentElement;
                }
                if (modeBtn) break;
            }

            if (!modeBtn) return { error: 'Mode indicator/button not found' };

            // Check if already set
            if (modeBtn.innerText.includes('${mode}')) return { success: true, alreadySet: true };

            // 3. Click to open menu
            modeBtn.click();
            await new Promise(r => setTimeout(r, 600));

            // 4. Find the dialog
            let visibleDialog = Array.from(document.querySelectorAll('[role="dialog"]'))
                                    .find(d => d.offsetHeight > 0 && d.innerText.includes('${mode}'));
            
            // Fallback: Just look for any new visible container if role=dialog is missing
            if (!visibleDialog) {
                // Maybe it's not role=dialog? Look for a popover-like div
                 visibleDialog = Array.from(document.querySelectorAll('div'))
                    .find(d => {
                        const style = window.getComputedStyle(d);
                        return d.offsetHeight > 0 && 
                               (style.position === 'absolute' || style.position === 'fixed') && 
                               d.innerText.includes('${mode}') &&
                               !d.innerText.includes('Files With Changes'); // Anti-context menu
                    });
            }

            if (!visibleDialog) return { error: 'Dropdown not opened or options not visible' };

            // 5. Click the option
            const allDialogEls = Array.from(visibleDialog.querySelectorAll('*'));
            const target = allDialogEls.find(el => 
                el.children.length === 0 && el.textContent.trim() === '${mode}'
            );

            if (target) {
                target.click();
                await new Promise(r => setTimeout(r, 200));
                return { success: true };
            }
            
            return { error: 'Mode option text not found in dialog. Dialog text: ' + visibleDialog.innerText.substring(0, 50) };

        } catch(err) {
            return { error: 'JS Error: ' + err.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Context failed' };
}

// Stop Generation — cancels generation reliably and clears messageQueue
async function stopGeneration(cdp) {
    let stopped = false;
    let method = "none";

    const CANCEL_SCRIPT = `(() => {
        const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]') ||
                       document.querySelector('button[aria-label*="Cancel" i]') ||
                       document.querySelector('button[aria-label*="Stop" i]') ||
                       document.querySelector('button[title*="Cancel" i]') ||
                       document.querySelector('button[title*="Stop" i]') ||
                       document.querySelector('button svg.lucide-square')?.closest('button') ||
                       document.querySelector('button .bg-red-500')?.closest('button') ||
                       document.querySelector('button svg.lucide-stop-circle')?.closest('button') ||
                       document.querySelector('button svg.lucide-circle-stop')?.closest('button');
        if (cancel && cancel.offsetParent !== null) {
            cancel.click();
            try {
                cancel.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
                cancel.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, view: window }));
                cancel.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
                cancel.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
                cancel.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, view: window }));
            } catch (e) {}
            return { success: true, method: "cancel_button_click" };
        }
        return { not_found: true };
    })()`;

    // 1. Try finding and clicking cancel in default context
    try {
        const res = await Promise.race([
            cdp.call("Runtime.evaluate", {
                expression: CANCEL_SCRIPT,
                returnByValue: true
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000))
        ]);
        const val = res.result?.value;
        if (val?.success) {
            stopped = true;
            method = val.method;
        }
    } catch (e) { }

    // 2. Try across tracked contexts
    if (!stopped && cdp.contexts && cdp.contexts.length > 0) {
        for (const ctx of cdp.contexts) {
            try {
                const res = await Promise.race([
                    cdp.call("Runtime.evaluate", {
                        expression: CANCEL_SCRIPT,
                        returnByValue: true,
                        contextId: ctx.id
                    }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 2000))
                ]);
                const val = res.result?.value;
                if (val?.success) {
                    stopped = true;
                    method = val.method;
                    break;
                }
            } catch (e) { }
        }
    }

    // 3. Dispatch native keyboard shortcuts (Ctrl+D, Escape, Ctrl+C)
    try {
        // Ctrl+D (Antigravity stop generation)
        await cdp.call("Input.dispatchKeyEvent", {
            type: "rawKeyDown", key: "d", code: "KeyD",
            modifiers: 2, windowsVirtualKeyCode: 68, nativeVirtualKeyCode: 68
        });
        await cdp.call("Input.dispatchKeyEvent", {
            type: "keyUp", key: "d", code: "KeyD",
            modifiers: 2, windowsVirtualKeyCode: 68, nativeVirtualKeyCode: 68
        });

        // Escape (Abort)
        await cdp.call("Input.dispatchKeyEvent", {
            type: "rawKeyDown", key: "Escape", code: "Escape", keyCode: 27, windowsVirtualKeyCode: 27
        });
        await cdp.call("Input.dispatchKeyEvent", {
            type: "keyUp", key: "Escape", code: "Escape", keyCode: 27, windowsVirtualKeyCode: 27
        });

        // Ctrl+C (Terminal abort)
        await cdp.call("Input.dispatchKeyEvent", {
            type: "rawKeyDown", key: "c", code: "KeyC",
            modifiers: 2, windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67
        });
        await cdp.call("Input.dispatchKeyEvent", {
            type: "keyUp", key: "c", code: "KeyC",
            modifiers: 2, windowsVirtualKeyCode: 67, nativeVirtualKeyCode: 67
        });

        if (!stopped) {
            stopped = true;
            method = "keyboard_shortcut";
        }
    } catch (e) {
        console.warn("Keyboard cancel dispatch error:", e.message);
    }

    // 4. Clear server messageQueue on Stop
    const clearedCount = messageQueue.length;
    messageQueue.length = 0;
    isProcessingQueue = false;
    if (clearedCount > 0) {
        console.log(`🛑 Cleared ${clearedCount} pending queued message(s) on Stop.`);
    }

    // 5. Force snapshot refresh and broadcast immediately
    if (globalWss) {
        setTimeout(() => fetchAndBroadcastSnapshot(globalWss), 200);
        setTimeout(() => fetchAndBroadcastSnapshot(globalWss), 800);
        broadcastQueueUpdate(globalWss);
    }

    return { success: true, method, clearedQueue: clearedCount };
}

// Click Element (Remote)
async function clickElement(cdp, { selector, index, textContent }) {
    const EXP = `(async () => {
        try {
            // Strategy: Find all elements matching the selector
            // If textContent is provided, filter by that too for safety
            let elements = Array.from(document.querySelectorAll('${selector}'));
            
            if ('${textContent}') {
                elements = elements.filter(el => el.textContent.includes('${textContent}'));
            }

            const target = elements[${index}];

            if (target) {
                target.click();
                // Also try clicking the parent if the target is just a label
                // target.parentElement?.click(); 
                return { success: true };
            }
            
            return { error: 'Element not found at index ${index}' };
        } catch(e) {
            return { error: e.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value?.success) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Click failed in all contexts' };
}

// Remote scroll - sync phone scroll to desktop
async function remoteScroll(cdp, { scrollTop, scrollPercent }) {
    // Try to scroll the chat container in Antigravity
    const EXPRESSION = `(async () => {
        try {
            // Find the main scrollable chat container
            const scrollables = [...document.querySelectorAll('#conversation [class*="scroll"], #chat [class*="scroll"], #cascade [class*="scroll"], #conversation [style*="overflow"], #chat [style*="overflow"], #cascade [style*="overflow"]')]
                .filter(el => el.scrollHeight > el.clientHeight);
            
            // Also check for the main chat area
            const chatArea = document.querySelector('#conversation .overflow-y-auto, #chat .overflow-y-auto, #cascade .overflow-y-auto, #conversation [data-scroll-area], #chat [data-scroll-area], #cascade [data-scroll-area]');
            if (chatArea) scrollables.unshift(chatArea);
            
            if (scrollables.length === 0) {
                // Fallback: scroll the main container element
                const cascade = document.getElementById('conversation') || document.getElementById('chat') || document.getElementById('cascade');
                if (cascade && cascade.scrollHeight > cascade.clientHeight) {
                    scrollables.push(cascade);
                }
            }
            
            if (scrollables.length === 0) return { error: 'No scrollable element found' };
            
            const target = scrollables[0];
            
            // Use percentage-based scrolling for better sync
            if (${scrollPercent} !== undefined) {
                const maxScroll = target.scrollHeight - target.clientHeight;
                target.scrollTop = maxScroll * ${scrollPercent};
            } else {
                target.scrollTop = ${scrollTop || 0};
            }
            
            return { success: true, scrolled: target.scrollTop };
        } catch(e) {
            return { error: e.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXPRESSION,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value?.success) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Scroll failed in all contexts' };
}

// Set AI Model
async function setModel(cdp, modelName) {
    const EXP = `(async () => {
        try {
            // STRATEGY: Multi-layered approach to find and click the model selector
            const KNOWN_KEYWORDS = ["Gemini", "Claude", "GPT", "Model"];
            
            let modelBtn = null;
            
            // Strategy 1: Look for data-tooltip-id patterns (most reliable)
            modelBtn = document.querySelector('[data-testid="model-selector-trigger"], [data-tooltip-id*="model"], [data-tooltip-id*="provider"]');
            
            // Strategy 2: Look for buttons/elements containing model keywords with SVG icons
            if (!modelBtn) {
                const candidates = Array.from(document.querySelectorAll('button, [role="button"], div, span'))
                    .filter(el => {
                        const txt = el.innerText?.trim() || '';
                        return KNOWN_KEYWORDS.some(k => txt.includes(k)) && el.offsetParent !== null;
                    });

                // Find the best one (has chevron icon or cursor pointer)
                modelBtn = candidates.find(el => {
                    const style = window.getComputedStyle(el);
                    const hasSvg = el.querySelector('svg.lucide-chevron-up') || 
                                   el.querySelector('svg.lucide-chevron-down') || 
                                   el.querySelector('svg[class*="chevron"]') ||
                                   el.querySelector('svg');
                    return (style.cursor === 'pointer' || el.tagName === 'BUTTON') && hasSvg;
                }) || candidates[0];
            }
            
            // Strategy 3: Traverse from text nodes up to clickable parents
            if (!modelBtn) {
                const allEls = Array.from(document.querySelectorAll('*'));
                const textNodes = allEls.filter(el => {
                    if (el.children.length > 0) return false;
                    const txt = el.textContent;
                    return KNOWN_KEYWORDS.some(k => txt.includes(k));
                });

                for (const el of textNodes) {
                    let current = el;
                    for (let i = 0; i < 5; i++) {
                        if (!current) break;
                        if (current.tagName === 'BUTTON' || window.getComputedStyle(current).cursor === 'pointer') {
                            modelBtn = current;
                            break;
                        }
                        current = current.parentElement;
                    }
                    if (modelBtn) break;
                }
            }

            if (!modelBtn) return { error: 'Model selector button not found' };

            // Click to open menu
            modelBtn.click();
            await new Promise(r => setTimeout(r, 600));

            // Find the dialog/dropdown - search globally (React portals render at body level)
            let visibleDialog = null;
            const rootSearchWord = '${modelName}'.split(' ')[0]; // E.g., "Gemini", "Claude", "GPT"
            
            // Try specific dialog patterns first
            const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="listbox"], [role="menu"], [data-radix-popper-content-wrapper]'));
            visibleDialog = dialogs.find(d => d.offsetHeight > 0 && d.innerText?.includes(rootSearchWord));
            
            // Fallback: look for positioned divs
            if (!visibleDialog) {
                visibleDialog = Array.from(document.querySelectorAll('div'))
                    .find(d => {
                        const style = window.getComputedStyle(d);
                        return d.offsetHeight > 0 && 
                               (style.position === 'absolute' || style.position === 'fixed') && 
                               d.innerText?.includes(rootSearchWord) && 
                               !d.innerText?.includes('Files With Changes');
                    });
            }

            if (!visibleDialog) {
                // Blind search across entire document as last resort
                const allElements = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"]'));
                const target = allElements.find(el => 
                    el.offsetParent !== null && 
                    (el.innerText?.trim() === '${modelName}' || el.innerText?.includes(rootSearchWord))
                );
                if (target) {
                    target.click();
                    return { success: true, method: 'blind_search' };
                }
                return { error: 'Model list not opened' };
            }

            // Select specific model inside the dialog
            const allDialogEls = Array.from(visibleDialog.querySelectorAll('*'));
            const validEls = allDialogEls.filter(el => el.children.length === 0 && el.textContent?.trim().length > 0);
            
            // A. Exact Match (Best)
            let target = validEls.find(el => el.textContent.trim() === '${modelName}');
            
            // B. Page contains Model exact string
            if (!target) {
                target = validEls.find(el => el.textContent.includes('${modelName}'));
            }

            // C. Token-based Substring matching (Fuzzy)
            if (!target) {
                // Break requested model into significant words (ignore numbers, punctuation, short words)
                // e.g. "Claude Sonnet 4.5" -> ["Claude", "Sonnet"]
                const searchTokens = '${modelName}'.split(/[\\s\\()]+/).filter(t => /^[a-zA-Z]{3,}$/.test(t));
                
                const scoredMatches = validEls.map(el => {
                    const txt = el.textContent;
                    let score = 0;
                    for (const token of searchTokens) {
                        if (txt.includes(token)) score++;
                    }
                    return { el, score };
                }).filter(m => m.score > 0);

                if (scoredMatches.length > 0) {
                    scoredMatches.sort((a, b) => b.score - a.score); // Highest score first
                    target = scoredMatches[0].el;
                }
            }

            if (target) {
                target.scrollIntoView({block: 'center'});
                target.click();
                await new Promise(r => setTimeout(r, 200));
                return { success: true };
            }

            return { error: 'Model "${modelName}" not found in list. Visible: ' + visibleDialog.innerText.substring(0, 100) };
        } catch(err) {
            return { error: 'JS Error: ' + err.toString() };
        }
    })()`;

    let bestResult = null;
    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value) {
                const val = res.result.value;
                // Return immediately on success
                if (val.success) return val;
                // Keep first error as fallback
                if (!bestResult) bestResult = val;
            }
        } catch (e) { }
    }
    return bestResult || { error: 'Context failed' };
}

// Start New Chat - Click New Conversation button in cascade context or fallback to shortcuts
async function startNewChat(cdp) {
    const CLICK_EXP = `(async () => {
        try {
            // Priority 1: Exact new-conversation tooltip anchor
            const newBtn = document.querySelector('[data-tooltip-id="new-conversation-tooltip"]') ||
                           document.querySelector('a[data-tooltip-id*="new-conversation"]') ||
                           document.querySelector('[data-past-conversations-toggle="true"]')?.parentElement?.querySelector('[data-tooltip-id*="new"]');
            if (newBtn) {
                newBtn.click();
                return { success: true, method: 'dom_new_conversation_tooltip', tag: newBtn.tagName };
            }
            // Priority 2: Generic plus buttons in chat header
            const allPlus = Array.from(document.querySelectorAll('a, button, [role="button"]')).filter(el => {
                if (el.offsetParent === null) return false;
                const txt = el.innerText?.trim() || '';
                const aria = el.getAttribute('aria-label') || el.getAttribute('title') || '';
                if (/new conversation|new chat|start new/i.test(aria) || /new conversation|new chat/i.test(txt)) return true;
                const path = el.querySelector('path');
                if (path && (path.getAttribute('d') || '').includes('450-450H220')) return true;
                return false;
            });
            if (allPlus.length > 0) {
                allPlus[0].click();
                return { success: true, method: 'dom_plus_button', tag: allPlus[0].tagName };
            }
            return { clicked: false };
        } catch(e) {
            return { clicked: false, error: e.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: CLICK_EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value?.success) {
                console.log(`[NEW-CHAT] ✅ Clicked New Chat in context ${ctx.id}:`, res.result.value.method);
                cachedSnapshotCtxId = null;
                cachedCascadeCtxId = null;
                observerInjected = false;
                return res.result.value;
            }
        } catch (e) { }
    }

    // Fallback: Send Ctrl+L shortcut
    try {
        console.log('[NEW-CHAT] ⌨️ Fallback: Sending Ctrl+L');
        await cdp.call("Input.dispatchKeyEvent", {
            type: "keyDown", key: "l", code: "KeyL",
            modifiers: 2, windowsVirtualKeyCode: 76, nativeVirtualKeyCode: 76
        });
        await cdp.call("Input.dispatchKeyEvent", {
            type: "keyUp", key: "l", code: "KeyL",
            modifiers: 2, windowsVirtualKeyCode: 76, nativeVirtualKeyCode: 76
        });
        cachedSnapshotCtxId = null;
        cachedCascadeCtxId = null;
        observerInjected = false;
        return { success: true, method: 'cdp_shortcut_ctrl_l' };
    } catch (e) {
        console.error('[NEW-CHAT] ❌ Shortcut failed:', e.message);
        return { error: 'Shortcut failed: ' + e.message };
    }
}
// Get Chat History - Smart check if panel open or click to open & scrape
function getLocalBrainChats() {
    try {
        const brainDir = "/home/absolut7/.gemini/antigravity-ide/brain";
        if (!fs.existsSync(brainDir)) return [];
        const entries = fs.readdirSync(brainDir, { withFileTypes: true });
        const chats = [];
        const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        for (const entry of entries) {
            if (!entry.isDirectory() || !uuidRegex.test(entry.name)) continue;
            const logPath = join(brainDir, entry.name, ".system_generated", "logs", "transcript.jsonl");
            let title = entry.name;
            let mtime = 0;
            try {
                const stat = fs.statSync(join(brainDir, entry.name));
                mtime = stat.mtimeMs;
                if (fs.existsSync(logPath)) {
                    const line = fs.readFileSync(logPath, "utf8").split("\n")[0];
                    if (line) {
                        const parsed = JSON.parse(line);
                        if (parsed.content) {
                            title = parsed.content.slice(0, 60).replace(/\n/g, " ");
                        }
                    }
                }
            } catch (e) {}
            chats.push({ id: entry.name, title, mtime, date: "Recent" });
        }
        chats.sort((a, b) => b.mtime - a.mtime);
        return chats.slice(0, 30);
    } catch (e) {
        return [];
    }
}

async function getChatHistory(cdp) {
    if (!cdp) return { success: true, count: 0, chats: getLocalBrainChats() };

    const SCRAPE_EXP = `(async () => {
        try {
            let items = Array.from(document.querySelectorAll('div[id^="fastpick-item-"]'));
            let opened = false;
            if (items.length === 0) {
                const btn = document.querySelector('a[data-tooltip-id="history-tooltip"]') ||
                            document.querySelector('[data-past-conversations-toggle="true"]');
                if (btn) {
                    btn.click();
                    opened = true;
                    await new Promise(r => setTimeout(r, 600));
                    items = Array.from(document.querySelectorAll('div[id^="fastpick-item-"]'));
                }
            }

            // If "Show more" is present, click it to get all
            const showMore = document.querySelector('[id^="fastpick-show-more"]');
            if (showMore) {
                showMore.click();
                await new Promise(r => setTimeout(r, 300));
                items = Array.from(document.querySelectorAll('div[id^="fastpick-item-"]'));
            }

            const chats = items.map(el => {
                const id = el.id.replace("fastpick-item-", "");
                const isSelected = el.getAttribute("aria-selected") === "true";
                const lines = (el.innerText || "").split("\\n").map(l => l.trim()).filter(Boolean);
                const title = lines[0] || "Untitled Conversation";
                let date = "Recent";
                let workspace = "";
                if (lines.length >= 3) {
                    workspace = lines[1];
                    date = lines[2];
                } else if (lines.length === 2) {
                    date = lines[1];
                }
                return { id, title, workspace, date, isSelected };
            });

            if (opened) {
                window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27 }));
            }

            return { success: true, count: chats.length, chats, opened };
        } catch(e) {
            return { success: false, error: e.toString(), chats: [] };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await Promise.race([
                cdp.call("Runtime.evaluate", {
                    expression: SCRAPE_EXP,
                    returnByValue: true,
                    awaitPromise: true,
                    contextId: ctx.id
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3500))
            ]);
            if (res.result?.value?.chats?.length > 0) {
                try {
                    await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", keyCode: 27 });
                    await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", keyCode: 27 });
                } catch (e) { }
                return res.result.value;
            }
        } catch (e) { }
    }

    const localChats = getLocalBrainChats();
    return { success: true, count: localChats.length, chats: localChats };
}

async function selectChat(cdp, { id, title } = {}) {
    if (!cdp) return { error: "CDP disconnected" };
    const safeId = JSON.stringify(id || "");
    const safeTitle = JSON.stringify(title || "");

    const EXP = `(async () => {
        try {
            const targetId = ${safeId};
            const targetTitle = ${safeTitle};

            let items = Array.from(document.querySelectorAll('div[id^="fastpick-item-"]'));
            if (items.length === 0) {
                const historyBtn = document.querySelector('a[data-tooltip-id="history-tooltip"]') ||
                                 document.querySelector('[data-past-conversations-toggle="true"]');
                if (historyBtn) {
                    historyBtn.click();
                    await new Promise(r => setTimeout(r, 600));
                    items = Array.from(document.querySelectorAll('div[id^="fastpick-item-"]'));
                }
            }

            let el = null;
            if (targetId) {
                el = document.getElementById("fastpick-item-" + targetId);
            }
            if (!el && targetTitle) {
                const clean = targetTitle.toLowerCase().trim();
                el = items.find(item => (item.innerText || "").toLowerCase().includes(clean));
            }

            if (!el) {
                const showMore = document.querySelector('[id^="fastpick-show-more"]');
                if (showMore) {
                    showMore.click();
                    await new Promise(r => setTimeout(r, 350));
                    items = Array.from(document.querySelectorAll('div[id^="fastpick-item-"]'));
                    if (targetId) el = document.getElementById("fastpick-item-" + targetId);
                    if (!el && targetTitle) {
                        const clean = targetTitle.toLowerCase().trim();
                        el = items.find(item => (item.innerText || "").toLowerCase().includes(clean));
                    }
                }
            }

            if (!el) return { success: false, error: "Conversation not found in history list" };

            el.click();
            try {
                el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
                el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, view: window }));
                el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true, view: window }));
            } catch (e) {}

            return { success: true, id: targetId, title: targetTitle };
        } catch (e) {
            return { success: false, error: e.toString() };
        }
    })()`;

    for (const ctx of cdp.contexts) {
        try {
            const res = await Promise.race([
                cdp.call("Runtime.evaluate", {
                    expression: EXP,
                    returnByValue: true,
                    awaitPromise: true,
                    contextId: ctx.id
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 4000))
            ]);
            if (res.result?.value?.success) {
                console.log(`[SELECT-CHAT] ✅ Selected "${title || id}" in context ${ctx.id}`);
                cachedSnapshotCtxId = null;
                cachedCascadeCtxId = null;
                lastSnapshot = null;
                lastLightCheck = null;
                observerInjected = false;
                setTimeout(async () => {
                    try {
                        await cdp.call("Runtime.evaluate", {
                            expression: `(() => {
                                const ed = document.querySelector(\'[data-lexical-editor="true"]\') || document.querySelector(\'div[contenteditable="true"]\') || document.querySelector(\'textarea\');
                                if (ed) ed.focus();
                            })()`, contextId: ctx.id
                        });
                    } catch (e) {}
                }, 400);
                if (globalWss) {
                    setTimeout(() => fetchAndBroadcastSnapshot(globalWss), 300);
                    setTimeout(() => fetchAndBroadcastSnapshot(globalWss), 900);
                }
                return res.result.value;
            }
        } catch (e) { }
    }
    return { error: "Failed to select chat in any context" };
}

// Check if a chat is currently open (has cascade element)
async function hasChatOpen(cdp) {
    const EXP = `(() => {
    const chatContainer = document.getElementById('conversation') || document.getElementById('chat') || document.getElementById('cascade');
    const hasMessages = chatContainer && chatContainer.querySelectorAll('[class*="message"], [data-message]').length > 0;
    return {
        hasChat: !!chatContainer,
        hasMessages: hasMessages,
        editorFound: !!(chatContainer && chatContainer.querySelector('[data-lexical-editor="true"]'))
    };
})()`;

    let bestResult = { hasChat: false, hasMessages: false, editorFound: false };
    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                contextId: ctx.id
            });
            if (res.result?.value) {
                const val = res.result.value;
                // Prefer contexts that actually found messages or editor
                if (val.editorFound || val.hasMessages) return val;
                if (val.hasChat && !bestResult.hasChat) bestResult = val;
            }
        } catch (e) { }
    }
    return bestResult;
}

// Get App State (Mode & Model)
async function getAppState(cdp) {
    const EXP = `(async () => {
    try {
        const state = { mode: 'Unknown', model: 'Unknown' };

        // 1. Get Mode (Fast/Planning)
        const modeTexts = Array.from(document.querySelectorAll('button:not(:disabled), div[role="button"]:not(:disabled)'))
            .map(el => el.textContent?.trim())
            .filter(t => t === 'Fast' || t === 'Planning');
        
        if (modeTexts.length > 0) {
            state.mode = modeTexts[0];
        }

        // 2. Get Model
        const trigger = document.querySelector('[data-testid="model-selector-trigger"], [data-tooltip-id*="model"]');
        if (trigger) {
            state.model = trigger.innerText?.trim() || 'Unknown';
        } else {
            const KNOWN_MODELS = ["Gemini", "Claude", "GPT", "DeepSeek"];
            const headerButtons = Array.from(document.querySelectorAll('button, [role="button"]'));
            for (const btn of headerButtons) {
                const txt = btn.innerText?.trim() || '';
                if (KNOWN_MODELS.some(k => txt.includes(k))) {
                    if (btn.querySelector('svg[class*="chevron"]') ||
                        btn.querySelector('svg.lucide-chevron-up') ||
                        btn.querySelector('svg.lucide-chevron-down') ||
                        btn.querySelector('svg') ||
                        btn.closest('header')) {
                        state.model = txt;
                        break;
                    }
                }
            }
        }

        return state;
    } catch (e) { return { error: e.toString() }; }
})()`;

    let bestResult = { mode: 'Unknown', model: 'Unknown' };
    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value) {
                const val = res.result.value;
                // Prefer contexts that found actual mode or model
                if (val.mode !== 'Unknown' || val.model !== 'Unknown') return val;
            }
        } catch (e) { }
    }
    return bestResult;
}

// Simple hash function
function hashString(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash.toString(36);
}

// Check if a request is from the same Wi-Fi (internal network)
function isLocalRequest(req) {
    // 1. Check for proxy headers (Cloudflare, ngrok, etc.)
    // If these exist, the request is coming via an external tunnel/proxy
    if (req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers['x-real-ip']) {
        return false;
    }

    // 2. Check the remote IP address
    const ip = req.ip || req.socket.remoteAddress || '';

    // Standard local/private IPv4 and IPv6 ranges
    return ip === '127.0.0.1' ||
        ip === '::1' ||
        ip === '::ffff:127.0.0.1' ||
        ip.startsWith('192.168.') ||
        ip.startsWith('10.') ||
        ip.startsWith('172.16.') || ip.startsWith('172.17.') ||
        ip.startsWith('172.18.') || ip.startsWith('172.19.') ||
        ip.startsWith('172.2') || ip.startsWith('172.3') ||
        ip.startsWith('::ffff:192.168.') ||
        ip.startsWith('::ffff:10.');
}

// Initialize CDP connection
async function initCDP() {
    console.log('🔍 Discovering Antigravity CDP endpoint...');
    const cdpInfo = await discoverCDP();
    console.log(`✅ Found Antigravity on port ${cdpInfo.port} `);

    console.log('🔌 Connecting to CDP...');
    cdpConnection = await connectCDP(cdpInfo.url);
    console.log(`✅ Connected! Found ${cdpConnection.contexts.length} execution contexts\n`);
}

// Inject MutationObserver into the IDE page — pushes DOM changes to server via binding
async function injectObserver(cdp) {
    if (!cdp || !cdp.contexts || cdp.contexts.length === 0) return false;

    const INJECT_SCRIPT = `(function() {
        if (window.__agObserverDisconnect) {
            try { window.__agObserverDisconnect(); } catch (e) {}
        }

        const cascade = document.getElementById('conversation') || document.getElementById('chat') || document.getElementById('cascade');
        if (!cascade) return 'no_container';

        let debounceTimer = null;
        const DEBOUNCE_MS = 300;

        function pushSignal() {
            try {
                if (typeof window.agPushSnapshot === 'function') {
                    window.agPushSnapshot(JSON.stringify({ changed: true, t: Date.now() }));
                }
            } catch (err) {}
        }

        const observer = new MutationObserver(() => {
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(pushSignal, DEBOUNCE_MS);
        });

        observer.observe(cascade, {
            childList: true,
            subtree: true,
            characterData: true
        });

        window.__agObserverActive = true;
        window.__agObserverDisconnect = () => {
            try { observer.disconnect(); } catch (e) {}
            window.__agObserverActive = false;
        };

        setTimeout(pushSignal, 50);
        return 'injected';
    })()`;

    const sortedContexts = [...cdp.contexts].sort((a, b) => {
        const aDef = (a.auxData?.isDefault || a.id === 1) ? 1 : 0;
        const bDef = (b.auxData?.isDefault || b.id === 1) ? 1 : 0;
        return bDef - aDef;
    });

    let targetCtxId = null;
    for (const ctx of sortedContexts) {
        try {
            const probe = await cdp.call("Runtime.evaluate", {
                expression: "!!(document.getElementById('conversation') || document.getElementById('chat') || document.getElementById('cascade'))",
                returnByValue: true,
                contextId: ctx.id
            });
            if (probe.result?.value === true) {
                targetCtxId = ctx.id;
                cachedSnapshotCtxId = ctx.id;
                break;
            }
        } catch (e) { }
    }

    if (!targetCtxId) {
        console.log('⏳ No chat container found for observer injection');
        return false;
    }

    try {
        const res = await cdp.call("Runtime.evaluate", {
            expression: INJECT_SCRIPT,
            returnByValue: true,
            contextId: targetCtxId
        });

        const result = res.result?.value;
        if (result === 'injected') {
            observerInjected = true;
            console.log(`👁️  MutationObserver injected in context ${targetCtxId} — push mode active`);
            return true;
        } else {
            console.log(`⏳ Observer injection returned: ${result}`);
            return false;
        }
    } catch (e) {
        console.warn('⚠️  Observer injection failed:', e.message);
        return false;
    }
}

// Broadcast snapshot update to all connected phone clients
function broadcastSnapshotUpdate(wss) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
                type: 'snapshot_update',
                timestamp: new Date().toISOString()
            }));
        }
    });
}

// Background health-check loop (replaces heavy polling)
// Only handles: CDP reconnection, observer injection, rare fallback snapshots
// Wire up push handler on CDP connection
function wirePushHandler(wss) {
    if (!cdpConnection) return;
    cdpConnection.onPush = (payload) => {
        lastPushTime = Date.now();
        if (!payload.changed) return;

        const now = Date.now();
        const elapsed = now - lastPushFetchTime;

        if (elapsed >= PUSH_FETCH_THROTTLE) {
            fetchAndBroadcastSnapshot(wss || globalWss);
        } else if (!pendingPushFetch) {
            pendingPushFetch = true;
            const delay = PUSH_FETCH_THROTTLE - elapsed;
            setTimeout(() => {
                pendingPushFetch = false;
                fetchAndBroadcastSnapshot(wss || globalWss);
            }, delay);
        }
    };
}

// Server-side snapshot fetch (runs via CDP, not in-page)
async function fetchAndBroadcastSnapshot(wss) {
    const targetWss = wss || globalWss;
    if (!cdpConnection || !targetWss) return;
    lastPushFetchTime = Date.now();
    lastPushTime = Date.now();
    try {
        const snapshot = await Promise.race([
            captureSnapshot(cdpConnection),
            new Promise(resolve => setTimeout(() => resolve(null), 8000))
        ]);
        if (snapshot && snapshot !== '__unchanged__' && !snapshot.error) {
            const hash = hashString(snapshot.html);
            if (hash !== lastSnapshotHash) {
                lastSnapshot = snapshot;
                lastSnapshotHash = hash;
                broadcastSnapshotUpdate(targetWss);
                console.log(`📡 Snapshot update broadcast (hash: ${hash})`);
            }
        }
    } catch (e) {
        console.error('Snapshot broadcast error:', e.message);
    }
}

// Background health-check loop
async function startBackgroundLoop(wss) {
    let isConnecting = false;

    // Initial wiring
    wirePushHandler(wss);

    const healthCheck = async () => {
        if (!cdpConnection || (cdpConnection.ws && cdpConnection.ws.readyState !== WebSocket.OPEN)) {
            if (!isConnecting) {
                console.log('🔍 Looking for Antigravity CDP connection...');
                isConnecting = true;
            }
            if (cdpConnection) {
                console.log('🔄 CDP connection lost. Attempting to reconnect...');
                cdpConnection = null;
                observerInjected = false;
            }
            try {
                await initCDP();
                if (cdpConnection) {
                    console.log(`✅ CDP Connection established (after ${reconnectAttempts} attempts)`);
                    isConnecting = false;
                    reconnectAttempts = 0;
                    wirePushHandler(wss);
                    injectObserver(cdpConnection).catch(() => {});
                }
            } catch (err) { }
            reconnectAttempts++;
            const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts - 1), RECONNECT_MAX_MS);
            setTimeout(healthCheck, delay);
            return;
        }

        if (!observerInjected) {
            try {
                await injectObserver(cdpConnection);
            } catch (e) {
                console.warn('Observer injection attempt failed:', e.message);
            }
        }

        const now = Date.now();
        if (!cachedCSS || (now - lastCSSRefresh) > CSS_CACHE_TTL) {
            try {
                const ctxId = cachedSnapshotCtxId || cdpConnection.contexts[0]?.id;
                if (ctxId) {
                    const cssRes = await cdpConnection.call("Runtime.evaluate", {
                        expression: CSS_EXTRACT_SCRIPT,
                        returnByValue: true,
                        contextId: ctxId
                    });
                    if (cssRes.result?.value) {
                        cachedCSS = cssRes.result.value;
                        lastCSSRefresh = now;
                        if (lastSnapshot) {
                            lastSnapshot.css = cachedCSS;
                            if (lastSnapshot.stats) lastSnapshot.stats.cssSize = cachedCSS.length;
                        }
                    }
                }
            } catch (e) { }
        }

        const hasClients = wss.clients.size > 0;
        if (hasClients && (now - lastPushTime) > FALLBACK_SNAPSHOT_INTERVAL) {
            await fetchAndBroadcastSnapshot(wss);
            lastPushTime = now;
        }

        setTimeout(healthCheck, HEALTH_CHECK_INTERVAL);
    };

    healthCheck();

    // --- Independent queue drain loop (2s) ---
    function startQueueDrainLoop() {
        setInterval(async () => {
            if (messageQueue.length === 0 || isProcessingQueue) return;
            if (!cdpConnection || cdpConnection.ws?.readyState !== WebSocket.OPEN) return;

            isProcessingQueue = true;
            try {
                const busy = await isAgentBusy(cdpConnection);
                if (busy) {
                    const now = Date.now();
                    const staleIdx = messageQueue.findIndex(m => (now - m.timestamp) > 900000);
                    if (staleIdx !== -1) {
                        const dropped = messageQueue.splice(staleIdx, 1)[0];
                        console.log(`🗑️ Dropped stale queued message: "${dropped.text.substring(0, 40)}..."`);
                        broadcastQueueUpdate(globalWss);
                    }
                    return;
                }

                const current = messageQueue[0];
                console.log(`🚀 Queue: Sending message "${current.text.substring(0, 40)}..." (attempt ${(current.attempts || 0) + 1}/3)`);

                const result = await injectMessage(cdpConnection, current.text);
                if (result.reason === 'busy') {
                    return;
                }

                if (result.ok !== false) {
                    messageQueue.shift();
                    console.log(`✅ Queue: Sent message successfully! (${messageQueue.length} remaining)`);
                    broadcastQueueUpdate(globalWss);
                    if (globalWss) {
                        setTimeout(() => fetchAndBroadcastSnapshot(globalWss), 300);
                        setTimeout(() => fetchAndBroadcastSnapshot(globalWss), 1200);
                        setTimeout(() => fetchAndBroadcastSnapshot(globalWss), 2500);
                    }
                } else {
                    current.attempts = (current.attempts || 0) + 1;
                    console.warn(`⚠️ Queue: Injection attempt ${current.attempts}/5 failed: ${result.error || 'unknown'}`);
                    if (current.attempts >= 5) {
                        messageQueue.shift();
                        console.error(`❌ Queue: Message dropped after 5 failed attempts: "${current.text.substring(0, 40)}..."`);
                        broadcastQueueUpdate(globalWss);
                    }
                }
            } catch (e) {
                console.error('Queue drain error:', e.message);
            } finally {
                isProcessingQueue = false;
            }
        }, 1200);
    }

    startQueueDrainLoop();
}


// --- Workspace Management ---
function getAvailableWorkspaces() {
    const baseDocs = "/home/absolut7/Documents";
    const workspaces = [];
    const seenPaths = new Set();

    // 1. Scan ~/Documents direct subfolders
    try {
        if (fs.existsSync(baseDocs)) {
            const entries = fs.readdirSync(baseDocs, { withFileTypes: true });
            for (const ent of entries) {
                if (ent.isDirectory() && !ent.name.startsWith(".") && ent.name !== "node_modules") {
                    const fullPath = join(baseDocs, ent.name);
                    seenPaths.add(fullPath);
                    let mtime = 0;
                    try { mtime = fs.statSync(fullPath).mtimeMs; } catch (e) {}
                    workspaces.push({
                        name: ent.name,
                        shortName: ent.name,
                        path: fullPath,
                        group: "Documents",
                        mtime
                    });
                }
            }
        }
    } catch (e) {}

    // 2. Scan ~/Documents/26apps subfolders
    const apps26 = join(baseDocs, "26apps");
    try {
        if (fs.existsSync(apps26)) {
            const entries = fs.readdirSync(apps26, { withFileTypes: true });
            for (const ent of entries) {
                if (ent.isDirectory() && !ent.name.startsWith(".") && ent.name !== "node_modules") {
                    const fullPath = join(apps26, ent.name);
                    if (!seenPaths.has(fullPath)) {
                        seenPaths.add(fullPath);
                        let mtime = 0;
                        try { mtime = fs.statSync(fullPath).mtimeMs; } catch (e) {}
                        workspaces.push({
                            name: "26apps / " + ent.name,
                            shortName: ent.name,
                            path: fullPath,
                            group: "26apps",
                            mtime
                        });
                    }
                }
            }
        }
    } catch (e) {}

    // Sort by modification time (most recent first)
    workspaces.sort((a, b) => b.mtime - a.mtime);

    // Current workspace detection
    let currentWorkspace = { name: "news", path: "/home/absolut7/Documents/news" };
    try {
        if (lastSnapshot && lastSnapshot.workspaceTitle) {
            const match = workspaces.find(w => w.name.toLowerCase() === lastSnapshot.workspaceTitle.toLowerCase() || (w.shortName && w.shortName.toLowerCase() === lastSnapshot.workspaceTitle.toLowerCase()) || lastSnapshot.workspaceTitle.toLowerCase().includes(w.name.toLowerCase()));
            if (match) currentWorkspace = match;
            else currentWorkspace = { name: lastSnapshot.workspaceTitle, path: join(baseDocs, lastSnapshot.workspaceTitle) };
        }
    } catch (e) {}

    return {
        currentWorkspace,
        parentDir: baseDocs,
        workspaces
    };
}

async function openWorkspaceFolder(folderPath) {
    if (!folderPath) return { error: "Folder path required" };
    const baseDocs = "/home/absolut7/Documents";
    const resolvedPath = folderPath.startsWith("/") ? folderPath : join(baseDocs, folderPath);
    if (!fs.existsSync(resolvedPath)) {
        fs.mkdirSync(resolvedPath, { recursive: true });
    }

    console.log("[WORKSPACE] 📂 Opening folder:", resolvedPath);
    try {
        const { exec } = require("child_process");
        exec(`/home/absolut7/.local/share/antigravity/bin/antigravity -r "${resolvedPath}"`, (err) => {
            if (err) console.warn("[WORKSPACE] antigravity -r:", err.message);
        });
    } catch (e) {
        console.error("[WORKSPACE] Failed to open folder:", e.message);
    }

    await new Promise(r => setTimeout(r, 1800));
    cachedSnapshotCtxId = null;
    cachedCascadeCtxId = null;
    observerInjected = false;
    await ensureCDP();

    return {
        success: true,
        path: resolvedPath,
        name: basename(resolvedPath)
    };
}

// Create Express app
async function createServer() {
    const app = express();

    // Check for SSL certificates
    const keyPath = join(__dirname, 'certs', 'server.key');
    const certPath = join(__dirname, 'certs', 'server.cert');
    const hasSSL = fs.existsSync(keyPath) && fs.existsSync(certPath);

    let server;
    let httpsServer = null;

    if (hasSSL) {
        const sslOptions = {
            key: fs.readFileSync(keyPath),
            cert: fs.readFileSync(certPath)
        };
        httpsServer = https.createServer(sslOptions, app);
        server = httpsServer;
    } else {
        server = http.createServer(app);
    }

    const wss = new WebSocketServer({ server });
    globalWss = wss;

    // Initialize Auth Token (wait for hashString to be available)
    AUTH_TOKEN = hashString(APP_PASSWORD + 'antigravity_salt');

    app.use(compression());
    app.use(express.json({ limit: '50mb' }));
    app.use(cookieParser('antigravity_secret_key_1337'));

    // Ngrok Bypass Middleware
    app.use((req, res, next) => {
        // Tell ngrok to skip the "visit" warning for API requests
        res.setHeader('ngrok-skip-browser-warning', 'true');
        next();
    });

    // Auth Middleware - DISABLED (no password)
    app.use((req, res, next) => {
        return next();
    });

    app.use(express.static(join(__dirname, 'public')));

    // Login endpoint
    app.post('/login', (req, res) => {
        const { password } = req.body;
        if (password === APP_PASSWORD) {
            res.cookie(AUTH_COOKIE_NAME, AUTH_TOKEN, {
                httpOnly: true,
                signed: true,
                maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
            });
            res.json({ success: true });
        } else {
            res.status(401).json({ success: false, error: 'Invalid password' });
        }
    });

    // Logout endpoint
    app.post('/logout', (req, res) => {
        res.clearCookie(AUTH_COOKIE_NAME);
        res.json({ success: true });
    });

    // Get current snapshot
    app.get('/snapshot', (req, res) => {
        if (!lastSnapshot) {
            return res.status(503).json({ error: 'No snapshot available yet' });
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.json(lastSnapshot);
    });

    // Health check endpoint with system stats
    app.get('/health', (req, res) => {
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const loadAvg = os.loadavg()[0]; // 1-minute load average
        const cpuCount = os.cpus().length;
        const cpuPercent = Math.round((loadAvg / cpuCount) * 100);

        res.json({
            status: 'ok',
            cdpConnected: cdpConnection?.ws?.readyState === 1,
            uptime: process.uptime(),
            cpu: cpuPercent,
            ram: {
                used: Math.round(usedMem / (1024 * 1024)),  // MB
                total: Math.round(totalMem / (1024 * 1024)), // MB
                usedGB: (usedMem / (1024 * 1024 * 1024)).toFixed(1),
                totalGB: (totalMem / (1024 * 1024 * 1024)).toFixed(1)
            },
            timestamp: new Date().toISOString(),
            https: hasSSL
        });
    });

    // Lisan al-Arab API - serves Arabic root words for scrolling banner
    app.get('/api/lisan', (req, res) => {
        try {
            const lisanPath = join(__dirname, 'public', 'lisanclean.json');
            if (!fs.existsSync(lisanPath)) {
                return res.json([]);
            }
            // Cache the parsed data
            if (!app._lisanData) {
                const raw = JSON.parse(fs.readFileSync(lisanPath, 'utf-8'));
                // Convert dict of {root: definition} into array of root words
                app._lisanData = Object.keys(raw);
            }
            // Return random batch of roots as "sentences" (groups of 3-5 roots)
            const roots = app._lisanData;
            const sentences = [];
            for (let i = 0; i < 50; i++) {
                const start = Math.floor(Math.random() * (roots.length - 4));
                const count = 3 + Math.floor(Math.random() * 3); // 3-5 roots per sentence
                sentences.push(roots.slice(start, start + count).join(' '));
            }
            res.json(sentences);
        } catch (e) {
            console.error('Lisan API error:', e.message);
            res.json([]);
        }
    });

    // SSL status endpoint
    app.get('/ssl-status', (req, res) => {
        const keyPath = join(__dirname, 'certs', 'server.key');
        const certPath = join(__dirname, 'certs', 'server.cert');
        const certsExist = fs.existsSync(keyPath) && fs.existsSync(certPath);
        res.json({
            enabled: hasSSL,
            certsExist: certsExist,
            message: hasSSL ? 'HTTPS is active' :
                certsExist ? 'Certificates exist, restart server to enable HTTPS' :
                    'No certificates found'
        });
    });

    // Generate SSL certificates endpoint
    app.post('/generate-ssl', async (req, res) => {
        try {
            const { execSync } = await import('child_process');
            execSync('node generate_ssl.js', { cwd: __dirname, stdio: 'pipe' });
            res.json({
                success: true,
                message: 'SSL certificates generated! Restart the server to enable HTTPS.'
            });
        } catch (e) {
            res.status(500).json({
                success: false,
                error: e.message
            });
        }
    });

    // Debug UI Endpoint
    app.get('/debug-ui', async (req, res) => {
        if (!cdpConnection && !(await ensureCDP())) return res.status(503).json({ error: 'CDP not connected' });
        const uiTree = await inspectUI(cdpConnection);
        console.log('--- UI TREE ---');
        console.log(uiTree);
        console.log('---------------');
        res.type('json').send(uiTree);
    });

    // Set Mode
    app.post('/set-mode', async (req, res) => {
        const { mode } = req.body;
        if (!cdpConnection && !(await ensureCDP())) return res.status(503).json({ error: 'CDP disconnected' });
        const result = await setMode(cdpConnection, mode);
        res.json(result);
    });

    // Set Model
    app.post('/set-model', async (req, res) => {
        const { model } = req.body;
        if (!cdpConnection && !(await ensureCDP())) return res.status(503).json({ error: 'CDP disconnected' });
        const result = await setModel(cdpConnection, model);
        res.json(result);
    });

    // Upload File or Image (attach document, code, data, or picture to IDE chat)
    const handleFileUpload = async (req, res) => {
        const { name, dataUrl } = req.body;
        if (!dataUrl) return res.status(400).json({ error: 'No file data' });

        try {
            // Decode base64 data URL (handles data:<mime>;base64,<content> or raw base64)
            let buffer;
            let mime = '';
            const matches = dataUrl.match(/^data:([^;]*);base64,(.+)$/);
            if (matches) {
                mime = matches[1] || 'application/octet-stream';
                buffer = Buffer.from(matches[2], 'base64');
            } else {
                buffer = Buffer.from(dataUrl, 'base64');
            }

            // Sanitize file name and preserve extension
            let safeName = '';
            if (name && typeof name === 'string') {
                safeName = basename(name).replace(/[^a-zA-Z0-9._-]/g, '_');
            }

            let fileName = '';
            if (safeName && safeName.length > 0) {
                fileName = `antigravity_upload_${Date.now()}_${safeName}`;
            } else {
                let ext = 'bin';
                if (mime.startsWith('image/')) {
                    ext = (mime.split('/')[1] || 'png').split('+')[0];
                } else if (mime.includes('/')) {
                    const sub = mime.split('/')[1];
                    if (sub && sub.length <= 6) ext = sub;
                }
                fileName = `antigravity_upload_${Date.now()}.${ext}`;
            }

            const tmpPath = join(os.tmpdir(), fileName);
            fs.writeFileSync(tmpPath, buffer);

            console.log(`[UPLOAD] Saved file to ${tmpPath} (${buffer.length} bytes, name: ${safeName || fileName})`);

            // Use CDP if available to also inject into IDE file input if present
            let uploaded = false;
            if (cdpConnection || (await ensureCDP())) {
                const contexts = cdpConnection ? (cdpConnection.contexts || []) : [];
                for (const ctx of contexts) {
                    try {
                        const evalRes = await cdpConnection.call('Runtime.evaluate', {
                            expression: 'document.querySelector("input[type=file]")',
                            contextId: ctx.id
                        });

                        if (evalRes.result && evalRes.result.objectId && evalRes.result.subtype !== 'null') {
                            const nodeRes = await cdpConnection.call('DOM.requestNode', {
                                objectId: evalRes.result.objectId
                            });

                            await cdpConnection.call('DOM.setFileInputFiles', {
                                nodeId: nodeRes.nodeId,
                                files: [tmpPath]
                            });

                            console.log(`[UPLOAD] Injected file into IDE context ${ctx.id}`);
                            uploaded = true;
                            break;
                        }
                    } catch (ctxErr) {}
                }
            }

            res.json({ success: true, path: tmpPath, name: safeName || fileName, uploadedToIde: uploaded });
        } catch (e) {
            console.error('[UPLOAD] Error:', e);
            res.status(500).json({ error: e.message });
        }
    };

    app.post('/upload-file', handleFileUpload);
    app.post('/upload-image', handleFileUpload);

    app.post('/stop', async (req, res) => {
        if (!cdpConnection && !(await ensureCDP())) return res.status(503).json({ error: 'CDP disconnected' });
        const result = await stopGeneration(cdpConnection);
        res.json(result);
    });

    // Reconnect CDP without restarting IDE
    app.post("/reconnect-cdp", async (req, res) => {
        console.log("🔄 Manual CDP Reconnect requested...");
        try {
            if (cdpConnection && cdpConnection.ws) {
                try { cdpConnection.ws.close(); } catch (e) { }
                cdpConnection = null;
            }
            const endpoint = await discoverCDP();
            cdpConnection = await connectCDP(endpoint.url);
            if (globalWss) {
                wirePushHandler(globalWss);
                injectObserver(cdpConnection).catch(() => {});
            }
            console.log("  ✅ Reconnected to CDP on port", endpoint.port);
            res.json({ success: true, message: "CDP reconnected", port: endpoint.port });
        } catch (e) {
            console.error("  ❌ Reconnect CDP failed:", e.message);
            res.status(500).json({ error: "Failed to reconnect: " + e.message });
        }
    });

    // Restart IDE - Kill antigravity and restart with debug port
    app.post("/restart-ide", async (req, res) => {
        console.log("🔄 Restart IDE requested...");
        try {
            // Close existing CDP connection first
            if (cdpConnection && cdpConnection.ws) {
                try { cdpConnection.ws.close(); } catch (e) { }
                cdpConnection = null;
            }

            // Kill all antigravity processes EXCEPT this server
            const myPid = process.pid;
            try {
                const psOut = execSync("ps -eo pid,args", { encoding: "utf8" });
                const lines = psOut.split("\n");
                const toKill = [];
                for (const line of lines) {
                    const match = line.trim().match(/^(\d+)\s+(.+)$/);
                    if (!match) continue;
                    const pid = parseInt(match[1], 10);
                    const cmd = match[2];
                    if (pid === myPid) continue;
                    if (cmd.includes("server.js") || cmd.includes("antigravity_phone_chat")) continue;
                    if (cmd.includes("antigravity-ide") || cmd.includes("language_server_linux") || (cmd.includes("antigravity") && !cmd.includes("gravityremote2"))) {
                        toKill.push(pid);
                    }
                }

                if (toKill.length > 0) {
                    execSync(`kill ${toKill.join(" ")} || true`, { stdio: "pipe" });
                    console.log(`  ✅ Killed antigravity processes: ${toKill.join(", ")}`);
                } else {
                    console.log("  ⚠️  No other antigravity processes found");
                }
            } catch (e) {
                console.log("  ⚠️  Error killing processes:", e.message);
            }

            // Wait for processes to die
            await new Promise(r => setTimeout(r, 2000));

            // Start antigravity with debug port
            const child = spawn("/home/absolut7/.local/bin/antigravity", ["--remote-debugging-port=9222"], {
                detached: true,
                stdio: "ignore",
                env: {
                    ...process.env,
                    PATH: `/home/absolut7/.local/bin:${process.env.PATH || ""}`,
                    DISPLAY: process.env.DISPLAY || ":0"
                }
            });
            child.unref();
            console.log("  🚀 Started antigravity --remote-debugging-port=9222 (PID:", child.pid, ")");

            // Respond immediately
            res.json({ success: true, message: "IDE restarting...", pid: child.pid });

            // Reconnect CDP after IDE boots
            setTimeout(async () => {
                for (let attempt = 0; attempt < 20; attempt++) {
                    try {
                        const endpoint = await discoverCDP();
                        cdpConnection = await connectCDP(endpoint.url);
                        console.log("  ✅ CDP reconnected after restart");
                        return;
                    } catch (e) {
                        console.log(`  ⏳ CDP reconnect attempt ${attempt + 1}/20...`);
                        await new Promise(r => setTimeout(r, 2000));
                    }
                }
                console.error("  ❌ Failed to reconnect CDP after restart");
            }, 3000);

        } catch (e) {
            console.error("Restart IDE error:", e);
            res.status(500).json({ error: e.message });
        }
    });

    // Send message
    app.post('/send', async (req, res) => {
        const { message, forceQueue, forceSend } = req.body;

        if (!message) {
            return res.status(400).json({ error: 'Message required' });
        }

        if (!cdpConnection && !(await ensureCDP())) {
            return res.status(503).json({ error: 'CDP not connected' });
        }

        if (forceQueue) {
            if (messageQueue.length >= MAX_QUEUED_MESSAGES) {
                return res.json({
                    success: false,
                    queued: false,
                    reason: 'queue_full',
                    queueSize: messageQueue.length,
                    details: { error: 'Message queue full (max ' + MAX_QUEUED_MESSAGES + ').' }
                });
            }
            const item = {
                id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
                text: message,
                timestamp: Date.now(),
                attempts: 0
            };
            messageQueue.push(item);
            console.log(`📋 Message force-queued (${messageQueue.length}/${MAX_QUEUED_MESSAGES}): "${message.substring(0, 50)}..."`);
            broadcastQueueUpdate(globalWss);
            return res.json({
                success: true,
                queued: true,
                queuePosition: messageQueue.length,
                id: item.id,
                details: { reason: 'Message queued for auto-send' }
            });
        }

        // Attempt direct injection first (works for both active send and IDE native queueing)
        const result = await Promise.race([
            injectMessage(cdpConnection, message),
            new Promise(resolve => setTimeout(() => resolve({ ok: false, reason: 'endpoint_timeout' }), 10000))
        ]);

        if (result.ok === false && (result.reason === 'busy' || result.reason === 'endpoint_timeout')) {
            if (messageQueue.length >= MAX_QUEUED_MESSAGES) {
                return res.json({
                    success: false,
                    queued: false,
                    reason: 'queue_full',
                    queueSize: messageQueue.length,
                    details: { error: 'Message queue full (max ' + MAX_QUEUED_MESSAGES + ').' }
                });
            }
            const item = {
                id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
                text: message,
                timestamp: Date.now(),
                attempts: 0
            };
            messageQueue.push(item);
            console.log(`📋 Message queued in fallback (${messageQueue.length}/${MAX_QUEUED_MESSAGES}): "${message.substring(0, 50)}..."`);
            broadcastQueueUpdate(globalWss);
            return res.json({
                success: true,
                queued: true,
                queuePosition: messageQueue.length,
                id: item.id,
                details: { reason: 'Agent busy — message queued for auto-send when ready' }
            });
        }

        res.json({
            success: result.ok !== false,
            queued: false,
            method: result.method || 'attempted',
            details: result
        });

        if (result.ok !== false && globalWss) {
            setTimeout(() => fetchAndBroadcastSnapshot(globalWss), 300);
            setTimeout(() => fetchAndBroadcastSnapshot(globalWss), 1200);
            setTimeout(() => fetchAndBroadcastSnapshot(globalWss), 2500);
        }
    });

    // Queue APIs
    app.get('/api/queue', async (req, res) => {
        let busy = false;
        try {
            if (cdpConnection) busy = await isAgentBusy(cdpConnection);
        } catch (e) { }
        res.json({
            count: messageQueue.length,
            max: MAX_QUEUED_MESSAGES,
            isAgentBusy: busy,
            items: messageQueue.map(m => ({
                id: m.id,
                text: m.text,
                timestamp: m.timestamp,
                attempts: m.attempts || 0
            }))
        });
    });

    app.post('/api/queue/clear', (req, res) => {
        const count = messageQueue.length;
        messageQueue.length = 0;
        console.log(`🗑️ Manually cleared queue (${count} messages)`);
        broadcastQueueUpdate(globalWss);
        res.json({ success: true, cleared: count });
    });

    app.post('/api/queue/send-now', async (req, res) => {
        if (messageQueue.length === 0) {
            return res.json({ success: false, error: 'Queue is empty' });
        }
        if (!cdpConnection && !(await ensureCDP())) {
            return res.status(503).json({ error: 'CDP not connected' });
        }
        const item = messageQueue[0];
        const result = await injectMessage(cdpConnection, item.text);
        if (result.ok !== false) {
            messageQueue.shift();
            broadcastQueueUpdate(globalWss);
            if (globalWss) {
                setTimeout(() => fetchAndBroadcastSnapshot(globalWss), 400);
            }
            return res.json({ success: true, message: 'Message sent', remaining: messageQueue.length });
        }
        res.json({ success: false, error: result.error || result.reason || 'Send failed' });
    });

    app.post('/api/queue/remove', (req, res) => {
        const { id } = req.body;
        const idx = messageQueue.findIndex(m => m.id === id);
        if (idx !== -1) {
            const removed = messageQueue.splice(idx, 1)[0];
            broadcastQueueUpdate(globalWss);
            return res.json({ success: true, removed });
        }
        res.status(404).json({ error: 'Message not found in queue' });
    });

    // UI Inspection endpoint - Returns all buttons as JSON for debugging
    app.get('/ui-inspect', async (req, res) => {
        if (!cdpConnection && !(await ensureCDP())) return res.status(503).json({ error: 'CDP disconnected' });

        const EXP = `(() => {
    try {
        // Safeguard for non-DOM contexts
        if (typeof window === 'undefined' || typeof document === 'undefined') {
            return { error: 'Non-DOM context' };
        }

        // Helper to get string class name safely (handles SVGAnimatedString)
        function getCls(el) {
            if (!el) return '';
            if (typeof el.className === 'string') return el.className;
            if (el.className && typeof el.className.baseVal === 'string') return el.className.baseVal;
            return '';
        }

        // Helper to pierce Shadow DOM
        function findAllElements(selector, root = document) {
            let results = Array.from(root.querySelectorAll(selector));
            const elements = root.querySelectorAll('*');
            for (const el of elements) {
                try {
                    if (el.shadowRoot) {
                        results = results.concat(Array.from(el.shadowRoot.querySelectorAll(selector)));
                    }
                } catch (e) { }
            }
            return results;
        }

        // Get standard info
        const url = window.location ? window.location.href : '';
        const title = document.title || '';
        const bodyLen = document.body ? document.body.innerHTML.length : 0;
        const hasCascade = !!document.getElementById('cascade') || !!document.querySelector('.cascade');

        // Scan for buttons
        const allLucideElements = findAllElements('svg[class*="lucide"]').map(svg => {
            const parent = svg.closest('button, [role="button"], div, span, a');
            if (!parent || parent.offsetParent === null) return null;
            const rect = parent.getBoundingClientRect();
            return {
                type: 'lucide-icon',
                tag: parent.tagName.toLowerCase(),
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                svgClasses: getCls(svg),
                className: getCls(parent).substring(0, 100),
                ariaLabel: parent.getAttribute('aria-label') || '',
                title: parent.getAttribute('title') || '',
                parentText: (parent.innerText || '').trim().substring(0, 50)
            };
        }).filter(Boolean);

        const buttons = findAllElements('button, [role="button"]').map((btn, i) => {
            const rect = btn.getBoundingClientRect();
            const svg = btn.querySelector('svg');

            return {
                type: 'button',
                index: i,
                x: Math.round(rect.left),
                y: Math.round(rect.top),
                text: (btn.innerText || '').trim().substring(0, 50) || '(empty)',
                ariaLabel: btn.getAttribute('aria-label') || '',
                title: btn.getAttribute('title') || '',
                svgClasses: getCls(svg),
                className: getCls(btn).substring(0, 100),
                visible: btn.offsetParent !== null
            };
        }).filter(b => b.visible);

        return {
            url, title, bodyLen, hasCascade,
            buttons, lucideIcons: allLucideElements
        };
    } catch (err) {
        return { error: err.toString(), stack: err.stack };
    }
})()`;

        try {
            // 1. Get Frames
            const { frameTree } = await cdpConnection.call("Page.getFrameTree");
            function flattenFrames(node) {
                let list = [{
                    id: node.frame.id,
                    url: node.frame.url,
                    name: node.frame.name,
                    parentId: node.frame.parentId
                }];
                if (node.childFrames) {
                    for (const child of node.childFrames) list = list.concat(flattenFrames(child));
                }
                return list;
            }
            const allFrames = flattenFrames(frameTree);

            // 2. Map Contexts
            const contexts = cdpConnection.contexts.map(c => ({
                id: c.id,
                name: c.name,
                origin: c.origin,
                frameId: c.auxData ? c.auxData.frameId : null,
                isDefault: c.auxData ? c.auxData.isDefault : false
            }));

            // 3. Scan ALL Contexts
            const contextResults = [];
            for (const ctx of contexts) {
                try {
                    const result = await cdpConnection.call("Runtime.evaluate", {
                        expression: EXP,
                        returnByValue: true,
                        contextId: ctx.id
                    });

                    if (result.result?.value) {
                        const val = result.result.value;
                        contextResults.push({
                            contextId: ctx.id,
                            frameId: ctx.frameId,
                            url: val.url,
                            title: val.title,
                            hasCascade: val.hasCascade,
                            buttonCount: val.buttons.length,
                            lucideCount: val.lucideIcons.length,
                            buttons: val.buttons, // Store buttons for analysis
                            lucideIcons: val.lucideIcons
                        });
                    } else if (result.exceptionDetails) {
                        contextResults.push({
                            contextId: ctx.id,
                            frameId: ctx.frameId,
                            error: `Script Exception: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description || ''} `
                        });
                    } else {
                        contextResults.push({
                            contextId: ctx.id,
                            frameId: ctx.frameId,
                            error: 'No value returned (undefined)'
                        });
                    }
                } catch (e) {
                    contextResults.push({ contextId: ctx.id, error: e.message });
                }
            }

            // 4. Match and Analyze
            const cascadeFrame = allFrames.find(f => f.url.includes('cascade'));
            const matchingContext = contextResults.find(c => c.frameId === cascadeFrame?.id);
            const contentContext = contextResults.sort((a, b) => (b.buttonCount || 0) - (a.buttonCount || 0))[0];

            // Prepare "useful buttons" from the best context
            const bestContext = matchingContext || contentContext;
            const usefulButtons = bestContext ? (bestContext.buttons || []).filter(b =>
                b.ariaLabel?.includes('New Conversation') ||
                b.title?.includes('New Conversation') ||
                b.ariaLabel?.includes('Past Conversations') ||
                b.title?.includes('Past Conversations') ||
                b.ariaLabel?.includes('History')
            ) : [];

            res.json({
                summary: {
                    frameFound: !!cascadeFrame,
                    cascadeFrameId: cascadeFrame?.id,
                    contextFound: !!matchingContext,
                    bestContextId: bestContext?.contextId
                },
                frames: allFrames,
                contexts: contexts,
                scanResults: contextResults.map(c => ({
                    id: c.contextId,
                    frameId: c.frameId,
                    url: c.url,
                    hasCascade: c.hasCascade,
                    buttons: c.buttonCount,
                    error: c.error
                })),
                usefulButtons: usefulButtons,
                bestContextData: bestContext // Full data for the best context
            });

        } catch (e) {
            res.status(500).json({ error: e.message, stack: e.stack });
        }
    });

    // Endpoint to list all CDP targets - helpful for debugging connection issues
    app.get('/cdp-targets', async (req, res) => {
        const results = {};
        for (const port of PORTS) {
            try {
                const list = await getJson(`http://127.0.0.1:${port}/json/list`);
                results[port] = list;
            } catch (e) {
                results[port] = e.message;
            }
        }
        res.json(results);
    });

    // WebSocket connection - Auth DISABLED
    wss.on('connection', (ws, req) => {
        console.log('📱 Client connected');

        ws.on('close', () => {
            console.log('📱 Client disconnected');
        });
    });

    return { server, wss, app, hasSSL };
}

// Main
async function main() {
    try {
        await initCDP();
    } catch (err) {
        console.warn(`⚠️  Initial CDP discovery failed: ${err.message}`);
        console.log('💡 Start Antigravity with --remote-debugging-port=9222 to connect.');
    }

    try {
        const { server, wss, app, hasSSL } = await createServer();

        // Start push-based background loop (health-check + observer injection)
        startBackgroundLoop(wss);

        // Remote Click
        app.post('/remote-click', async (req, res) => {
            const { selector, index, textContent } = req.body;
            if (!cdpConnection && !(await ensureCDP())) return res.status(503).json({ error: 'CDP disconnected' });
            const result = await clickElement(cdpConnection, { selector, index, textContent });
            res.json(result);
        });

        // Approve Action - Find and click approval buttons in IDE
        app.post('/approve-action', async (req, res) => {
            const { buttonText } = req.body;
            if (!cdpConnection && !(await ensureCDP())) return res.status(503).json({ error: 'CDP disconnected' });

            console.log(`[APPROVE] Looking for button: "${buttonText}"`);

            const EXP = `(async () => {
                try {
                    const btnText = ${JSON.stringify(buttonText || 'Run')};
                    
                    // Strategy 1: Find buttons by exact text match
                    const allButtons = Array.from(document.querySelectorAll('button, [role="button"]'));
                    let target = allButtons.find(btn => {
                        const text = (btn.innerText || btn.textContent || '').trim();
                        return text === btnText && btn.offsetParent !== null;
                    });

                    // Strategy 2: Case-insensitive partial match
                    if (!target) {
                        target = allButtons.find(btn => {
                            const text = (btn.innerText || btn.textContent || '').trim().toLowerCase();
                            return text.includes(btnText.toLowerCase()) && btn.offsetParent !== null;
                        });
                    }

                    // Strategy 3: Look for common action button patterns
                    if (!target) {
                        const actionPatterns = [
                            'button[data-testid*="approve"]',
                            'button[data-testid*="accept"]',
                            'button[data-testid*="run"]',
                            'button[data-testid*="allow"]',
                            'button[aria-label*="Run"]',
                            'button[aria-label*="Accept"]',
                            'button[aria-label*="Allow"]',
                            'button[aria-label*="Approve"]'
                        ];
                        for (const sel of actionPatterns) {
                            target = document.querySelector(sel);
                            if (target && target.offsetParent !== null) break;
                            target = null;
                        }
                    }

                    if (target) {
                        target.click();
                        return { success: true, clicked: (target.innerText || '').trim().substring(0, 50) };
                    }

                    // Debug: list visible buttons
                    const visibleBtns = allButtons
                        .filter(b => b.offsetParent !== null)
                        .map(b => (b.innerText || '').trim().substring(0, 30))
                        .filter(t => t.length > 0);
                    return { error: 'Button not found', searched: btnText, visibleButtons: visibleBtns.slice(0, 10) };
                } catch(e) {
                    return { error: e.toString() };
                }
            })()`;

            for (const ctx of cdpConnection.contexts) {
                try {
                    const res2 = await cdpConnection.call("Runtime.evaluate", {
                        expression: EXP,
                        returnByValue: true,
                        awaitPromise: true,
                        contextId: ctx.id
                    });
                    const val = res2.result?.value;
                    if (val?.success) {
                        console.log(`[APPROVE] ✅ Clicked: "${val.clicked}" in context ${ctx.id}`);
                        return res.json(val);
                    }
                } catch (e) { }
            }

            res.json({ error: 'Button not found in any context' });
        });

        // Remote Scroll - sync phone scroll to desktop
        app.post('/remote-scroll', async (req, res) => {
            const { scrollTop, scrollPercent } = req.body;
            if (!cdpConnection && !(await ensureCDP())) return res.status(503).json({ error: 'CDP disconnected' });
            const result = await remoteScroll(cdpConnection, { scrollTop, scrollPercent });
            res.json(result);
        });

        // Get App State
        app.get('/app-state', async (req, res) => {
            if (!cdpConnection) return res.json({ mode: 'Unknown', model: 'Unknown' });
            const result = await getAppState(cdpConnection);
            res.json(result);
        });

        // Workspace APIs
        app.get('/api/workspaces', (req, res) => {
            const data = getAvailableWorkspaces();
            res.json({ success: true, ...data });
        });

        app.post('/api/workspaces/create', (req, res) => {
            const { folderName, parentPath } = req.body;
            if (!folderName) return res.status(400).json({ error: 'Folder name is required' });
            const baseDir = parentPath || '/home/absolut7/Documents';
            const cleanName = folderName.replace(/[^a-zA-Z0-9_-]/g, '_');
            const targetPath = join(baseDir, cleanName);
            try {
                if (!fs.existsSync(targetPath)) {
                    fs.mkdirSync(targetPath, { recursive: true });
                }
                res.json({ success: true, path: targetPath, name: cleanName });
            } catch (e) {
                res.status(500).json({ error: e.message });
            }
        });

        app.post('/api/workspaces/open', async (req, res) => {
            const { path: folderPath, startChat } = req.body;
            if (!folderPath) return res.status(400).json({ error: 'Path is required' });
            const wsRes = await openWorkspaceFolder(folderPath);
            if (startChat && cdpConnection) {
                await new Promise(r => setTimeout(r, 600));
                await startNewChat(cdpConnection);
            }
            res.json(wsRes);
        });

        // Start New Chat (with optional workspace / folder switching)
        app.post('/new-chat', async (req, res) => {
            const { folderPath, newFolderName } = req.body || {};

            // If a new folder or workspace folder was chosen, switch to it first
            if (newFolderName) {
                const targetPath = join('/home/absolut7/Documents', newFolderName.replace(/[^a-zA-Z0-9_-]/g, '_'));
                await openWorkspaceFolder(targetPath);
            } else if (folderPath) {
                await openWorkspaceFolder(folderPath);
            }

            if (!cdpConnection && !(await ensureCDP())) return res.status(503).json({ error: 'CDP disconnected' });
            const result = await startNewChat(cdpConnection);

            // After creating new chat, activate agent mode with Ctrl+E
            if (result.success) {
                cachedCascadeCtxId = null; // Invalidate — new chat may change contexts
                await new Promise(r => setTimeout(r, 1000)); // Wait for chat to initialize
                try {
                    await cdpConnection.call("Input.dispatchKeyEvent", {
                        type: "keyDown", key: "e", code: "KeyE",
                        modifiers: 2, windowsVirtualKeyCode: 69, nativeVirtualKeyCode: 69
                    });
                    await cdpConnection.call("Input.dispatchKeyEvent", {
                        type: "keyUp", key: "e", code: "KeyE",
                        modifiers: 2, windowsVirtualKeyCode: 69, nativeVirtualKeyCode: 69
                    });
                    console.log('[NEW-CHAT] ✅ Sent Ctrl+E to activate agent mode');
                    result.agentMode = true;
                } catch (e) {
                    console.warn('[NEW-CHAT] ⚠️ Ctrl+E failed:', e.message);
                    result.agentMode = false;
                }
            }

            res.json(result);
        });

        // Get Chat History
        app.get('/chat-history', async (req, res) => {
            if (!cdpConnection) return res.json({ error: 'CDP disconnected', chats: [] });
            const result = await getChatHistory(cdpConnection);
            res.json(result);
        });

        // Select a Chat
        app.post('/select-chat', async (req, res) => {
            const { id, title } = req.body;
            if (!id && !title) return res.status(400).json({ error: "Chat id or title required" });
            if (!cdpConnection && !(await ensureCDP())) return res.status(503).json({ error: "CDP disconnected" });
            const result = await selectChat(cdpConnection, { id, title });
            res.json(result);
        });

        // Check if Chat is Open
        app.get('/chat-status', async (req, res) => {
            if (!cdpConnection) return res.json({ hasChat: false, hasMessages: false, editorFound: false });
            const result = await hasChatOpen(cdpConnection);
            res.json(result);
        });

        // Kill any existing process on the port before starting
        await killPortProcess(SERVER_PORT);

        // Start server
        const localIP = getLocalIP();
        const protocol = hasSSL ? 'https' : 'http';
        server.listen(SERVER_PORT, '0.0.0.0', () => {
            console.log(`🚀 Server running on ${protocol}://${localIP}:${SERVER_PORT}`);
            if (hasSSL) {
                console.log(`💡 First time on phone? Accept the security warning to proceed.`);
            }
        });

        // Graceful shutdown handlers
        const gracefulShutdown = (signal) => {
            console.log(`\n🛑 Received ${signal}. Shutting down gracefully...`);
            wss.close(() => {
                console.log('   WebSocket server closed');
            });
            server.close(() => {
                console.log('   HTTP server closed');
            });
            if (cdpConnection?.ws) {
                cdpConnection.ws.close();
                console.log('   CDP connection closed');
            }
            setTimeout(() => process.exit(0), 1000);
        };

        process.on('SIGINT', () => gracefulShutdown('SIGINT'));
        process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

    } catch (err) {
        console.error('❌ Fatal error:', err.message);
        process.exit(1);
    }
}

main();
