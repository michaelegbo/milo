# Browser inference verification

These measurements were collected on **9 September 2026** against the device-only
development working tree on a Windows desktop. They verify specific browser
paths, not every device or the final public deployment. Production-domain checks
and the released commit must be recorded separately before claiming live support.

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

## Interface and remaining validation

`tests/device-ui.spec.ts` runs the real consent UI, request adapter, transcript,
and browser audio graph with deterministic audio/chat clients. Its verified
device-only run passed with no recorded failing tests. It covers explicit setup,
per-profile consent, unload/cancel, memory retention, unsupported-browser failure,
and desktop/mobile layout. A phone-sized viewport verifies layout, not mobile
model compatibility. Individual GPU-interface and local regression results must
be recorded from their final completed runs.

The independent code review confirmed that the production build selects the
browser request adapter, which does not call an inference API. Nginx accepts only
GET/HEAD and has no `/api/` service. Model loads use fixed asset URLs; chat text
and microphone samples are passed to local workers. The review also checked that
the chat worker exits its old model before loading another. A stale-worker error
callback issue identified during review was corrected with worker-identity
guards; GPU failure also clears the requested GPU state for explicit CPU retry.

Still outside the evidence above:

- Final public HTTPS deployment and exact released revision.
- Real Quality 4B inference, all five shards, and Hybrid switching to Quality
  under the final production CSP, until their separate run completes.
- Actual microphone capture and a complete live spoken conversation on the
  deployed site.
- Safari, Firefox, macOS, Linux, iPhone, Android, low-memory devices, and private
  browsing/storage restrictions.
- Full offline page reload: cached model reuse does not establish offline app
  installation or availability of all application assets.

Model allocation can fail even when capability checks pass. Such failures must
remain visible and recover locally; no test result authorizes or implies a
server-inference fallback.
