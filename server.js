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
import { dirname, join } from 'path';
import { inspectUI } from './ui_inspector.js';
import { execSync, spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORTS = [9022, 9222, 9000, 9001, 9002, 9003];
const HEALTH_CHECK_INTERVAL = 30000; // 30s health check (reduced CDP load)
const FALLBACK_SNAPSHOT_INTERVAL = 120000; // 120s — only if no push received
const PUSH_FETCH_THROTTLE = 2000; // Min 2s between server-side snapshot fetches (snappier updates)
const SERVER_PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || 'antigravity';
const AUTH_COOKIE_NAME = 'ag_auth_token';
let AUTH_TOKEN = 'ag_default_token';

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
const MAX_QUEUED_MESSAGES = 5;
let isProcessingQueue = false;

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
            const pids = result.trim().split('\n').filter(p => p);
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

// Helper: HTTP GET JSON
function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

// Find Antigravity CDP endpoint
// Find Antigravity CDP endpoint
async function discoverCDP() {
    const errors = [];
    for (const port of PORTS) {
        try {
            const list = await getJson(`http://127.0.0.1:${port}/json/list`);

            // Priority 1: Standard Workbench (The main window)
            const workbench = list.find(t => t.url?.includes('workbench.html') || (t.title && t.title.includes('workbench')));
            if (workbench && workbench.webSocketDebuggerUrl) {
                console.log('Found Workbench target:', workbench.title);
                return { port, url: workbench.webSocketDebuggerUrl };
            }

            // Priority 2: Jetski/Launchpad (Fallback)
            const jetski = list.find(t => t.url?.includes('jetski') || t.title === 'Launchpad');
            if (jetski && jetski.webSocketDebuggerUrl) {
                console.log('Found Jetski/Launchpad target:', jetski.title);
                return { port, url: jetski.webSocketDebuggerUrl };
            }
        } catch (e) {
            errors.push(`${port}: ${e.message}`);
        }
    }
    const errorSummary = errors.length ? `Errors: ${errors.join(', ')}` : 'No ports responding';
    throw new Error(`CDP not found. ${errorSummary}`);
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

// Lightweight "is agent busy?" probe — only checks the cancel button, no inject attempt
// Returns true if agent is busy (cancel button visible), false if idle
async function isAgentBusy(cdp) {
    if (!cdp || cdp.ws?.readyState !== WebSocket.OPEN) return true; // Assume busy if no connection

    // Try cached cascade context first, then scan up to 2
    const ctxIds = [];
    if (cachedCascadeCtxId && cdp.contexts.some(c => c.id === cachedCascadeCtxId)) {
        ctxIds.push(cachedCascadeCtxId);
    }
    for (const ctx of cdp.contexts) {
        if (ctx.origin?.includes('extension') || ctx.name?.includes('worker')) continue;
        if (!ctxIds.includes(ctx.id)) ctxIds.push(ctx.id);
        if (ctxIds.length >= 2) break;
    }

    for (const ctxId of ctxIds) {
        try {
            const result = await Promise.race([
                cdp.call("Runtime.evaluate", {
                    expression: `(() => {
                        const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
                        if (cancel && cancel.offsetParent !== null) return "busy";
                        const editor = document.querySelector('[data-lexical-editor="true"][contenteditable="true"][role="textbox"]');
                        if (editor && editor.offsetParent !== null) return "idle";
                        return "unknown";
                    })()`,
                    returnByValue: true,
                    contextId: ctxId
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500))
            ]);
            const val = result.result?.value;
            if (val === "busy") return true;
            if (val === "idle") return false;
        } catch (e) { /* try next context */ }
    }
    return true; // Unknown = assume busy
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
        for (const ctx of cdp.contexts) {
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
    // Overall timeout: never let this function hang > 12s
    return Promise.race([
        _injectMessageInner(cdp, text),
        new Promise(resolve => setTimeout(() => resolve({ ok: false, error: 'inject_timeout_12s' }), 12000))
    ]);
}

async function _injectMessageInner(cdp, text) {
    // Wait for contexts (brief)
    if (cdp.contexts.length === 0) {
        await new Promise(r => setTimeout(r, 500));
        if (cdp.contexts.length === 0) {
            return { ok: false, error: 'no_contexts_available' };
        }
    }

    // Step 1: Find cascade context (use cache first, then scan max 3)
    let cascadeCtxId = null;
    let alreadyInAgentMode = false;

    // Try cached context first (instant)
    if (cachedCascadeCtxId && cdp.contexts.some(c => c.id === cachedCascadeCtxId)) {
        try {
            const result = await Promise.race([
                cdp.call("Runtime.evaluate", {
                    expression: `(() => {
                        const isCascade = document.querySelector('[data-tooltip-id="cascade-header-menu"]') ||
                                          document.querySelector('[data-tooltip-id="new-conversation-tooltip"]') ||
                                          document.querySelector('[data-tooltip-id="history-tooltip"]');
                        if (!isCascade) return "wrong_context";
                        const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
                        if (cancel && cancel.offsetParent !== null) return "busy";
                        const editor = document.querySelector('[data-lexical-editor="true"][contenteditable="true"][role="textbox"]') ||
                                       document.querySelector('div[contenteditable="true"][role="textbox"]');
                        if (editor && editor.offsetParent !== null) return "agent_ready";
                        return "ready";
                    })()`,
                    returnByValue: true,
                    contextId: cachedCascadeCtxId
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))
            ]);
            const val = result.result?.value;
            if (val === "busy") return { ok: false, reason: "busy" };
            if (val === "agent_ready") { cascadeCtxId = cachedCascadeCtxId; alreadyInAgentMode = true; }
            else if (val === "ready") { cascadeCtxId = cachedCascadeCtxId; }
            else { cachedCascadeCtxId = null; } // Cache invalid
        } catch (e) { cachedCascadeCtxId = null; }
    }

    // Scan contexts if cache missed (limit to 3, skip obviously-wrong ones)
    if (!cascadeCtxId) {
        let scanned = 0;
        for (const ctx of cdp.contexts) {
            // Skip extension/worker contexts
            if (ctx.origin?.includes('extension') || ctx.name?.includes('worker')) continue;
            if (scanned++ >= 3) break; // Max 3 context probes
            try {
                const result = await Promise.race([
                    cdp.call("Runtime.evaluate", {
                        expression: `(() => {
                            const isCascade = document.querySelector('[data-tooltip-id="cascade-header-menu"]') ||
                                              document.querySelector('[data-tooltip-id="new-conversation-tooltip"]') ||
                                              document.querySelector('[data-tooltip-id="history-tooltip"]');
                            if (!isCascade) return "wrong_context";
                            const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
                            if (cancel && cancel.offsetParent !== null) return "busy";
                            const editor = document.querySelector('[data-lexical-editor="true"][contenteditable="true"][role="textbox"]') ||
                                           document.querySelector('div[contenteditable="true"][role="textbox"]');
                            if (editor && editor.offsetParent !== null) return "agent_ready";
                            return "ready";
                        })()`,
                        returnByValue: true,
                        contextId: ctx.id
                    }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))
                ]);
                const val = result.result?.value;
                if (val === "busy") { cachedCascadeCtxId = ctx.id; return { ok: false, reason: "busy" }; }
                if (val === "agent_ready") { cascadeCtxId = ctx.id; cachedCascadeCtxId = ctx.id; alreadyInAgentMode = true; break; }
                if (val === "ready") { cascadeCtxId = ctx.id; cachedCascadeCtxId = ctx.id; break; }
            } catch (e) { }
        }
    }

    if (!cascadeCtxId) {
        return { ok: false, error: "cascade_not_found" };
    }

    // Step 2: Ctrl+E for agent mode (only if needed)
    if (!alreadyInAgentMode) {
        try {
            await cdp.call("Input.dispatchKeyEvent", {
                type: "keyDown", key: "e", code: "KeyE",
                modifiers: 2, windowsVirtualKeyCode: 69, nativeVirtualKeyCode: 69
            });
            await cdp.call("Input.dispatchKeyEvent", {
                type: "keyUp", key: "e", code: "KeyE",
                modifiers: 2, windowsVirtualKeyCode: 69, nativeVirtualKeyCode: 69
            });
            console.log('[INJECT] Sent Ctrl+E');
        } catch (e) {
            return { ok: false, error: "ctrl_e_failed: " + e.message };
        }
    }

    // Wait for agent mode (reduced from 800ms)
    await new Promise(r => setTimeout(r, 400));

    // Step 3: Focus editor and type
    try {
        const focusResult = await Promise.race([
            cdp.call("Runtime.evaluate", {
                expression: `(() => {
                    let editor = document.querySelector('[data-lexical-editor="true"][contenteditable="true"][role="textbox"]');
                    if (!editor) editor = document.querySelector('div[contenteditable="true"][role="textbox"]');
                    if (!editor) {
                        const cascadePanel = document.querySelector('#cascade, #conversation, #chat');
                        if (cascadePanel) {
                            const editables = [...cascadePanel.querySelectorAll('[contenteditable="true"]')]
                                .filter(el => el.offsetParent !== null);
                            editor = editables.at(-1);
                        }
                    }
                    if (!editor) return { ok: false, error: "editor_not_found" };
                    editor.focus();
                    const sel = window.getSelection();
                    if (sel) sel.selectAllChildren(editor);
                    document.execCommand('delete');
                    return { ok: true };
                })()`,
                returnByValue: true,
                contextId: cascadeCtxId
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2000))
        ]);

        if (focusResult.result?.value?.ok === false) {
            return { ok: false, error: focusResult.result.value.error || "focus_failed" };
        }

        await cdp.call("Input.insertText", { text });
        console.log('[INJECT] Typed text');

        await new Promise(r => setTimeout(r, 200));
    } catch (e) {
        return { ok: false, error: "insert_exception: " + e.message };
    }

    // Step 4: Click send button (reduced timeout from 8s to 3s)
    await new Promise(r => setTimeout(r, 300));

    try {
        const clickResult = await Promise.race([
            cdp.call("Runtime.evaluate", {
                expression: `(async () => {
                    let submit = null;
                    for (let retry = 0; retry < 4; retry++) {
                        submit = document.querySelector('[data-tooltip-id="input-send-button-send-tooltip"]');
                        if (submit && !submit.disabled) break;
                        submit = document.querySelector("svg.lucide-arrow-right")?.closest("button");
                        if (submit && !submit.disabled) break;
                        submit = document.querySelector('[data-tooltip-id="input-send-button-pending-tooltip"]');
                        if (submit && !submit.disabled) break;
                        submit = null;
                        await new Promise(r => setTimeout(r, 150));
                    }
                    if (submit && !submit.disabled) {
                        submit.click();
                        return { ok: true, method: "agent_mode_submit" };
                    }
                    return { ok: false, error: "send_btn_not_found" };
                })()`,
                returnByValue: true,
                awaitPromise: true,
                contextId: cascadeCtxId
            }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
        ]);

        if (clickResult.result?.value) {
            return clickResult.result.value;
        }
    } catch (e) {
        return { ok: false, error: "click_timeout: " + e.message };
    }

    return { ok: false, error: "click_failed" };
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

// Stop Generation
async function stopGeneration(cdp) {
    // Step 1: Find the cascade-panel context and try clicking the cancel button
    for (const ctx of cdp.contexts) {
        try {
            const res = await Promise.race([
                cdp.call("Runtime.evaluate", {
                    expression: `(() => {
                        // Verify cascade-panel context
                        const isCascade = document.querySelector('[data-tooltip-id="cascade-header-menu"]') ||
                                          document.querySelector('[data-tooltip-id="new-conversation-tooltip"]') ||
                                          document.querySelector('[data-tooltip-id="history-tooltip"]');
                        if (!isCascade) return { skip: true };
                        
                        // Look for the cancel button
                        const cancel = document.querySelector('[data-tooltip-id="input-send-button-cancel-tooltip"]');
                        if (cancel && cancel.offsetParent !== null) {
                            cancel.click();
                            return { success: true, method: "cancel_click" };
                        }
                        
                        // Fallback: square icon button
                        const stopBtn = document.querySelector('button svg.lucide-square')?.closest('button');
                        if (stopBtn && stopBtn.offsetParent !== null) {
                            stopBtn.click();
                            return { success: true, method: "square_click" };
                        }
                        
                        return { error: "No active generation found to stop" };
                    })()`,
                    returnByValue: true,
                    contextId: ctx.id
                }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000))
            ]);

            const val = res.result?.value;
            if (val?.skip) continue;
            if (val?.success) return val;
            if (val?.error) {
                // Found cascade panel but no cancel button — try Escape key via CDP
                try {
                    await cdp.call("Input.dispatchKeyEvent", {
                        type: "keyDown", key: "Escape", code: "Escape", keyCode: 27
                    });
                    await cdp.call("Input.dispatchKeyEvent", {
                        type: "keyUp", key: "Escape", code: "Escape", keyCode: 27
                    });
                    return { success: true, method: "escape_key" };
                } catch (e) {
                    return val;
                }
            }
        } catch (e) { }
    }
    return { error: 'Cascade panel not found in any context' };
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
            modelBtn = document.querySelector('[data-tooltip-id*="model"], [data-tooltip-id*="provider"]');
            
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
            
            // Try specific dialog patterns first
            const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="listbox"], [role="menu"], [data-radix-popper-content-wrapper]'));
            visibleDialog = dialogs.find(d => d.offsetHeight > 0 && d.innerText?.includes('${modelName}'));
            
            // Fallback: look for positioned divs
            if (!visibleDialog) {
                visibleDialog = Array.from(document.querySelectorAll('div'))
                    .find(d => {
                        const style = window.getComputedStyle(d);
                        return d.offsetHeight > 0 && 
                               (style.position === 'absolute' || style.position === 'fixed') && 
                               d.innerText?.includes('${modelName}') && 
                               !d.innerText?.includes('Files With Changes');
                    });
            }

            if (!visibleDialog) {
                // Blind search across entire document as last resort
                const allElements = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"]'));
                const target = allElements.find(el => 
                    el.offsetParent !== null && 
                    (el.innerText?.trim() === '${modelName}' || el.innerText?.includes('${modelName}'))
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
            
            // B. Page contains Model
            if (!target) {
                target = validEls.find(el => el.textContent.includes('${modelName}'));
            }

            // C. Closest partial match
            if (!target) {
                const partialMatches = validEls.filter(el => '${modelName}'.includes(el.textContent.trim()));
                if (partialMatches.length > 0) {
                    partialMatches.sort((a, b) => b.textContent.trim().length - a.textContent.trim().length);
                    target = partialMatches[0];
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

// Start New Chat - Use Agent Manager Shortcut Ctrl+L
async function startNewChat(cdp) {
    try {
        console.log('[NEW-CHAT] ⌨️ Sending Ctrl+L to trigger new Agent Chat');
        // Press Ctrl
        await cdp.call("Input.dispatchKeyEvent", {
            type: "keyDown", key: "Control", code: "ControlLeft",
            modifiers: 2, windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17
        });
        // Press E
        await cdp.call("Input.dispatchKeyEvent", {
            type: "keyDown", key: "e", code: "KeyE",
            modifiers: 2, windowsVirtualKeyCode: 69, nativeVirtualKeyCode: 69
        });
        // Release E
        await cdp.call("Input.dispatchKeyEvent", {
            type: "keyUp", key: "e", code: "KeyE",
            modifiers: 2, windowsVirtualKeyCode: 69, nativeVirtualKeyCode: 69
        });
        // Release Ctrl
        await cdp.call("Input.dispatchKeyEvent", {
            type: "keyUp", key: "Control", code: "ControlLeft",
            modifiers: 0, windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17
        });
        return { success: true, method: 'cdp_shortcut_ctrl_l' };
    } catch (e) {
        console.error('[NEW-CHAT] ❌ Shortcut failed:', e.message);
        return { error: 'Shortcut failed: ' + e.message };
    }
}
// Get Chat History - Two-phase: click in iframe context, scrape from parent context
async function getChatHistory(cdp) {
    // Phase 1: Click the history button (runs in iframe context where button lives)
    const CLICK_EXP = `(async () => {
        try {
            let historyBtn = document.querySelector('[data-tooltip-id="history-tooltip"]');
            if (!historyBtn) {
                historyBtn = document.querySelector('[data-tooltip-id*="history"], [data-tooltip-id*="past"], [data-tooltip-id*="recent"]');
            }
            if (!historyBtn) {
                const newChatBtn = document.querySelector('[data-tooltip-id="new-conversation-tooltip"]');
                if (newChatBtn) {
                    const parent = newChatBtn.parentElement;
                    if (parent) {
                        const siblings = Array.from(parent.children).filter(el => el !== newChatBtn);
                        historyBtn = siblings.find(el => el.tagName === 'A' || el.tagName === 'BUTTON' || el.getAttribute('role') === 'button');
                    }
                }
            }
            if (!historyBtn) return { clicked: false };
            historyBtn.click();
            return { clicked: true };
        } catch(e) {
            return { clicked: false, error: e.toString() };
        }
    })()`;

    // Phase 2: Scrape the history panel - tries cascade + workbench contexts
    const SCRAPE_EXP = `(async () => {
        try {
            const chats = [];
            const seenTitles = new Set();
            const SKIP = new Set(['current', 'current conversation', 'other conversations',
                'now', 'recent', 'blocked on your input', 'select a conversation',
                'no conversations', 'loading']);
            
            function isConversationTitle(text) {
                if (!text || text.length < 3 || text.length > 200) return false;
                const lower = text.toLowerCase();
                if (SKIP.has(lower)) return false;
                if (lower.endsWith(' ago')) return false;
                if (/^\\d+\\s*(sec|min|hr|day|wk|mo|yr|mins?|hours?|days?|weeks?)/i.test(lower)) return false;
                if (lower.startsWith('show ') && lower.includes('more')) return false;
                if (lower.startsWith('recent in ')) return false;
                if (/^[\\d:]+$/.test(lower)) return false; // timestamps
                return true;
            }
            
            function addChat(text) {
                text = text.trim();
                if (!isConversationTitle(text)) return false;
                if (seenTitles.has(text)) return false;
                seenTitles.add(text);
                chats.push({ title: text, date: 'Recent' });
                return true;
            }
            
            // Strategy 1: VS Code Quick Pick / Quick Input list items
            const listItems = document.querySelectorAll(
                '.monaco-list-row, .quick-input-list-entry, [role="listitem"], [role="option"], [role="treeitem"]'
            );
            for (const item of listItems) {
                const label = item.querySelector('.label-name, .label-description, .quick-input-list-label');
                const text = label?.textContent || item.querySelector('span')?.textContent || item.textContent;
                addChat(text || '');
                if (chats.length >= 50) break;
            }
            
            // Strategy 2: cursor-pointer items (custom Cascade UI)
            if (chats.length === 0) {
                const clickableItems = document.querySelectorAll('[class*="cursor-pointer"]');
                for (const item of clickableItems) {
                    const titleEl = item.querySelector('span[class*="truncate"], span[class*="text-sm"]') || item.querySelector('span');
                    if (titleEl) addChat(titleEl.textContent || '');
                    if (chats.length >= 50) break;
                }
            }
            
            // Strategy 3: Scan visible spans that look like conversation titles
            if (chats.length === 0) {
                const allSpans = document.querySelectorAll('span');
                for (const span of allSpans) {
                    if (span.offsetParent === null) continue; // not visible
                    addChat(span.textContent || '');
                    if (chats.length >= 50) break;
                }
            }
            
            // Debug info for troubleshooting when empty
            let debug = null;
            if (chats.length === 0) {
                const allRoles = [...new Set([...document.querySelectorAll('[role]')].map(el => el.getAttribute('role')))];
                const visibleInputs = [...document.querySelectorAll('input')].filter(i => i.offsetParent !== null).map(i => i.placeholder).slice(0, 5);
                const monacoRows = document.querySelectorAll('.monaco-list-row').length;
                const allSpanCount = [...document.querySelectorAll('span')].filter(s => s.offsetParent !== null && s.textContent.length > 3).length;
                debug = { allRoles: allRoles.slice(0, 10), visibleInputs, monacoRows, visibleSpanCount: allSpanCount };
            }
            
            return { found: true, success: true, chats, debug };
        } catch(e) {
            return { found: false, error: e.toString() };
        }
    })()`;

    // Phase 1: Click the history button in the cascade iframe context
    let clicked = false;
    let cascadeCtxId = null;
    for (const ctx of cdp.contexts) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: CLICK_EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value?.clicked) {
                clicked = true;
                cascadeCtxId = ctx.id;
                break;
            }
        } catch (e) { }
    }

    if (!clicked) {
        return { error: 'History button not found in any context', chats: [] };
    }

    // Wait for the panel to open
    await new Promise(r => setTimeout(r, 1500));

    // Phase 2: Scrape from ALL contexts — try cascade context first since panel may open there
    const contextsToTry = [
        ...cdp.contexts.filter(c => c.id === cascadeCtxId),
        ...cdp.contexts.filter(c => c.id !== cascadeCtxId)
    ];

    let bestResult = null;
    for (const ctx of contextsToTry) {
        try {
            const res = await cdp.call("Runtime.evaluate", {
                expression: SCRAPE_EXP,
                returnByValue: true,
                awaitPromise: true,
                contextId: ctx.id
            });
            if (res.result?.value?.found) {
                const val = res.result.value;
                val._contextId = ctx.id;
                if (val.chats && val.chats.length > 0) {
                    // Close the panel after scraping
                    try {
                        await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
                        await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
                    } catch (e) { }
                    return val;
                }
                if (!bestResult || (val.debug && !bestResult.debug)) bestResult = val;
            }
        } catch (e) { }
    }

    // Close the panel even if we didn't find anything
    try {
        await cdp.call("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
        await cdp.call("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
    } catch (e) { }

    return bestResult || { success: true, chats: [], debug: { clicked, panelNotScraped: true } };
}

async function selectChat(cdp, chatTitle) {
    const safeChatTitle = JSON.stringify(chatTitle);

    const EXP = `(async () => {
    try {
        const targetTitle = ${safeChatTitle};

        // First, we need to open the history panel
        // Find the history button at the top (next to + button)
        const allButtons = Array.from(document.querySelectorAll('button, [role="button"]'));

        let historyBtn = null;

        // Find by icon type
        for (const btn of allButtons) {
            if (btn.offsetParent === null) continue;
            const hasHistoryIcon = btn.querySelector('svg.lucide-clock') ||
                btn.querySelector('svg.lucide-history') ||
                btn.querySelector('svg.lucide-folder') ||
                btn.querySelector('svg.lucide-clock-rotate-left');
            if (hasHistoryIcon) {
                historyBtn = btn;
                break;
            }
        }

        // Fallback: Find by position (second button at top)
        if (!historyBtn) {
            const topButtons = allButtons.filter(btn => {
                if (btn.offsetParent === null) return false;
                const rect = btn.getBoundingClientRect();
                return rect.top < 100 && rect.top > 0;
            }).sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);

            if (topButtons.length >= 2) {
                historyBtn = topButtons[1];
            }
        }

        if (historyBtn) {
            historyBtn.click();
            await new Promise(r => setTimeout(r, 600));
        }

        // Now find the chat by title in the opened panel
        await new Promise(r => setTimeout(r, 200));

        const allElements = Array.from(document.querySelectorAll('*'));

        // Find elements matching the title
        const candidates = allElements.filter(el => {
            if (el.offsetParent === null) return false;
            const text = el.innerText?.trim();
            return text && text.startsWith(targetTitle.substring(0, Math.min(30, targetTitle.length)));
        });

        // Find the most specific (deepest) visible element with the title
        let target = null;
        let maxDepth = -1;

        for (const el of candidates) {
            // Skip if it has too many children (likely a container)
            if (el.children.length > 5) continue;

            let depth = 0;
            let parent = el;
            while (parent) {
                depth++;
                parent = parent.parentElement;
            }

            if (depth > maxDepth) {
                maxDepth = depth;
                target = el;
            }
        }

        if (target) {
            // Find clickable parent if needed
            let clickable = target;
            for (let i = 0; i < 5; i++) {
                if (!clickable) break;
                const style = window.getComputedStyle(clickable);
                if (style.cursor === 'pointer' || clickable.tagName === 'BUTTON') {
                    break;
                }
                clickable = clickable.parentElement;
            }

            if (clickable) {
                clickable.click();
                return { success: true, method: 'clickable_parent' };
            }

            target.click();
            return { success: true, method: 'direct_click' };
        }

        return { error: 'Chat not found: ' + targetTitle };
    } catch (e) {
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
            if (res.result?.value) return res.result.value;
        } catch (e) { }
    }
    return { error: 'Context failed' };
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
        // Strategy: Find the clickable mode button which contains either "Fast" or "Planning"
        // It's usually a button or div with cursor:pointer containing the mode text
        const allEls = Array.from(document.querySelectorAll('*'));

        // Find elements that are likely mode buttons
        for (const el of allEls) {
            if (el.children.length > 0) continue;
            const text = (el.innerText || '').trim();
            if (text !== 'Fast' && text !== 'Planning') continue;

            // Check if this or a parent is clickable (the actual mode selector)
            let current = el;
            for (let i = 0; i < 5; i++) {
                if (!current) break;
                const style = window.getComputedStyle(current);
                if (style.cursor === 'pointer' || current.tagName === 'BUTTON') {
                    state.mode = text;
                    break;
                }
                current = current.parentElement;
            }
            if (state.mode !== 'Unknown') break;
        }

        // Fallback: Just look for visible text
        if (state.mode === 'Unknown') {
            const textNodes = allEls.filter(el => el.children.length === 0 && el.innerText);
            if (textNodes.some(el => el.innerText.trim() === 'Planning')) state.mode = 'Planning';
            else if (textNodes.some(el => el.innerText.trim() === 'Fast')) state.mode = 'Fast';
        }

        // 2. Get Model
        // Strategy: Look for button containing a known model keyword
        const KNOWN_MODELS = ["Gemini", "Claude", "GPT"];
        const textNodes = allEls.filter(el => el.children.length === 0 && el.innerText);
        const modelEl = textNodes.find(el => {
            const txt = el.innerText;
            return KNOWN_MODELS.some(k => txt.includes(k)) &&
                // Check if it's inside a button or near a chevron SVG (model selector)
                (el.closest('button')?.querySelector('svg[class*="chevron"]') ||
                 el.closest('button')?.querySelector('svg.lucide-chevron-up') ||
                 el.closest('button')?.querySelector('svg.lucide-chevron-down') ||
                 el.closest('[role="button"]') ||
                 el.closest('button'));
        });

        if (modelEl) {
            state.model = modelEl.innerText.trim();
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
    if (observerInjected) return true;
    if (!cdp || cdp.contexts.length === 0) return false;

    const INJECT_SCRIPT = `(function() {
        if (window.__agObserverActive) return 'already_active';

        const cascade = document.getElementById('conversation') || document.getElementById('chat') || document.getElementById('cascade');
        if (!cascade) return 'no_container';

        // Debounce timer
        let debounceTimer = null;
        const DEBOUNCE_MS = 500;

        // LIGHTWEIGHT: Only sends a tiny signal — no DOM cloning on the IDE thread
        function pushSignal() {
            try {
                window.agPushSnapshot(JSON.stringify({ changed: true, t: Date.now() }));
            } catch (err) {
                // Silently fail — don't crash the IDE
            }
        }

        // MutationObserver — fires on any DOM change in the chat
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
        window.__agObserverDisconnect = () => { observer.disconnect(); window.__agObserverActive = false; };

        // Push an initial signal immediately
        setTimeout(pushSignal, 100);

        return 'injected';
    })()`;

    // Find the right context to inject into
    let targetCtxId = cachedSnapshotCtxId;

    if (!targetCtxId || !cdp.contexts.some(c => c.id === targetCtxId)) {
        // Scan for the correct context using a lightweight probe
        for (const ctx of cdp.contexts) {
            try {
                const probe = await cdp.call("Runtime.evaluate", {
                    expression: `!!(document.getElementById('conversation') || document.getElementById('chat') || document.getElementById('cascade'))`,
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
    }

    if (!targetCtxId) {
        console.log('⏳ No chat container found for observer injection (IDE may still be loading)');
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
            console.log('👁️  MutationObserver injected — push mode active');
            return true;
        } else if (result === 'already_active') {
            observerInjected = true;
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
async function startBackgroundLoop(wss) {
    let isConnecting = false;

    // Wire up the push handler on the CDP connection
    // Now receives lightweight "changed" signals and fetches snapshot server-side
    function wirePushHandler() {
        if (!cdpConnection) return;
        cdpConnection.onPush = (payload) => {
            lastPushTime = Date.now();

            // payload is now just { changed: true, t: ... } — a lightweight signal
            if (!payload.changed) return;

            const now = Date.now();
            const elapsed = now - lastPushFetchTime;

            if (elapsed >= PUSH_FETCH_THROTTLE) {
                // Enough time has passed — fetch immediately
                fetchAndBroadcastSnapshot(wss);
            } else if (!pendingPushFetch) {
                // Schedule a fetch after the throttle window
                pendingPushFetch = true;
                const delay = PUSH_FETCH_THROTTLE - elapsed;
                setTimeout(() => {
                    pendingPushFetch = false;
                    fetchAndBroadcastSnapshot(wss);
                }, delay);
            }
            // else: a fetch is already scheduled, skip
        };
    }

    // Server-side snapshot fetch (runs via CDP, not in-page)
    async function fetchAndBroadcastSnapshot(wss) {
        if (!cdpConnection) return;
        lastPushFetchTime = Date.now();
        try {
            const snapshot = await Promise.race([
                captureSnapshot(cdpConnection),
                new Promise(resolve => setTimeout(() => resolve(null), 8000)) // 8s timeout (was 3s, but large DOM eval takes longer under heavy terminal load)
            ]);
            if (snapshot && snapshot !== '__unchanged__' && !snapshot.error) {
                const hash = hashString(snapshot.html);
                if (hash !== lastSnapshotHash) {
                    lastSnapshot = snapshot;
                    lastSnapshotHash = hash;
                    broadcastSnapshotUpdate(wss);
                    console.log(`📡 Push-triggered snapshot (hash: ${hash})`);
                }
            }
        } catch (e) {
            console.error('Push-triggered snapshot error:', e.message);
        }
    }

    // Initial wiring
    wirePushHandler();

    const healthCheck = async () => {
        // --- 1. CDP Connection Health ---
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
                    wirePushHandler();
                }
            } catch (err) { /* wait for next cycle */ }
            // Exponential backoff: 3s -> 6s -> 12s -> 24s -> cap at 30s
            reconnectAttempts++;
            const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, reconnectAttempts - 1), RECONNECT_MAX_MS);
            setTimeout(healthCheck, delay);
            return;
        }

        // --- 2. Observer Injection ---
        if (!observerInjected) {
            try {
                await injectObserver(cdpConnection);
            } catch (e) {
                console.warn('Observer injection attempt failed:', e.message);
            }
        }

        // --- 3. CSS Cache Refresh (infrequent, lightweight) ---
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
                        // Update existing snapshot CSS if we have one
                        if (lastSnapshot) {
                            lastSnapshot.css = cachedCSS;
                            if (lastSnapshot.stats) lastSnapshot.stats.cssSize = cachedCSS.length;
                        }
                    }
                }
            } catch (e) { /* keep old cache */ }
        }

        // --- 4. Fallback: if no push received in 30s and clients connected, do ONE snapshot ---
        const hasClients = wss.clients.size > 0;
        if (hasClients && (now - lastPushTime) > FALLBACK_SNAPSHOT_INTERVAL && observerInjected) {
            console.log('⚡ Fallback snapshot (no push received in 30s)');
            try {
                const snapshot = await Promise.race([
                    captureSnapshot(cdpConnection),
                    new Promise(resolve => setTimeout(() => resolve(null), 6000))
                ]);
                if (snapshot && snapshot !== '__unchanged__' && !snapshot.error) {
                    const hash = hashString(snapshot.html);
                    if (hash !== lastSnapshotHash) {
                        lastSnapshot = snapshot;
                        lastSnapshotHash = hash;
                        broadcastSnapshotUpdate(wss);
                        console.log(`📸 Fallback snapshot updated (hash: ${hash})`);
                    }
                }
                lastPushTime = now; // Reset timer even if unchanged
            } catch (e) {
                console.error('Fallback snapshot error:', e.message);
            }
        }

        // Queue processing moved to independent startQueueDrainLoop (5s interval)

        setTimeout(healthCheck, HEALTH_CHECK_INTERVAL);
    };

    healthCheck();

    // --- Independent queue drain loop (5s) ---
    // Separated from healthCheck so queued messages don't wait 30s
    function startQueueDrainLoop() {
        setInterval(async () => {
            if (messageQueue.length === 0 || isProcessingQueue) return;
            if (!cdpConnection || cdpConnection.ws?.readyState !== WebSocket.OPEN) return;

            isProcessingQueue = true;
            try {
                // Lightweight busy check (<1.5s) instead of full injectMessage (12s)
                const busy = await isAgentBusy(cdpConnection);
                if (busy) {
                    // Still busy — drop stale messages (>5 min old)
                    const age = Math.round((Date.now() - messageQueue[0].timestamp) / 1000);
                    if (age > 300) {
                        const dropped = messageQueue.shift();
                        console.log(`🗑️ Dropped stale queued message (${age}s old): "${dropped.text.substring(0, 40)}..."`);
                    }
                    return;
                }
                // Agent is idle — send the queued message
                const result = await injectMessage(cdpConnection, messageQueue[0].text);
                if (result.reason === 'busy') {
                    // Race condition: became busy between check and inject — leave in queue
                    return;
                }
                const sent = messageQueue.shift();
                console.log(`✅ Queue: sent message "${sent.text.substring(0, 40)}..." (${messageQueue.length} remaining)`);
                setTimeout(() => fetchAndBroadcastSnapshot(wss), 1000);
            } catch (e) {
                console.error('Queue drain error:', e.message);
            } finally {
                isProcessingQueue = false; // Always reset — never gets stuck
            }
        }, 5000); // Check every 5 seconds
    }

    startQueueDrainLoop();
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

    // Upload Image (attach picture to IDE chat)
    app.post('/upload-image', async (req, res) => {
        const { name, dataUrl } = req.body;
        if (!dataUrl) return res.status(400).json({ error: 'No image data' });
        if (!cdpConnection && !(await ensureCDP())) return res.status(503).json({ error: 'CDP disconnected' });

        try {
            // Decode base64 and save to temp file
            const matches = dataUrl.match(/^data:(.+);base64,(.+)$/);
            if (!matches) return res.status(400).json({ error: 'Invalid data URL' });

            const ext = matches[1].split('/')[1] || 'png';
            const buffer = Buffer.from(matches[2], 'base64');
            const tmpPath = join(os.tmpdir(), `antigravity_upload_${Date.now()}.${ext}`);
            fs.writeFileSync(tmpPath, buffer);

            console.log(`[UPLOAD] Saved image to ${tmpPath} (${buffer.length} bytes)`);

            // Use CDP to inject the file into the IDE's file input
            // First, find the file input in the IDE
            const contexts = cdpConnection.contexts || [];
            let uploaded = false;

            for (const ctx of contexts) {
                try {
                    // Find file input element
                    const evalRes = await cdpConnection.call('Runtime.evaluate', {
                        expression: 'document.querySelector("input[type=file]")',
                        contextId: ctx.id
                    });

                    if (evalRes.result && evalRes.result.objectId && evalRes.result.subtype !== 'null') {
                        // Get nodeId from the object
                        const nodeRes = await cdpConnection.call('DOM.requestNode', {
                            objectId: evalRes.result.objectId
                        });

                        // Set the file
                        await cdpConnection.call('DOM.setFileInputFiles', {
                            nodeId: nodeRes.nodeId,
                            files: [tmpPath]
                        });

                        console.log(`[UPLOAD] Injected file into IDE context ${ctx.id}`);
                        uploaded = true;
                        break;
                    }
                } catch (ctxErr) {
                    // Context might not have DOM access
                }
            }

            if (uploaded) {
                res.json({ success: true, path: tmpPath });
            } else {
                // File saved but couldn't find IDE input - still useful
                res.json({ success: true, path: tmpPath, note: 'File saved but no file input found in IDE' });
            }
        } catch (e) {
            console.error('[UPLOAD] Error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // Stop Generation
    app.post('/stop', async (req, res) => {
        if (!cdpConnection && !(await ensureCDP())) return res.status(503).json({ error: 'CDP disconnected' });
        const result = await stopGeneration(cdpConnection);
        res.json(result);
    });

    // Restart IDE - Kill antigravity and restart with debug port
    app.post('/restart-ide', async (req, res) => {
        console.log('🔄 Restart IDE requested...');
        try {
            // Close existing CDP connection first
            if (cdpConnection && cdpConnection.ws) {
                try { cdpConnection.ws.close(); } catch (e) { }
                cdpConnection = null;
            }

            // Kill all antigravity processes EXCEPT this server
            const myPid = process.pid;
            try {
                // pgrep -f antigravity returns PIDs separated by newlines
                const pids = execSync('pgrep -f "antigravity" || true', { encoding: 'utf8' }).trim().split('\n');

                // Filter out empty strings and our own PID
                const toKill = pids.filter(pid => pid && pid.trim().length > 0 && pid.trim() !== String(myPid));

                if (toKill.length > 0) {
                    execSync(`kill ${toKill.join(' ')}`, { stdio: 'pipe' });
                    console.log(`  ✅ Killed antigravity processes: ${toKill.join(', ')}`);
                } else {
                    console.log('  ⚠️  No other antigravity processes found');
                }
            } catch (e) {
                console.log('  ⚠️  Error killing processes:', e.message);
            }

            // Wait for processes to die
            await new Promise(r => setTimeout(r, 2000));

            // Start antigravity with debug port
            const child = spawn('antigravity', ['--remote-debugging-port=9222'], {
                detached: true,
                stdio: 'ignore',
                env: { ...process.env }
            });
            child.unref();
            console.log('  🚀 Started antigravity --remote-debugging-port=9222 (PID:', child.pid, ')');

            // Wait for IDE to boot and CDP to become available
            res.json({ success: true, message: 'IDE restarting...', pid: child.pid });

            // Reconnect CDP after IDE boots (in background)
            setTimeout(async () => {
                for (let attempt = 0; attempt < 15; attempt++) {
                    try {
                        const endpoint = await discoverCDP();
                        cdpConnection = await connectCDP(endpoint.url);
                        console.log('  ✅ CDP reconnected after restart');
                        return;
                    } catch (e) {
                        console.log(`  ⏳ CDP reconnect attempt ${attempt + 1}/15...`);
                        await new Promise(r => setTimeout(r, 3000));
                    }
                }
                console.error('  ❌ Failed to reconnect CDP after restart');
            }, 5000);

        } catch (e) {
            console.error('Restart IDE error:', e);
            res.status(500).json({ error: e.message });
        }
    });

    // Send message
    app.post('/send', async (req, res) => {
        const { message } = req.body;

        if (!message) {
            return res.status(400).json({ error: 'Message required' });
        }

        if (!cdpConnection && !(await ensureCDP())) {
            return res.status(503).json({ error: 'CDP not connected' });
        }

        // Timeout the inject so the /send endpoint never hangs
        const result = await Promise.race([
            injectMessage(cdpConnection, message),
            new Promise(resolve => setTimeout(() => resolve({ ok: false, reason: 'endpoint_timeout' }), 10000))
        ]);

        // If agent is busy (terminal running), queue the message instead of dropping it
        if (result.reason === 'busy') {
            if (messageQueue.length >= MAX_QUEUED_MESSAGES) {
                return res.json({
                    success: false,
                    queued: false,
                    reason: 'queue_full',
                    queueSize: messageQueue.length,
                    details: { error: 'Message queue full (max ' + MAX_QUEUED_MESSAGES + '). Agent is busy.' }
                });
            }
            messageQueue.push({ text: message, timestamp: Date.now() });
            console.log(`📋 Message queued (${messageQueue.length}/${MAX_QUEUED_MESSAGES}): "${message.substring(0, 50)}..."`);
            return res.json({
                success: true,
                queued: true,
                queuePosition: messageQueue.length,
                details: { reason: 'Agent busy — message queued for auto-send when idle' }
            });
        }

        // Always return 200 - the message usually goes through even if CDP reports issues
        // The client will refresh and see if the message appeared
        res.json({
            success: result.ok !== false,
            method: result.method || 'attempted',
            details: result
        });
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
        console.log('💡 Start Antigravity with --remote-debugging-port=9000 to connect.');
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

        // Start New Chat
        app.post('/new-chat', async (req, res) => {
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
            const { title } = req.body;
            if (!title) return res.status(400).json({ error: 'Chat title required' });
            if (!cdpConnection && !(await ensureCDP())) return res.status(503).json({ error: 'CDP disconnected' });
            const result = await selectChat(cdpConnection, title);
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
