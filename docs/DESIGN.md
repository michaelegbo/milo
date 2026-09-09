# Milo studio design

New project: a small creative tool for choosing text and hearing a 3D character speak. Core objects are a character, a script, a voice, and the generated audio clip.

The entry flow is preset selection → speak → visible generation status → synchronized avatar/audio playback → replay, change text, or save. Custom writing is a secondary tab. The first decision is what to say. Success means audible speech with visible mouth motion and working playback controls. Errors explain how to recover; cancellation keeps late responses from starting unwanted audio.

Custom CSS and native controls keep the UI small. Vite and TypeScript support the interactive Three.js surface; a local Node server accommodates CPU inference, which exceeds a lightweight static website's runtime requirements. Visual references are the restrained controls of Linear and the friendly object presentation of Teenage Engineering, with a warm ceramic character as the focal point.

Use warm off-white surfaces, sage stage colors, dark olive actions, and restrained terracotta accents. The character preview and script form have equal task relevance. On mobile, the complete avatar appears before the script, with reachable controls and no horizontal overflow. Native input/select/range/dialog behavior supplies keyboard and focus semantics. Honor reduced motion by disabling idle animation; keep audio-driven mouth movement functional.

Implementation details belong in About or the README. The main screen uses ordinary words: sentence, voice, pace, speak, pause, stop. Show CPU readiness as secondary status because local open-source speech is a user requirement. Avoid a decorative dashboard, fake activity charts, or simulated audio states.

Verify real speech, amplitude response, silence, cancellation, generation errors, recovery, persistence, mobile layout, keyboard controls, and rendered character framing. Model-cache and offline checks verify the local inference promise separately from UI appearance.

## Material finishing

Milo's manufactured-object finish uses satin ivory ceramic enamel, textured terracotta powder coat, molded charcoal rubber, brushed titanium trim, and a polished smoked face lens. Material color, roughness, and microscopic surface normals have separate roles; avoid uniformly glossy plastic or visible dirt. Check surface grain at the actual preview size as well as zoomed in, because a subpixel pattern disappears when filtered.

A locally generated studio environment supplies reflections, with warm key light, cooler fill, an edge light, and a fog-blended matte floor. Small panel gaskets, hex sockets, vents, a printed chest label, speaker perforations, sole treads, and ribbed joints establish physical scale. All finish maps are generated once and remain available offline. Dispose both shared texture maps and the generated environment with the avatar.

## Talking movement

The articulated rig separates shoulders, elbows, and wrists, with an upper-body pivot at the hips so feet remain planted. Audio-gated gesture envelopes alternate explanatory hands and occasional two-hand emphasis. Gentle body turns and head nods follow the same gesture timing. Smooth approach and release avoid bouncing on every syllable or snapping on pause; extended silence settles toward neutral.

Keep **Idle** and **Gestures** separate: turning off idle breathing must not silently suppress speaking gestures. Persist both preferences and default both off for reduced motion. Keep hands below the face and within the preview at the initial camera distance; check both default and mobile views during actual speech. Gesture timing follows the sound; simple delivery cues in Milo's own utterance can modestly vary gesture strength.

## Visual presence and expression

The avatar receives real conversation state and normalized microphone energy separately from playback audio. Listening gives Milo a small forward lean, tilted head, slightly wider eyes, and a restrained acknowledgment nod on voice onset. Thinking and transcription use an upward side glance and asymmetric brows, returning to the viewer when playback begins. Waiting for microphone permission must not look like actual listening. Microphone monitoring during Milo's reply remains a speaking presence until the user actually interrupts.

Keep the cream/orange manufactured robot and the original stage. Reuse the eyes, brows, cheek materials, and shared chest/antenna light. The closed LED smile uses prebuilt position/normal morph targets so it keeps its thickness at mobile scale. Build face geometry only during initialization and dispose it with the rig. OrbitControls retains camera ownership; state transitions must not move the camera.

