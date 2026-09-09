# Browser inference verification

These measurements were collected on **9 September 2026** on a Windows desktop.
The public device-only application at **https://milo.seemplifyai.com** passed the
real browser journeys below on runtime revision
`80c4d3420fd98fac6fc34af729705b79473880b1`, confirmed through `/release.json`.
Earlier isolated development checks are recorded separately. These results cover
specific paths on the tested computer, not every browser or device.

## Public application: real voice and conversation

A fresh headless Google Chrome context loaded the deployed production bundles
and used the visible controls. No inference clients were mocked and no source
modules were imported by the harness. Passive Web Audio instrumentation measured
the actual generated buffers. The browser reported HTTPS, cross-origin isolation,
JSPI, 16 hardware threads, and WebGPU support.

| Check | Measured result |
| --- | --- |
| Before consent | No model downloads or inference API requests; the setup panel remained unloaded. |
| Voice setup | The visible download action prepared Kokoro in 6.247 seconds. |
| Sentence studio | “Let Milo speak” started actual audio in 8.548 seconds: 5.15 seconds of speech, peak 0.503 and RMS 0.059. |
| Talking motion | Two captured speech frames showed the mouth opening and the arm/body pose changing while real audio played. |
| Conversation setup | Whisper and Fast became ready in 22.866 seconds after voice setup. |
| Fast CPU turn | “My name is Rowan. Say hello in one short sentence.” produced “Hello, Rowan!” First text arrived in 16.013 seconds and playback began in 19.183 seconds. |
| Hybrid and GPU | Selecting Hybrid and turning on GPU preserved the mode; GPU preparation took 3.163 seconds. The hardware label was “Browser WebGPU.” |
| Hybrid quick turn | “Hello Milo!” produced “Hello again, Rowan! How can I help you today?” with the Quick reply route. First text arrived in 0.977 seconds and audio began in 4.327 seconds. |
| Unload | “Free up memory” stopped the models and retained the transcript in the tab. |
| Network and errors | 48 requests; zero non-GET/HEAD, external, inference API, or Quality-model requests; zero page or console errors, including CSP violations. |

The CPU and GPU prompts differed; these timings do not establish a speedup ratio.
This run initiated GPU OFF and then unloaded. The separate spoken test below
waited for CPU restoration and verified another complete CPU reply. Evidence is
`work/production-device-report.json` from `work/verify-production-device.mjs`.

## Public spoken turn and completed GPU OFF

A second fresh Chrome context used its **synthetic microphone** flags with the
existing generated speech fixture: 8.525 seconds of mono 16 kHz PCM audio. The
application used the real browser recorder, Whisper, Qwen, and Kokoro. The
capture device was reported as “Fake Default Audio Input”; no physical microphone
was opened. Automatic repeat listening and interruption were disabled to keep the
test to one controlled spoken turn.

| Check | Measured result |
| --- | --- |
| Capture | One synthetic microphone capture; the input meter registered audio and every captured track ended. |
| Real transcription | “Hello! I am your three-dimensional avatar. My voice is generated locally, using only your CPU.” appeared after 11.702 seconds from recording start. |
| Reply and playback | Fast Qwen repeated the fixture wording; actual Kokoro playback began after 14.914 seconds from recording start. This verifies the pipeline, not answer quality. |
| GPU OFF completion | CPU became ready in 2.164 seconds, the switch was off, and the status explicitly confirmed GPU memory release. Fast remained selected. |
| Reply after GPU OFF | A new typed request produced and spoke “Hello!” on CPU. |
| Cleanup | Model unload completed, the transcript remained, and the isolated browser context closed. |
| Network and errors | 53 requests; zero non-GET/HEAD, external, inference API, or Quality-model requests; zero page or console errors. |

Evidence is `work/production-spoken-report.json` from
`work/verify-production-spoken.mjs`; the report records the full runtime revision
above. The fake-device test covers browser capture and the deployed spoken flow.
It does not validate a person's microphone permission prompt, physical microphone
hardware, acoustic echo cancellation, or noisy-room recognition.

Public HTTP checks in `work/verify-milo-host.mjs` also verify asset availability,
GGUF byte ranges, isolation headers, and rejection of inference API/POST requests.
They explicitly require JavaScript MIME types for both ORT `.mjs` entry points:
serving these modules as `application/octet-stream` prevents browser startup.
The live revision includes that MIME correction and permits the locally embedded
font data used by the compiled application. The HTTP report is
`work/milo-host-verification.json`. The rejection probes contain no chat or audio
data; they are separate from the browser request counts above.

