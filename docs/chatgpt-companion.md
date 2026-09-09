# ChatGPT replies in Milo

Milo can use your personal ChatGPT account through the official [Codex app-server](https://learn.chatgpt.com/docs/app-server). This is an optional reply provider. The default remains local Qwen inference, and Milo never changes providers automatically.

## Set up your computer

1. Use a current desktop browser on Windows, macOS or Linux. The companion must run on the same computer as the browser. An iPhone or Android browser cannot run the native Codex app-server directly.
2. Install Node.js 24 and the [Codex CLI](https://learn.chatgpt.com/docs/cli). The adapter was verified against `codex-cli 0.153.4`. If Codex is already available in your terminal, you can use it. For an npm installation, the official package is `@openai/codex`.
3. Download or clone Milo and open a terminal in its folder. The companion uses Node built-ins and does not need the native speech/model dependencies. You can run it directly with `node server/codex-bridge.mjs`, or use `npm run codex:bridge`.
4. Keep that terminal open. It displays a private, randomly generated pairing code. A new companion process gets a new code. Do not post it or share it with other people.
5. Open [Milo](https://milo.seemplifyai.com), choose **Conversation**, then **ChatGPT · My account** under **Reply provider**.
6. Paste the pairing code and click **Connect**. If the browser asks to access the local network, allow it for Milo to reach the companion on this computer.
7. Select **Sign in to ChatGPT**. Complete sign-in on OpenAI's page and return to Milo. If a popup is blocked, use **Continue sign-in**. You can cancel a pending sign-in from Milo.
8. Choose one of the models your account exposes, then **Download & start conversation** to prepare local voice and listening. Type a message or start the microphone.

The account must be eligible to use Codex. A personal ChatGPT login is not a promise of unlimited use or access to every model. The selected model consumes your account's applicable Codex allowance, not a Milo-hosted subscription. Milo does not request an API key.

### Locating Codex

The companion finds `codex` on your PATH. On Windows it supports both the desktop app's `codex.exe` and the standard npm `codex.cmd` installation by launching the underlying JavaScript entry point without a shell. If automatic detection fails, set `MILO_CODEX_BIN` to the full path of `codex.exe`, the Unix Codex executable, or the npm package's `bin/codex.js` before starting it. Do not set this to a shell command containing arguments.

No GPU toolkit, driver, startup service or system-wide Milo installation is required. Stop the companion with Ctrl+C. It binds only to `127.0.0.1:8790`; do not expose that port through a tunnel or reverse proxy.

## What stays local and what is sent

| Data or operation | Location |
| --- | --- |
| Avatar rendering | Browser GPU |
| Recorded microphone audio | Browser; transcribed locally by Whisper |
| Spoken reply audio | Generated locally by Kokoro on CPU |
| Typed text, transcribed text, recent messages and session memory | Sent through your local companion to OpenAI while ChatGPT is selected |
| ChatGPT model inference | OpenAI, using your signed-in account |
| Local Qwen replies | Your device while the local provider is selected |
| ChatGPT login credentials | Codex-managed storage under Milo's `.cache/milo-codex/home`; never returned to the browser or Milo's website host |
| Companion pairing code | Current tab's session storage; cleared by Disconnect |

Milo's VPS still serves static assets only. It does not receive conversation uploads or hold visitors' ChatGPT credentials. OpenAI's account terms and data controls apply to text sent to it. Temporary app-server threads are used; this does not assert that OpenAI retains no service data.

The adapter uses a separate `CODEX_HOME` and a blank workspace. Signing out here does not sign out the Codex desktop app or CLI using its ordinary home. Milo supplies conversation context afresh for each temporary turn, including its existing bounded memory. New chat clears that browser conversation. No prompt, token or upstream response-body logging is added by the companion.

## Modes and switching

- **Fast:** chooses a lighter thinking effort supported by the selected Codex model.
- **Better answers:** chooses a deeper supported effort.
- **Hybrid:** Milo's deterministic router chooses lighter/deeper effort for the current message and context.

All three use the model you selected. Availability comes from `model/list`, not a hardcoded catalogue. If a model disappears, reconnect and select another one. GPU settings affect local Qwen models only. Selecting a different provider stops the active turn; in the browser edition it also releases loaded local workers. Prepare audio again when prompted. Chat history stays in the current tab and is supplied to whichever provider you explicitly select.

**Disconnect** ends Milo's connection and returns to local replies; it does not revoke the companion's stored ChatGPT sign-in. **Sign out of ChatGPT** clears the companion's login through the official account/logout method. Reload defaults to local replies; the tab can use **Check connection** to reconnect after selecting ChatGPT again. Closing the browser tab discards its pairing credential. Browser session restoration may restore session storage, so use Disconnect to explicitly forget pairing.

Deleting downloaded models removes local model caches, not the companion's authentication. Sign out separately before removing a local Milo checkout or sharing its files. `.cache/` is excluded from Git and the Docker build.

## Recovery

- **Cannot reach companion:** keep the terminal running, check that port 8790 is free and re-copy its current pairing code. Allow local-network access when the browser prompts. Some browsers or organizational policies block HTTPS pages from reaching localhost; use a current compatible desktop browser. Do not disable browser security protections.
- **Sign-in does not finish:** use Continue sign-in, or Cancel sign-in and try again. OpenAI hosts authentication and Codex handles its localhost callback. Another login flow can occupy the callback port.
- **No models / rejected reply:** check ChatGPT/Codex eligibility, model access and account usage. Milo will not spend an API key or silently switch accounts.
- **Already replying in another tab:** one companion admits one generation at a time. Stop the other turn before retrying.
- **Voice unavailable:** prepare local models and check browser support, storage and memory. ChatGPT mode removes the Qwen memory requirement but still requires local voice processing.

## Implementation and verification

`server/codex-client.mjs` implements stdio JSON-RPC initialization, account methods, temporary threads, streaming final messages, turn interruption and cleanup. `server/codex-bridge.mjs` exposes only status, login/cancel, logout, reply and summary operations. It validates exact allowed origins, the literal loopback Host, a random bearer pairing code, message sizes and discovered model IDs. It rejects generic RPC and tool requests. The child uses an environment allowlist, read-only sandbox, disabled environment access, disabled shell/browser/app/plugin features and no dynamic tools. Milo is a conversational interface, not a coding-agent tool console.

The hosted Content Security Policy allows only the same origin plus the fixed loopback companion endpoint for connections. The default local-provider journey makes no companion requests. Audio is never sent to the companion.

Run the backend contract tests with:

```sh
node --test server/codex-bridge.test.mjs
```

Browser provider tests are part of `tests/device-ui.spec.ts` against the dedicated device-mode Vite server. They mock inference/auth while testing real controls, context, transport and speech playback. A real app-server smoke test verified initialization, official login URL creation/cancellation, and temporary read-only thread creation. A completed personal-account login and real account-backed reply still require the user's interactive OpenAI sign-in; mock tests must not be presented as proof of that account-specific step.