The pure expression controller produces bounded, smoothed face values and additive head/body offsets. Playback energy controls mouth opening and frequency-band proportions blend round, wide, and narrow shapes. Silence settles the mouth closed, and microphone energy never opens it. This is a visual approximation rather than phoneme timing. Transparent wording/punctuation rules on Milo's own outgoing utterance choose neutral, warm, curious, encouraging, or thoughtful delivery; do not infer the user's emotions or present these rules as emotion recognition.

Idle off stops ambient breathing, blinking, and light variation. Gestures off stops talking gestures and listener head/body motion; static facial state remains informative. Reduced motion suppresses body motion, animated gaze, blinking, and light pulses while preserving static expressions and audio mouth movement. End, errors, cancellation, and mode switches settle attention back to the corresponding real state. Verify state distinctions, silence, live input versus playback separation, reduced motion, bounded joint ranges, and actual rendered desktop/mobile faces.

## Conversation

Conversation is a peer mode beside Sentence studio and shares the character stage, voice, waveform and speech gestures. Explicit Start conversation obtains microphone permission. Silence closes each captured turn, then Whisper transcribes and Qwen streams a reply. Display incremental words but send completed sentences to Kokoro so longer replies can begin speaking early. Release microphone tracks before transcription; enable playback-time monitoring only for explicitly started voice conversations with Interrupt Milo by speaking selected. A sustained onset stops Milo while preserving the same capture and opening words. Keep the explicit Interrupt & talk button. End, mode changes, page exit and New chat cancel pending work and prevent late audio or recording.

Keep typed input available when microphone access is denied. Render transcripts as plain text in a scrollable accessible log. Show actual loading, listening, transcription, thinking and speaking states. Store history only in current tab memory; send recent exchanges plus explicit details and a rolling summary of older turns. What Milo remembers reveals that memory, with New chat clearing it. Later explicit corrections replace earlier values. The Fast / Better answers choice explains download size and CPU speed tradeoffs, disables during an active turn, and preserves the conversation when switched. Reload returns to Sentence studio without opening a microphone.

Microphone controls sit directly above the conversation action: a native device selector, refresh, a labelled mute toggle, and a live input meter. Distinguish idle, waiting for permission, active listening, paused capture, and muted states. Mute discards the active recording and prevents automatic next-turn capture while allowing an existing reply to finish. Unmute and device refresh never open the microphone on their own. Changes to the active input end the recording, and a disconnected selection falls back to System default for a later explicit start.

## Optional GPU control

Place one labelled GPU acceleration switch below Milo's mind. Show the detected adapter, actual readiness, and the concise scope note: replies only; speech stays on CPU. Preserve the stage and existing controls. Use an accessible switch with a status description, visible keyboard focus and a reachable touch target on mobile.

The switch remains actionable during loading and replies. Turning it off immediately ends this tab's current turn, stops audio and recording, and shows the transition while the server releases GPU resources and prepares CPU. Preserve transcript and memory. Disable new turns during switching, but allow a later switch request to supersede an earlier one. Other tabs react to the shared device revision and cancel their stale work too.

Accelerated Hybrid keeps Fast on CPU and Quality on GPU when memory permits. Show GPU ready with quick replies using CPU between simple turns, and GPU active when Quality is selected. A normal Hybrid route change must not flip the switch or cancel the turn. Explain reduced-memory loading and unavailable hardware with useful status text; CPU remains the default and fallback.

## Hybrid conversation

Hybrid is the third choice in the existing Milo’s mind selector. The user's task stays a single conversation; model selection is automatic for each turn. Keep the selected mode as Hybrid while the answering model changes, including across shared-engine health polls. Show a small Quick reply / Thinking deeper status and a short reason beside the mode, with the latter settling to Considered reply during playback. The status must reflect an actual routing event, not elapsed-time theatre or a fabricated model-confidence score.

Preserve the existing transcript, memory, voice, microphone controls and interruption behavior across routes. End and new turns invalidate pending routing events as well as speech. Simple turns should remain quick; complex questions and contextual follow-ups should reach the stronger model before an answer is spoken. Explain loading and memory-saving fallback in the existing secondary hint. Keep routing reasons readable on mobile without enlarging or replacing the main conversation actions. Verify readiness, both routes, context continuity, delayed cancellation, shared mode state, actual CPU model use and warm switching.