## Real browser audio

The audio harness used Playwright Chromium with actual Kokoro q8 and Whisper
base.en q8 models. Models were served from local static paths matching production.
The final run applied the exact Content Security Policy from `deploy/nginx.conf`,
plus the production COOP, COEP, and CORP headers.

| Check | Measured result |
| --- | --- |
| Voice generation | Michael produced a 5.7-second, 273,644-byte PCM WAV in 7.774 seconds. |
| Non-silent output | Decoded waveform RMS was 0.06195. |
| Transcription | Whisper transcribed that WAV in 2.441 seconds. |
| Transcript | “Hello, my name is Milo. This voice is running in your browser.” |
| Repeat generation | The identical utterance used the tab's generated-audio cache. |
| Model-cache restart | After worker disposal, reinitialization succeeded with all model-network requests deliberately blocked. |
| Stop during generation | The request rejected with `AbortError`, and the voice worker became unloaded. Abort settlement rounded to 0 ms. |
| Recovery | After cancellation, cached startup succeeded and Emma produced an 84,044-byte WAV. |
| Network | 51 requests, including 11 model requests; zero external requests and zero uploads. |
| Content security | Generation, transcription, cached restart, and cancellation completed under the production audio security policy. |

Heart was exercised by initialization warm-up, Michael by the round trip, and
Emma by recovery. This is a synthetic audio round trip, not a test of a physical
microphone, browser microphone permission, echo cancellation, or noisy-room
recognition. Timings include one particular computer and workload; they are not
latency guarantees for visitors.

The scratch evidence was recorded as `work/browser-audio-qa-result.json` by
`work/browser-audio-qa.mjs`. Those local evidence paths are not required at runtime.
The committed `tests/device-audio.spec.ts` additionally passed three lifecycle
tests covering lazy startup and input validation, cancellation of only the owned
worker with stale events ignored, and release/retry after failed initialization.
Those three tests use a fake worker to make failure cases deterministic; the
measurements above used real model inference.

## Real browser Fast conversation and GPU switching

The chat harness used installed Chrome in headless mode on Windows, with the real
Qwen2.5 1.5B Q4_K_M model. The browser reported cross-origin isolation, JSPI support,
16 hardware threads, and a 32 GB device-memory hint. Browser memory hints are not
a measurement of free RAM. Chat used four CPU threads.

| Check | Measured result |
| --- | --- |
| Initial Fast CPU load | 6.804 seconds from the locally served model. |
| Explicit memory | The model answered “Your name is Jordan.” from the supplied context in 12.705 seconds; emitted text matched the final response. |
| Fresh request memory | A later request supplied Morgan instead, producing “Your name is Morgan.” in 13.396 seconds without retaining Jordan. |
| Stop during reply | The request rejected with `AbortError` about 0.315 ms after cancellation; health became unloaded. |
| Cached reload | Reinitializing Hybrid with Fast resident required zero additional model GET requests. |
| Browser GPU load | 2.992 seconds; runtime logs confirmed 29 model layers offloaded. |
| Fast WebGPU reply | “Hello! How can I help you today?” completed in 1.068 seconds; first text arrived at 1.024 seconds. |
| Turn GPU off during reply | The active reply stopped and the model returned to ready CPU state, with zero GPU layers reported. |
| Rapid GPU on/off | The superseded on request rejected; the final off request completed with CPU ready and acceleration disabled. |
| Network and browser errors | One initial model GET, zero POST requests, zero external requests, and no recorded page errors. |

These CPU and GPU prompts differed, so the results do **not** establish a speedup
ratio. The fresh-memory check used separate requests in one tab, not a two-user
or cross-tab test. This Fast GPU run used isolation headers; the stricter final
production chat CSP check is a separate verification step. Its scratch evidence
is `work/device-chat-report.json` from `work/verify-device-chat.mjs`.

## Real Quality, Hybrid, and production chat CSP

A subsequent Chrome run loaded the actual five Qwen3 4B GGUF shards under the
literal `deploy/nginx.conf` CSP and the production COOP/COEP/CORP headers. It used
the Windows host and four CPU threads. WebGPU offloading was confirmed by the
runtime; the application labels the adapter “Browser WebGPU.” The host has an
RTX 4090, but this run did not independently assert the browser adapter's identity.

