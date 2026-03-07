# Antigravity Phone Chat

Remote control interface for Antigravity IDE via Chrome DevTools Protocol (CDP). Enables full chat interaction, model selection, and mode switching from mobile devices.

## Features

- **Full Chat Control** — Send messages, start new conversations, view chat history
- **Model Selection** — Switch between Gemini Pro/Flash, Claude Sonnet/Opus 4, GPT-o3, GPT-4.1
- **Mode Switching** — Toggle between Planning and Fast modes
- **Live Sync** — Real-time snapshot updates via WebSocket
- **Lisan al-Arab Banner** — Scrolling Arabic roots from 9,195-entry lexicon
- **IDE-Matched Theme** — VS Code Dark+ color scheme (#181818 background, #CCCCCC text)

## Setup

1. **Install Dependencies**
   ```bash
   cd antigravity_phone_chat
   npm install
   ```

2. **Configure Port** (optional)
   ```bash
   echo "PORT=3000" > .env
   ```

3. **Start Server**
   ```bash
   node server.js
   ```

4. **Access from Phone**
   - Connect to same network as desktop
   - Navigate to `http://<desktop-ip>:3000`
   - Accept security warning if using HTTPS

## Architecture

### CDP Integration
- **Port Discovery** — Auto-detects Antigravity on ports 9222, 9000-9003
- **Context Selection** — Scans all execution contexts, prefers cascade panel (richest content)
- **Multi-Context Fallback** — Tries all contexts until successful result found

### Key Endpoints
| Endpoint | Function |
|----------|----------|
| `/app-state` | Returns current mode & model |
| `/chat-status` | Checks if chat/editor is open |
| `/send` | Injects message into IDE |
| `/new-chat` | Starts new conversation |
| `/set-model` | Switches AI model |
| `/api/lisan` | Serves Arabic roots for banner |

### Fixed Bugs
All 5 CDP functions (`captureSnapshot`, `hasChatOpen`, `getAppState`, `injectMessage`, `setModel`) were returning results from the **wrong execution context** (workbench instead of cascade panel). Fixed by:
1. Trying **all** execution contexts
2. Preferring contexts with successful/richest results
3. Falling back to error results only if no context succeeds

## Lisan al-Arab Integration

- **Data Source** — `lisanclean.json` (9,195 Arabic root entries)
- **API** — `/api/lisan` returns random groupings of 3-5 roots
- **Refresh** — Frontend fetches new data every 60 seconds
- **Display** — Green neon scrolling text with transliterations

## Color Scheme

Matches Antigravity IDE (VS Code Dark+):
```css
--bg-app: #181818        /* Chat container */
--bg-panel: #1E1E1E      /* Input/panels */
--border: #2B2B2B        /* Separators */
--text-main: #CCCCCC     /* Text */
--accent: #007FD4        /* Focus/active */
--code-bg: #000000       /* Code blocks */
```

## Development

- **Server** — `server.js` (Express + WebSocket)
- **Frontend** — Vanilla JS (`public/js/app.js`)
- **Styling** — CSS variables (`public/css/style.css`)

## Verification

All endpoints tested and working:
- ✅ Mode detection: `Planning`
- ✅ Model detection: `Claude Opus 4.6 (Thinking)`
- ✅ Message sending: `success: true, method: click_submit`
- ✅ Model switching: `success: true`
- ✅ New chat: `success: true, method: data-tooltip-id`
- ✅ Lisan API: 50 Arabic root sentences
