# Hosting the browser edition with Dokploy

The public deployment serves static files through Nginx. Three.js rendering,
Kokoro speech, Whisper transcription, and Qwen replies run on the visitor's device
in browser workers by default. A separate hosted Codex service supports optional
ChatGPT account connections. Only `/api/codex/` is proxied; other `/api/` routes
return `404`. Audio is never uploaded.

Opening the page loads the application and avatar. AI model downloads start only
after the visitor chooses **Download & start**. The production build downloads
models, voice vectors, and WebAssembly from the same site. Download requests do
not include chat text or microphone recordings. A reverse proxy or hosting provider
can still receive ordinary request metadata such as IP addresses and asset URLs.
There is no server inference fallback when a browser cannot run a model.

## Hosted ChatGPT service

The Compose file also builds `deploy/Dockerfile.codex`, pinned to Codex CLI 0.153.4.
This non-root service has one CPU, 2 GiB RAM and 256 processes as limits, with a read-only root and private writable account volume.
It exposes port 8791 only to the Compose network. Keep it off the public Dokploy domain list.
Set `MILO_PUBLIC_ORIGIN` to the exact website origin when self-hosting on another domain.
Nginx starts after its health check passes; both images carry the same source revision.
Read the [ChatGPT guide](chatgpt-companion.md) for credentials, expiry, disconnect and admission limits.
Do not copy the private account volume into public build artifacts or model directories.

## Hosted voice service

Milo's spoken voice is Deepgram Aura, reached only through the `voice` service in
`compose.dokploy.yml` (`deploy/Dockerfile.voice`, `server/voice-hosted.mjs`). Nginx
proxies `/api/voice/` to it on the Compose network, so the browser talks to Milo's
own origin and the content security policy stays `connect-src 'self'`.

Set `DEEPGRAM_API_KEY` in the Dokploy environment for the Compose service. The key
is read by the `voice` container only; it is never written to the image, the
repository or the browser. Without it the service reports `unconfigured`, and
Milo speaks with the on-device Kokoro voice instead, so a missing or revoked key
degrades to the previous behaviour rather than breaking speech. Rotate the key in
the Deepgram console whenever it may have been exposed, then redeploy.

The proxy accepts only `POST /api/voice/speak` with up to 600 characters of text
and one of Milo's voice ids, rejects cross-site requests that browsers label, and
limits each address to 60 requests and 60,000 characters per minute in front of
Nginx's own `limit_req` on the location. It streams 24 kHz PCM back as Deepgram
produces it and keeps finished clips in a 32 MB memory cache. It does not log text
or upstream response bodies. Preset clips in `public/presets` are rendered with the
same voices by `scripts/prepare-preset-audio.mjs` and committed with the site.

## Container and domain

1. Create a Dokploy Docker Compose service using `compose.dokploy.yml` and this
   repository as the build context. The Dockerfile uses Node only to build the
   frontend, then copies static output into the Nginx runtime image.
2. Set `MILO_BUILD_REVISION` to the full source commit being built. Optionally set
   `MILO_MODEL_DIRECTORY` to the absolute directory containing the prepared model
   assets on the deployment host; its default is `/opt/milo/models`.
3. Add an HTTPS domain in Dokploy targeting service `milo`, container port `8080`,
   path `/`. The example deployment uses `milo.seemplifyai.com`. Verify the
   generated proxy configuration before deploying. No host port mapping is needed.
4. Populate the model directory before enabling downloads for visitors. It is
   mounted read-only at `/usr/share/nginx/html/models` and must be readable by the
   container's `nginx` user. Models are not included in the image or downloaded by
   the running container.

The Compose service is limited to one CPU, 256 MiB RAM, and 64 processes, with a
read-only filesystem, a small writable `/tmp`, dropped capabilities, and rotated
logs. These limits cover static file serving; model inference uses each visitor's
CPU and memory. Large downloads consume server bandwidth and disk space.

The Dockerfile sets `VITE_MILO_DEVICE_ONLY=1` and
`VITE_AUDIO_MODEL_BASE=/models/` at build time. Changing a `VITE_` value requires a
new frontend build; changing the running Nginx environment does not reconfigure
the already built JavaScript. Model weights remain outside the image, so preserve
the host model directory across image updates and rollbacks.