| Check | Measured result |
| --- | --- |
| Cancel GPU setup | Rejected with `AbortError`, unloaded the worker, and left the acceleration state out of `switching`. |
| Fast GPU preparation | 29 GPU layers confirmed with Hybrid mode preserved. |
| Hybrid deep route | The sky-color explanation routed to Quality, loaded all five shards, and confirmed 37 GPU layers. |
| Quality GPU response | First text in 1.182 seconds; generation completed in 1.524 seconds. Model load plus reply took 11.065 seconds. |
| Returned content | Explained that shorter blue wavelengths scatter more readily in the atmosphere; emitted deltas matched the final response. |
| GPU off | Preserved Hybrid mode and the selected Quality model; CPU became ready with zero GPU layers. |
| Real Quality CPU reply | Supplied Casey in memory and received “Casey. That's your name.” in 34.575 seconds. |
| Return to Fast | A later Hybrid greeting routed to Fast and completed on CPU in 11.594 seconds, with zero additional model GET requests. |
| Network and CSP | Exactly one Fast model GET and five Quality shard GETs; zero POST/external requests, page errors, or CSP violations. |

This proves the tested Quality and Hybrid transitions with real models on that
browser. It does not establish every possible transition or a speed ratio between
different CPU and GPU prompts. The existing `connect-src 'self'` was sufficient;
the test did not relax it to allow external or `blob:` fetches. Evidence was saved
as `work/device-quality-report.json` by `work/verify-device-quality.mjs`.

## Interface regression checks and remaining validation

`tests/device-ui.spec.ts` passed six functional cases in 25.5 seconds, using the
real consent UI, request adapter, transcript, and browser audio graph with
deterministic audio/chat clients. Coverage includes explicit setup, per-profile
consent, unload/cancel, memory retention, unsupported-browser failure, GPU on/off
while warming or replying, and suppression of late text/audio. They assert zero
inference API requests and never open the physical microphone.

A seventh case then passed in 4.7 seconds against the actual unloaded application,
without client mocks or request interception. It found no model, model-client,
WASM, or inference API requests before consent. These runs used Chrome through
Playwright at 1440×1024 and 390×844. A phone-sized viewport verifies layout, not
mobile model compatibility. Captured layouts are `docs/images/milo-studio.png`
and `docs/images/milo-mobile.png`.

The device UI commands set `MILO_DEVICE_TEST_URL=http://127.0.0.1:5175`, with a
Vite server built for `VITE_MILO_DEVICE_ONLY=1`, and ran
`npx playwright test tests/device-ui.spec.ts`. Local scratch outputs were
`work/device-ui-gpu-final` for the first six and `work/device-ui-real` for the
subsequent `--grep "real unloaded"` case. Twelve local-application regression
tests also passed in 45.8 seconds across `gpu-acceleration.spec.ts`,
`streaming-speech.spec.ts`, and `conversation-memory-ui.spec.ts`, using the separate
local server on port 5176; their outputs were `work/device-local-regression-final`.
These interface/regression results do not establish real model throughput.
The release coordinator also recorded 33 passing deterministic Node tests for
the retained local application backend. That test result preserves confidence in
the downloadable local path; the public Nginx image does not run that backend.

The independent code review confirmed that the production build selects the
browser request adapter, which does not call an inference API. Nginx accepts only
GET/HEAD and has no `/api/` service. Model loads use fixed asset URLs; chat text
and microphone samples are passed to local workers. The review also checked that
the chat worker exits its old model before loading another. A stale-worker error
callback issue identified during review was corrected with worker-identity
guards; GPU failure also clears the requested GPU state for explicit CPU retry.

Still outside the evidence above:

- A person's physical microphone, its permission prompt, real acoustic echo
  cancellation, and recognition in a noisy room. The public spoken flow used a
  synthetic microphone fixture.
- Public Quality-model inference: the actual five shards passed the isolated
  production-CSP test above; the live browser journeys deliberately used Fast.
- Safari, Firefox, macOS, Linux, iPhone, Android, low-memory devices, and private
  browsing/storage restrictions.
- Full offline page reload: cached model reuse does not establish offline app
  installation or availability of all application assets.

Model allocation can fail even when capability checks pass. Such failures must
remain visible and recover locally; no test result authorizes or implies a
server-inference fallback.
