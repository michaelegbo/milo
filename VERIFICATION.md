# Verification — 9 September 2026

The production build and TypeScript check passed. The final `npm test` run passed **31 deterministic backend tests and all 58 app/browser tests**; the latter completed in 5.7 minutes against the running local application. The real-GPU verifier passed CPU/GPU comparison, mixed Hybrid handoffs without reloads, turning acceleration off during generation, process exit and CPU recovery. The earlier real-CPU Hybrid verifier also passed Fast → Quality → Fast routing, retained personal details, cancellation, recovery, and no model reloads between turns.

## Tested behavior

- **Real CPU conversation:** Chrome's synthetic microphone recording → Whisper English transcription → Qwen reply → Kokoro WAV → nonzero browser audio analyser output. Continuous listening, manual interruption, stopping and switching modes release microphone tracks and prevent late audio.
- **Streaming:** incremental text exactly matches the final reply; completed sentences feed TTS rather than individual words. First audio can play before the response iterable finishes. Appended samples play once, downloaded WAV contains all generated segments, and pause/resume, gaps, cancellation and later-segment errors are covered. The backend preserves abbreviations, initials and decimals when bounding sentences.
- **Memory:** nine-turn browser flow, older-turn compaction, explicit name/colour corrections beyond the recent context window, visible memory, model switching, New chat clearing, and absence of transcript browser-storage persistence. A held summary survives automatic next-turn listening. Labelled excerpts provide an immediate bounded checkpoint while CPU refinement is pending.
- **Microphone controls:** exact device selection, enumeration without recording, real input meter, mute without cancelling an existing reply, no automatic capture from unmute, delayed permission cleanup, disconnected devices, and device changes during interruption monitoring. Sustained voice onset stops Milo and retains the same capture, including the opening words; End closes every track. Initial monitoring silence does not consume the next turn's 20-second limit.
- **Visual presence:** inspected idle/listening/thinking/speaking/rest captures, distinct eyes and brows, sound-driven mouth shapes, no microphone-driven mouth opening, bounded gestures, finite values under irregular frames, and reduced motion. Rendered reduced-motion tests keep the body still while speech still animates the mouth. Desktop and 390px mobile layouts were inspected without horizontal overflow or browser errors.
- **Model profiles:** real CPU Fast/Quality preparation, exact cache size and pinned SHA-256 checks, manual model switching, rejection while inference is active, recovery from a draining-worker 409, and adoption of a model selected in another tab without repeated reloads.
- **Hybrid:** real CPU Fast → Quality → Fast handoff with a routing event before streamed words, exact concatenation to the final answer, stable Hybrid mode, retained personal details, cancellation and queued recovery. Both resident models stayed ready and each load count remained one throughout that check. Deterministic tests cover RAM and Windows commit admission, dropping headroom, single-to-dual recovery, serial warm-up/inference, worker termination, model failure and retry. Browser tests cover routing labels, mobile layout, shared history/memory, stale-event cancellation, single-resident messaging and stream error/recovery without typed-chat microphone access.
- **Studio regression:** preset/custom speech, pause/resume/completion, WAV download, cancellation and retry, keyboard interaction, reduced motion, settings persistence, mobile layout and reconnecting to the speech engine.
- **API validation:** malformed, oversized and silent microphone audio; invalid history, memory and profiles; external-origin rejection; stream errors; disconnected clients; queue recovery. Quality summary checks preserve earlier facts and corrections, avoid inferred gender, and distinguish unknown identity from another request's history.

The Three.js bundle produces the existing size advisory: approximately 574 kB before gzip, 143 kB gzipped. This is a build advisory, not a failed check.

## Measured model samples

Both profiles were independently initialized from their verified caches with offline mode enabled. These timings are observations on this computer, not guarantees, and exclude TTS.

| Profile | First streamed text | Complete sample reply |
| --- | ---: | ---: |
| Fast — Qwen2.5 1.5B Q4_K_M | 1.17 s | 3.93 s |
| Better answers — Qwen3 4B Q4_K_M | 3.28 s | 11.37 s |

Quality passed unknown-name handling, a recent instrument correction, preservation of earlier name/location/instrument facts during summarization, recall using that summary, cancellation and recovery. Its longer-context recall and summary samples took around 30–34 seconds. Fast confused user identity with Milo's in some checks and omitted an older location from a summary. The UI's separately retained explicit facts reduce dependence on those summaries, but neither model guarantees correct answers.

