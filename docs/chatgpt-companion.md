# Connect your ChatGPT account

Milo offers **ChatGPT · My account** alongside its default on-device replies.
The website uses a hosted Codex app-server to start OpenAI device-code sign-in.
You do not need a local companion, terminal, pairing code, API key or software installation.
The filename of this guide is retained for existing links to the earlier companion implementation.

## Connect

1. Open **Conversation**, then select **ChatGPT · My account** under Reply provider.
2. Choose **Connect ChatGPT**. Copy the one-time code shown in Milo.
3. Choose **Open OpenAI** and enter that code on OpenAI's sign-in page. Confirm your own account.
4. Return to Milo. It checks automatically every three seconds while sign-in is pending.
5. Select a model available to your account, then prepare Milo's local voice and listening models when prompted.

Your account needs Codex access. OpenAI may require enabling device-code sign-in in your ChatGPT security settings.
Codes expire after about 15 minutes. **Get a new code** cancels the old attempt; **Cancel sign-in** stops polling that attempt.
This flow works through desktop and mobile browsers. Browser memory and cross-origin isolation support still determine whether local voice works on a particular device.

## Models and conversation

The model menu comes from your signed-in account, not a hard-coded list. Account limits and model availability apply.
Fast uses lighter supported reasoning effort; Better answers uses deeper effort. Hybrid chooses effort from the message and recent context.
The model you selected stays selected across modes. Milo sends bounded recent messages and its in-tab memory for each temporary turn.
Replies stream back and are spoken with Milo's Deepgram voice. GPU acceleration affects the device Qwen provider; OpenAI manages ChatGPT inference.
No browser, file, shell, coding or external-action tools are available to the model through this integration.

## Privacy and lifetime

| Data | Location and lifetime |
| --- | --- |
| Microphone recordings and speech synthesis | Visitor's device only |
| Messages, text transcriptions and conversation context | Passed through Milo's service to OpenAI only in ChatGPT mode |
| Chat history and memory | Current browser tab; not intentionally persisted by the adapter |
| Browser connection cookie | HttpOnly, Secure, SameSite=Strict; expires 24 hours after connection creation |
| ChatGPT credentials | Separate protected directory for each browser connection on Milo's host |
| Downloaded local models | Browser caches and origin-private storage; managed by Delete downloaded models |

**Disconnect ChatGPT** stops that session's Codex process, deletes its stored credential directory, clears the connection cookie and returns to local replies. This does not sign out your other OpenAI apps or other visitors.
Credentials otherwise expire with the connection after 24 hours. Cleanup runs every minute while the service is running and again at startup.
Reload defaults to on-device replies. Choose ChatGPT again to resume an unexpired connection. Closing a tab does not disconnect its account.
Clearing site cookies prevents reconnecting but does not immediately remove server credentials: use Disconnect first, or wait for expiry.
Switching to on-device replies preserves the optional connection until Disconnect or expiry; deleting local models does not disconnect ChatGPT.
Use OpenAI's own account controls if you also need to revoke authorization with OpenAI.

The adapter does not log prompts, tokens or upstream response bodies. OpenAI handles submitted text according to your account and its terms.
Milo's server operator necessarily administers the hosted credential storage. This is not an entirely on-device ChatGPT integration.
There is no automatic cloud fallback: on-device conversations remain on-device until you explicitly choose ChatGPT.

## Self-hosting and local development

Production uses `compose.dokploy.yml`: Nginx serves the app and model files, with only `/api/codex/` forwarded to the private `codex` service.
`deploy/Dockerfile.codex` installs pinned Codex CLI 0.153.4 and runs Node as a non-root user. Its named volume stores the per-session homes.
Only Nginx is routed publicly. Do not expose port 8791 or mount an administrator's Codex home into the service.
Set `MILO_PUBLIC_ORIGIN` to your exact HTTPS origin if changing the domain. Build and deploy the frontend and service together.

For development, install Node 24 and Codex CLI, run `npm run dev:codex`, then start the device frontend on port 5175.
Vite proxies `/api/codex/` to loopback port 8791. The default development origin is `http://127.0.0.1:5175`.
Set `MILO_CODEX_BIN` to an executable or Codex package `bin/codex.js` when automatic discovery is unavailable.
`MILO_CODEX_DATA` chooses the private data directory; it must not be a public asset directory or included in Git.

The service admits four resident Codex processes and up to 128 persisted browser connections, with a global limit of 12 login requests per minute.
Idle workers may be evicted and reconstructed from the same connection's credentials. Expired connections cannot authenticate requests.
These conservative limits are for the current host, not a claim of unlimited multi-user capacity.

The API accepts only status, device login/cancel, logout, reply and summary. Mutations require the exact Origin and JSON.
Browser session tokens are cryptographically random; only their hashes name server directories. No generic Codex RPC is exposed.
Each child has an allowlisted environment, isolated CODEX_HOME and empty workspace. A named permission profile denies root and credential access,
with environment tools disabled and only ephemeral threads. Disconnect waits for process exit before deleting its directory.

## Troubleshooting

- **No code or connection unavailable:** retry after a short wait. The hosted service may be restarting or at capacity.
- **OpenAI refuses device sign-in:** check ChatGPT security settings and account Codex access. Authenticate only on the OpenAI page linked by Milo.
- **Code expired:** choose Get a new code, then use only the new code.
- **No models or allowance exhausted:** check the account's Codex access and usage limits. Milo cannot grant access or reset limits.
- **Already replying in another tab:** stop that reply before starting another turn on the same connection.
- **Voice unavailable on a phone:** sign-in itself does not require native software; voice downloads and browser inference still need sufficient device resources.

## Validation

`node --test server/*.test.mjs` covers session isolation, cookie and Origin boundaries, restart persistence, expiry, admission limits,
stream cancellation, model validation and app-server protocol handling. Device UI tests cover consent, sign-in code lifecycle,
account model selection, local speech, context continuity, disconnect and safe refresh using mocked inference.
Real device-code creation is checked separately against OpenAI. A completed user sign-in and real account-backed reply require that user's authorization on OpenAI's page.

Protocol reference: [OpenAI app-server documentation](https://learn.chatgpt.com/docs/app-server).