## Model and runtime assets

The default static layout is:

```text
/opt/milo/models/
  manifest.json
  chat/
    fast.gguf
    quality-00001-of-00005.gguf
    quality-00002-of-00005.gguf
    quality-00003-of-00005.gguf
    quality-00004-of-00005.gguf
    quality-00005-of-00005.gguf
  onnx-community/Kokoro-82M-v1.0-ONNX/
    config.json
    tokenizer.json
    tokenizer_config.json
    onnx/model_quantized.onnx
  Xenova/whisper-base.en/
    config.json
    tokenizer.json
    tokenizer_config.json
    preprocessor_config.json
    generation_config.json
    onnx/encoder_model_quantized.onnx
    onnx/decoder_model_merged_quantized.onnx
```

Keep the complete configuration/tokenizer files with their matching weights.
`src/device/chat-models.ts` defines the model URLs. Quality uses five valid GGUF
shards produced by a compatible GGUF splitting tool; arbitrary byte splitting is
not valid. `manifest.json` records the prepared files, sizes, and checksums for
deployment verification. Validate model provenance and checksums before serving
the files, including any generated shards. Upstream model licenses still apply.

To reproduce the static model directory, run the included Python 3 preparation
script on the deployment host or a staging machine:

```sh
python3 scripts/prepare-host-models.py \
  --directory /opt/milo/models \
  --split-tool /path/to/llama-gguf-split \
  --audio-cache /path/to/local-milo/server/.cache
```

The audio-cache input must contain the complete working local Kokoro and Whisper
models. Omit it when those audio files are already in the static directory. The
script streams the two pinned Qwen downloads, verifies their expected SHA256
hashes, and invokes an existing compatible splitter. It checks shard names,
sizes, GGUF headers, and total tensor count, then writes checksums to the manifest.
It neither installs the splitter nor performs inference. The first deployment
used `llama-gguf-split` from llama.cpp build `b10868`. Allow roughly 10 GB of free
staging space for the source models, shards, and temporary copies. Prepare model
updates before directing visitors to them; the set of files is not replaced as
one atomic transaction.

`scripts/prepare-browser-assets.mjs` copies the installed ONNX Runtime WASM/module
files and the three Kokoro voice vectors into `public/runtime/`. The Docker build
runs this script before the frontend build. Vite bundles the chat worker and
wllama WASM assets. Keep those runtime assets matched to `package-lock.json`.

Approximate first-use model downloads are 92 MB for voice, 80 MB for listening,
1.1 GB for Fast replies, and another 2.5 GB for Quality. Hybrid can download both
reply models, about 3.6 GB combined, while keeping one reply model loaded at a
time. Downloads are smaller than the working memory needed for inference.

## HTTPS, isolation, and content security

Serve the complete application, runtime, and models over HTTPS. The supplied
`deploy/nginx.conf` sends `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`; the browser setup requires
`crossOriginIsolated`. It also sends `Cross-Origin-Resource-Policy: same-origin`.
Preserve these headers through the reverse proxy, including on worker and model
responses. An unrelated cross-origin embed or an overridden header can prevent
isolation. The Permissions Policy allows the microphone on this origin only.

The Content Security Policy permits same-origin scripts and downloads,
WebAssembly compilation through `'wasm-unsafe-eval'`, and same-origin or `blob:`
workers. `blob:` media supports generated audio; inline styles and data/blob
images support the current avatar interface. It disallows external connection
destinations and plugins. Do not add an external model host without deliberately
updating both the model URLs and relevant CSP/CORS/CORP policy.

## Browser requirements, caching, and stopping

A current desktop browser with WebAssembly, Web Workers, secure-context access,
and cross-origin isolation is the recommended starting point. The browser must
also provide enough memory and storage for the selected models. The setup screen
checks capabilities and reports model-loading failures. Microphone use still
requires the visitor's permission. A green capability check does not guarantee
that a large model will fit or run quickly.

