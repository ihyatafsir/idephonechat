#!/usr/bin/env python3
import json
import time
import urllib.request
import websocket
import argparse
import sys

def get_ide_ws_url(port="9222"):
    try:
        req = urllib.request.Request(f"http://localhost:{port}/json")
        with urllib.request.urlopen(req) as response:
            data = json.loads(response.read().decode())
            for page in data:
                if 'url' in page and ('workbench.html' in page['url'] or 'index.html' in page['url']):
                    return page.get('webSocketDebuggerUrl')
    except Exception as e:
        print(f"Error connecting to IDE CDP port {port}: {e}")
        return None
    return None

class CDPClient:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, suppress_origin=True)
        self.msg_id = 1

    def send(self, method, params=None):
        payload = {"id": self.msg_id, "method": method, "params": params or {}}
        self.ws.send(json.dumps(payload))
        self.msg_id += 1
        return json.loads(self.ws.recv())

    def evaluate(self, expression):
        return self.send("Runtime.evaluate", {
            "expression": expression,
            "awaitPromise": True,
            "returnByValue": True
        })

    def close(self):
        self.ws.close()

def main():
    parser = argparse.ArgumentParser(description="Clean IDE Delegation Tool")
    parser.add_argument("--prompt", type=str, required=True, help="The task prompt to send")
    parser.add_argument("--model", type=int, default=4, help="Model index (0-6). 4=Sonnet Thinking")
    parser.add_argument("--new-chat", action="store_true", help="Open a new chat tab first")
    parser.add_argument("--port", type=str, default="9222", help="CDP Port")
    args = parser.parse_args()

    ws_url = get_ide_ws_url(args.port)
    if not ws_url:
        print(f"IDE not found on port {args.port}. Ensure it was launched with --remote-debugging-port={args.port}")
        sys.exit(1)

    print(f"Connected to IDE: {ws_url}")
    cdp = CDPClient(ws_url)

    try:
        # 1. Open New Chat (simulate Ctrl+L if requested)
        if args.new_chat:
            print("Opening new chat tab...")
            # Dispatch Ctrl+L (modifiers: 2 = Ctrl)
            cdp.send("Input.dispatchKeyEvent", {"type": "rawKeyDown", "modifiers": 2, "windowsVirtualKeyCode": 76, "key": "l"})
            cdp.send("Input.dispatchKeyEvent", {"type": "keyUp", "modifiers": 2, "windowsVirtualKeyCode": 76, "key": "l"})
            time.sleep(1)

        # 2. Select Model via evaluated JS
        print(f"Selecting model index {args.model}...")
        js_model = f"""
            (function() {{
                try {{
                    const modelBtn = document.querySelector('[data-testid="model-selector-button"]') 
                        || Array.from(document.querySelectorAll('button')).find(b => b.textContent.includes('Model'));
                    if (modelBtn) {{
                        modelBtn.click();
                        setTimeout(() => {{
                            const options = document.querySelectorAll('[role="option"], [data-model-index="{args.model}"]');
                            if (options[{args.model}]) options[{args.model}].click();
                        }}, 200);
                        return true;
                    }}
                    return false;
                }} catch (e) {{ return e.toString(); }}
            }})()
        """
        cdp.evaluate(js_model)
        time.sleep(0.5)

        # 3. Inject Prompt and Send
        print("Injecting prompt...")
        # Escape the prompt for JS string injection
        safe_prompt = json.dumps(args.prompt)
        js_inject = f"""
            (function() {{
                const textarea = document.querySelector('textarea');
                if (!textarea) return 'No textarea found';
                
                // Set value and trigger React synthetic events
                const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
                nativeInputValueSetter.call(textarea, {safe_prompt});
                
                const ev2 = new Event('input', {{ bubbles: true }});
                textarea.dispatchEvent(ev2);
                
                // Click Send button
                setTimeout(() => {{
                    const sendBtn = document.querySelector('button[type="submit"]') || 
                                   Array.from(document.querySelectorAll('button')).find(b => b.innerHTML.includes('Send') || b.querySelector('svg'));
                    if (sendBtn && !sendBtn.disabled) {{
                        sendBtn.click();
                    }}
                }}, 300);
                
                return 'Injected and requested send';
            }})()
        """
        res = cdp.evaluate(js_inject)
        print("Result:", res)

    finally:
        cdp.close()
        print("Done.")

if __name__ == "__main__":
    main()