Detailed local benchmark evidence is in `server/verification/chat-upgrades-fast-quality-report.json`; generated test artifacts live outside the deliverable source archive. Model weights and caches are excluded from the ZIP and download on first use on a new machine.

### Hybrid handoff sample

The running server prepared both models from cache, then completed this sequence using the same supplied history and personal facts. These are measured wall-clock timings on this computer, including local HTTP but excluding TTS; they vary with system load and context length.

| Turn | Selected model | First streamed text | Complete reply |
| --- | --- | ---: | ---: |
| “Hello Milo!” | Fast 1.5B | 2.17 s | 2.48 s |
| Recall home/learning topic and compare practice frequency | Quality 4B | 10.14 s | 15.12 s |
| “Thanks Milo!” | Fast 1.5B | 3.41 s | 4.43 s |

Quality correctly recalled Bristol and guitar, then explained an advantage of regular practice. A later Quality stream was cancelled after its first text, and the next Fast turn succeeded. Neither model reloaded. The result is saved in `server/verification/hybrid-report.json`. Routing itself uses deterministic rules; it does not measure model confidence, and the stronger route is still bounded to short spoken answers.

### GPU acceleration on this computer

The actual adapter is an NVIDIA GeForce RTX 4090 with 24 GB VRAM. The bridge selected the app's existing Vulkan runtime, isolated that adapter from the integrated AMD GPU, and offloaded 37 Quality-model layers. No driver, toolkit, global service or second copy of the model was installed. CPU remains the startup default.

The real `verify-acceleration.mjs` run passed using the same cached Quality model, prompt and supplied name/location facts on both devices. Both produced the identical 128-character answer, correctly recalling Amara and Bristol. Timings below exclude initial model loading and speech synthesis; they are single samples under this computer's current load, not throughput guarantees.

| Quality sample | First streamed text | Complete reply |
| --- | ---: | ---: |
| CPU | 8.833 s | 13.773 s |
| RTX 4090 / Vulkan | 0.130 s | 0.326 s |

This sample's complete reply was 42.25 times faster on GPU. Turning acceleration on and preparing Quality took 7.842 seconds separately. Faster model output does not eliminate CPU transcription, speech generation or audio playback time.

Accelerated Hybrid then kept Fast on CPU and Quality on GPU with both residents ready. Fast → Quality → Fast took 2.605 s, 0.165 s and 2.563 s to complete the tested turns. Each model's load count stayed at one across those handoffs, confirming that they did not reload. These turns have different prompts and context lengths and are not a CPU/GPU comparison.

Turning acceleration off after the first delta of a real GPU reply cancelled its stream with `chat_closed`, preserved Hybrid, restored CPU residents, and allowed a successful next CPU reply. A separate process check confirmed that the retired GPU process had exited. NVIDIA's total memory-used observation fell from 9,211 MiB during acceleration to 5,797 MiB afterward, a decrease of about 3.33 GiB; other applications also use GPU memory. Detailed evidence is in `server/verification/acceleration-report.json`.

Six GPU browser scenarios cover unavailable hardware, ON/OFF with retained history and memory, switching during streamed text and active audio, pending TTS cancellation, OFF while warming, shared revision changes, and truthful mixed CPU/GPU Hybrid states. Desktop and 390px mobile switch layouts were inspected. Backend tests additionally cover detection deadlines, no-download probing, rapid ON/OFF ordering, model/runtime replacement, one GPU context, low-memory fallback, GPU failure recovery, and blocking replacement after an unconfirmed process exit.

## Practical boundaries

- End-to-end runtime and GPU validation was performed on Windows with an RTX 4090. Linux execution is unverified. Apple Silicon's current CPU/default/off path needs native-runtime compatibility work; Metal detection alone does not certify the complete application. No browser WebGPU or direct iPhone/Android inference engine is implemented. See the platform matrix in [README.md](README.md).
- No physical microphone or room-acoustics test was performed. Capture and interruption checks used synthetic audio through Chrome's actual MediaStream/AudioWorklet/Web Audio path. Browser echo cancellation is requested; headphones reduce speaker feedback.
- Mouth shapes approximate sound energy and frequency bands; they are not phoneme-timed lip sync. Facial delivery cues use Milo's outgoing words, not emotion recognition of the user.
- Memory is bounded, belongs to the current tab session, and resets on New chat or reload. It can omit details. The local models have no internet or action tools.
- Whisper is English-only. Whisper and Kokoro run on CPU. Qwen replies and summaries optionally use GPU; accelerated Hybrid keeps simple Fast replies on CPU. Three.js rendering uses browser WebGL independently. The local API must stay running.