Audio inference and cancellation have been verified in Chromium on Windows.
Do not infer universal Mac, Linux, Safari, Firefox, iPhone, or Android support from
that result. Phones and tablets can have tighter memory/storage limits; use Fast
first and treat other browser/device combinations as unverified until tested.
Audio uses CPU WebAssembly. Browser chat can use CPU WebAssembly or optional
WebGPU where a compatible adapter and model offloading are confirmed; availability
depends on the browser and device. If enabling acceleration fails, Milo attempts
CPU recovery. A later GPU model failure stays visible; explicit reload uses the
device's CPU. Neither path uses server inference. Test the GPU toggle on the target
browser before claiming accelerated support. The downloadable local application's
native GPU bridge is a separate feature.

Model files are cached in browser storage when available. The browser can evict
them, and private browsing or storage restrictions may prevent persistence.
**Free up memory** stops the workers and unloads models while keeping the current
chat in the tab. Closing the tab also releases its workers. Cached files may be
reused after a restart; stopping does not promise an entirely offline page load.
Clearing site data removes the model cache. Conversation text is not a shared
server session and is not a durable chat backup.

## Continuous integration and automatic deploys

`.github/workflows/ci.yml` runs on every push and pull request. It installs the
pinned dependencies, runs the deterministic server tests, builds the browser
edition with the production flags, checks that the nine preset clips are in the
build, and runs the browser suites that need no model weights. The suites that
drive real Kokoro, Whisper or Qwen weights are not run there; keep running them
locally before a release, as described below.

When main is green, the `deploy` job redeploys the public site. It needs one
repository secret, `DOKPLOY_DEPLOY_WEBHOOK`, holding the webhook URL of the
Dokploy `milo` service (Settings -> Secrets and variables -> Actions). Without
that secret the job warns and does nothing, so pushes stay green until it is
configured. Treat the URL as a credential: anyone holding it can trigger a
deploy, and the workflow never prints it or the response body. Enable Autodeploy
on the Dokploy service, keep its Git branch set to `main`, and let this workflow
call the webhook after verification. The request includes GitHub's push header
and event payload so Dokploy can validate the branch. An empty POST is rejected
as `Branch Not Match`. A separate repository push webhook is unnecessary and
would bypass the CI gate.

The job then waits up to fifteen minutes for the site to serve the exact bundle
filename that this commit produced. Vite names bundles by content, so that check
confirms the deployed code rather than a status string, and a stale build fails
the job while the previous version keeps serving. `MILO_BUILD_REVISION` still
comes from the Dokploy environment, so update it there when you want
`release.json` to report the commit; the job reports a mismatch as a note rather
than a failure.

Deploys are serialized through one concurrency group, and the job is attached to
the `production` environment, so required reviewers can be added there when a
deploy should wait for a human.

## Deployment verification and recovery

`GET /healthz` is the container's static liveness check. `GET /release.json`
returns the build revision and `processing: device-default`. Neither proves that
inference works on a visitor's browser.

Before sharing the URL, verify:

- HTTPS, the expected revision, isolation headers, and `crossOriginIsolated`.
- The page starts without model downloads; explicit setup downloads the chosen
  models, with progress and useful failures.
- A real generated voice clip, microphone transcription, and Fast/Quality/Hybrid
  replies on the browsers being claimed as supported.
- In the default provider, developer tools show conversation text and audio staying
  in the browser, with asset downloads only. Other inference API routes return `404`.
- ChatGPT opt-in obtains a real OpenAI code through `/api/codex/`; refresh preserves
  the pending connection, cancellation works, and Disconnect removes that session's
  credentials. Audio remains local. Test real replies after personal sign-in separately.
- Stop/unload, cache reuse, model switching, and separate tab histories work.

For a missing model, inspect its static URL, filename, read permissions, file size,
and checksum. Nginx returns `404` for absent model/runtime assets rather than the
app HTML. For browser out-of-memory errors, close other tabs, unload models, and
retry Fast. There is no hidden server path to enable. For infrastructure failures,
inspect Dokploy/container logs and restore the known working image while retaining
the matching model assets. Replacing files under an unchanged cacheable URL can
leave visitors using an old cached model; version URLs when changing weights.

## Separate local application

The repository still includes the original local Node speech/conversation server
for the downloadable application and `npm run dev` workflow. Its CPU/GPU runtime,
local model cache, and loopback API are separate from this static deployment.
Do not expose that single-user local API publicly or point the browser edition at
it as a fallback. See the repository README for local setup and verified hardware.
