import { deleteDeviceModels, deviceHealth, deviceVoiceReady, initializeDevice, unloadDevice } from './transport';
import { storedModels } from './model-storage';
import { inspectSavedDownloads, type SavedDownloads } from './saved-downloads';
import { usesCodex } from '../reply-provider';
import { usesHostedVoice } from '../voice-provider';

/** Consent and recovery live beside the studio, before any model is requested. */
export function createDevicePanel(container: HTMLElement, onStop: () => void) {
  container.innerHTML = `<div class="device-setup-copy"><span class="eyebrow">YOUR DEVICE. YOUR CONVERSATION.</span><h2>Bring Milo to life.</h2><p id="device-setup-description">Download the voice once, then let Milo do the talking.</p><p class="device-privacy">Your words, voice recordings, and replies stay in this browser. No server inference.</p></div><div class="device-setup-action"><button id="device-start" class="primary-button">Download &amp; start voice <span aria-hidden="true">↘</span></button><button id="device-unload" class="text-button" hidden>Free up memory</button><span id="device-download-size">About 92 MB on first use</span></div><div class="device-progress-area"><p id="device-status" role="status">Ready for your permission to download.</p><progress id="device-progress" max="100" value="0" aria-label="Model preparation progress" hidden></progress><details class="device-requirements"><summary>Downloads &amp; device requirements</summary><p id="device-requirements-copy">Milo’s voice and listening use your CPU; compatible browsers can also accelerate replies with the GPU. A current desktop browser is recommended; phones and tablets may run out of memory. Voice is about 92 MB, listening about 80 MB, and Fast replies about 1.1 GB. Better answers add about 2.5 GB. Hybrid can download both reply models, up to 3.6 GB, and keeps one loaded at a time.</p><p>Model files download after you start. Your words and recordings are never included in download requests. Cached files may be removed by your browser. Closing the tab releases the models; Free up memory stops them sooner and keeps your chat here.</p><p id="device-capability">Checking browser capabilities…</p></details></div>`;
  const el = <T extends HTMLElement = HTMLElement>(id: string) => container.querySelector<T>(`#${id}`)!;
  el('device-unload').insertAdjacentHTML('afterend', '<button id="device-delete" class="text-button">Delete downloaded models</button>');
  container.insertAdjacentHTML('beforeend', `<dialog id="device-delete-dialog" aria-labelledby="device-delete-title" aria-describedby="device-delete-description"><span class="eyebrow">BROWSER STORAGE</span><h2 id="device-delete-title">Delete downloaded models?</h2><p id="device-delete-description">This stops Milo and removes saved voice, listening and reply models from this browser. Your chat and preferences stay here. You’ll need to download models again to use Milo.</p><p>Close other Milo tabs first. This affects this browser’s storage for Milo only.</p><p id="device-delete-inventory" role="status">Checking saved files…</p><p id="device-delete-error" role="alert" hidden></p><div class="device-delete-actions"><button id="device-delete-cancel" class="text-button" autofocus>Keep downloads</button><button id="device-delete-confirm" class="primary-button">Delete models</button></div></dialog>`);
  el('device-delete').insertAdjacentHTML('afterend', '<button id="device-check-saved" class="text-button">Check saved downloads</button>');
  el('device-status').insertAdjacentHTML('afterend', '<p id="device-saved-status" role="status">Checking saved downloads…</p>');
  const dialog = el<HTMLDialogElement>('device-delete-dialog');
  let deleting = false;
  let conversation = false, preparing: AbortController | undefined, error = '', notice = '', disposed = false;
  let saved: SavedDownloads | undefined, storageError = '', checking = false, protection = '';
  let scanPending: Promise<void> | undefined;
  function checkSaved() {
    return scanPending ??= (async () => {
      checking = true; render();
      try { saved = await inspectSavedDownloads(); storageError = ''; }
      catch { saved = undefined; storageError = 'Saved downloads could not be checked. Browser storage may be blocked. Try checking again.'; }
      finally { checking = false; scanPending = undefined; if (!disposed) render(); }
    })();
  }
  let quota = '';
  const supported = globalThis.isSecureContext && globalThis.crossOriginIsolated && typeof WebAssembly !== 'undefined' && typeof Worker !== 'undefined';
  const capability = !supported ? 'This browser cannot start local AI here. Open Milo in a current desktop browser over HTTPS with cross-origin isolation enabled. There is no server fallback.' : 'Browser features available. Model loading will check whether this device has enough memory.';
  void navigator.storage?.estimate().then(value => {
    if (disposed || !value.quota) return;
    quota = ` Browser storage currently allows about ${Math.max(0, (value.quota - (value.usage ?? 0)) / 1e9).toFixed(1)} GB more; this is not a RAM estimate.`;
    render();
  }).catch(() => {});

  /** Which of the files this mode needs are already in browser storage. */
  function describeSaved(): 'all' | 'some' | 'none' | 'unknown' {
    if (!saved) return 'unknown';
    const profile = deviceHealth().chat.profile;
    const needed = (conversation ? usesCodex() ? ['tts', 'stt'] : ['tts', 'stt', profile === 'quality' ? 'quality' : 'fast'] : ['tts']).filter(key => key !== 'tts' || !usesHostedVoice()) as ('tts' | 'stt' | 'fast' | 'quality')[];
    if (!needed.length) return 'none';
    return needed.every(key => saved![key].ready) ? 'all' : needed.some(key => saved![key].found > 0) ? 'some' : 'none';
  }

  function render() {
    const health = deviceHealth();
    const profile = health.chat.profile;
    const hosted = usesHostedVoice();
    const engines = (conversation ? usesCodex() ? [['Voice', health.tts], ['Listening', health.stt]] : [['Voice', health.tts], ['Listening', health.stt], ['Replies', health.chat]] : [['Voice', health.tts]]).filter(([name]) => name !== 'Voice' || !hosted) as [string, { status: string; progress?: number | null; message?: string }][];
    const ready = engines.every(([, value]) => value.status === 'ready');
    const active = engines.some(([, value]) => value.status !== 'unloaded');
    const failed = engines.find(([, value]) => value.status === 'error');
    const loading = engines.find(([, value]) => value.status === 'loading');
    el('device-setup-description').textContent = conversation ? profile === 'hybrid' ? 'Simple turns stay quick. Deeper questions load the stronger model on this device.' : profile === 'quality' ? 'Make room for Milo’s larger reply model. This can be demanding on smaller devices.' : 'Download Milo’s voice, ears, and quick replies to chat right here.' : 'Download the voice once, then let Milo do the talking.';
    el('device-download-size').textContent = conversation ? profile === 'fast' ? hosted ? 'About 1.2 GB total on first use' : 'About 1.3 GB total on first use' : profile === 'hybrid' ? hosted ? 'About 1.2 GB to start · up to 3.7 GB with deeper replies' : 'About 1.3 GB to start · up to 3.8 GB with deeper replies' : hosted ? 'About 2.6 GB total on first use' : 'About 2.7 GB total on first use' : hosted ? 'No download needed · voice streams from Deepgram' : 'About 92 MB on first use';
    if (conversation && usesCodex()) {
      el('device-setup-description').textContent = 'Prepare Milo’s voice and listening here. Your ChatGPT account provides the replies.';
      el('device-download-size').textContent = hosted ? 'About 80 MB total · listening only' : 'About 172 MB total · no local reply model needed';
    }
    container.querySelector('.device-privacy')!.textContent = usesCodex()
      ? hosted ? 'Voice recordings stay on your device. Messages go to OpenAI for replies, and the text Milo says goes to Deepgram for its voice.' : 'Voice recordings stay on your device. Messages and conversation context go to OpenAI through Milo for ChatGPT replies.'
      : hosted ? 'Your voice recordings and replies stay in this browser. Only the text Milo says is sent to Deepgram to make its voice.' : 'Your words, voice recordings, and replies stay in this browser. No server inference.';
    const savedState = describeSaved();
    const allSaved = savedState === 'all', someSaved = savedState === 'some';
    if (allSaved) {
      el('device-setup-description').textContent = 'Your downloads are saved. Start Milo to load them back into memory.';
      el('device-download-size').textContent = conversation && !usesCodex() && profile === 'hybrid' && !saved!.quality.ready ? 'Saved models ready to start · deeper replies may need a download' : 'Saved models · no model download needed';
    } else if (someSaved) el('device-download-size').textContent = 'Saved files will be reused · only missing files download';
    const labels = { tts: 'Voice', stt: 'Listening', fast: 'Fast replies', quality: 'Better replies' };
    const savedBytes = saved ? Object.values(saved).reduce((sum, value) => sum + value.bytes, 0) : 0;
    const sizeLabel = savedBytes >= 1e9 ? `${(savedBytes / 1e9).toFixed(2)} GB` : `${(savedBytes / 1e6).toFixed(1)} MB`;
    el('device-saved-status').textContent = storageError || (saved ? Object.entries(saved).map(([key, value]) => labels[key as keyof typeof labels] + ': ' + (value.ready ? 'saved' : value.found ? 'partly saved' : 'not saved')).join(' · ') + `. ${sizeLabel} saved here. ` + (ready && !allSaved && engines.length ? 'Some files could not be saved for next time. ' : '') + protection : 'Checking saved downloads…');
    el<HTMLButtonElement>('device-check-saved').disabled = checking || deleting || !!preparing;
    const start = el<HTMLButtonElement>('device-start');
    start.textContent = preparing || loading ? 'Preparing on your device…' : ready ? 'Ready on this device ✓' : error || failed ? 'Try loading again ↘' : checking && !saved ? 'Checking saved downloads…' : allSaved ? conversation ? 'Start saved conversation ↘' : 'Start saved voice ↘' : someSaved ? 'Download missing files & start ↘' : conversation ? 'Download & start conversation ↘' : 'Download & start voice ↘';
    start.disabled = (checking && !saved) || deleting || !supported || !!preparing || !!loading || ready;
    // The studio already speaks through Deepgram; Kokoro stays available as an optional fallback for offline use.
    const optionalVoice = !conversation && hosted && supported && !preparing && !loading && !failed && !error;
    if (optionalVoice) {
      const loaded = deviceVoiceReady();
      el('device-setup-description').textContent = 'Milo’s voice streams from Deepgram, so the studio needs no download. Conversation prepares listening and replies on this device.';
      el('device-download-size').textContent = loaded ? 'On-device voice loaded as a fallback · no download needed' : `No download needed · optional on-device voice${saved?.tts.ready ? ' is saved here' : ' is about 92 MB'}`;
      start.textContent = loaded ? 'On-device voice ready ✓' : saved?.tts.ready ? 'Load on-device voice ↘' : 'Download on-device voice ↘';
      start.disabled = loaded || deleting || (checking && !saved);
    }
    el<HTMLButtonElement>('device-delete').disabled = deleting;
    const unload = el<HTMLButtonElement>('device-unload');
    unload.hidden = !preparing && !active;
    unload.textContent = preparing ? 'Cancel download' : 'Free up memory';
    unload.disabled = deleting;
    const detail = error || (failed?.[1].message) || (!supported ? capability : preparing || loading ? engines.map(([name, value]) => `${name}: ${value.status === 'ready' ? 'ready' : value.status === 'loading' ? Number.isFinite(value.progress) ? `${Math.round(value.progress!)}%` : 'preparing' : 'waiting'}`).join(' · ') : ready ? 'Ready. Choose a sentence or start a conversation below.' : notice || (allSaved ? 'Saved downloads found in this browser. Reloading releases memory, not these files.' : someSaved ? 'Some files are already here. Start to reuse them and finish the missing downloads.' : 'Ready for your permission to download.'));
    el('device-status').textContent = detail;
    container.dataset.state = error || failed || !supported ? 'error' : preparing || loading ? 'loading' : ready ? 'ready' : 'unloaded';
    const progress = el<HTMLProgressElement>('device-progress');
    progress.hidden = !preparing && !loading;
    if (loading && Number.isFinite(loading[1].progress)) progress.value = loading[1].progress as number;
    else progress.removeAttribute('value');
    el('device-capability').textContent = capability + quota;
  }

  el('device-start').addEventListener('click', () => {
    if (preparing || deleting) return;
    error = ''; notice = '';
    const controller = new AbortController(); preparing = controller; render();
    if (navigator.storage?.persist) void navigator.storage.persist().then(granted => {
      protection = granted ? 'Browser storage protection is enabled.' : 'Your browser may clear saved files when storage is low.';
      if (!disposed) render();
    }).catch(() => { protection = 'Browser storage protection is unavailable.'; });
    void initializeDevice(conversation, controller.signal).catch(reason => {
      if (controller.signal.aborted) return;
      error = reason instanceof Error ? reason.message : 'Milo could not load on this device. Free some memory and try Fast mode.';
    }).finally(() => {
      if (preparing === controller) preparing = undefined;
      if (!disposed) { void checkSaved(); render(); window.dispatchEvent(new Event('milo-device-change')); }
    });
  });
  function stopModels() {
    preparing?.abort(new DOMException('Stopped by you', 'AbortError')); preparing = undefined;
    onStop(); error = ''; notice = 'Models stopped. Your chat is still here. Start again to use cached downloads where available.';
    void unloadDevice().then(() => { if (!disposed) render(); });
  }
  el('device-unload').addEventListener('click', stopModels);
  el('device-delete').addEventListener('click', () => {
    if (deleting) return;
    el('device-delete-error').hidden = true;
    el('device-delete-inventory').textContent = 'Checking saved files…';
    dialog.showModal();
    void storedModels().then(value => {
      if (!disposed && dialog.open) el('device-delete-inventory').textContent = value.files ? `${value.files} saved model files found.` : 'No saved model files found. Any active download will also be stopped.';
    }).catch(() => { if (!disposed && dialog.open) el('device-delete-inventory').textContent = 'Storage size is unavailable. You can still try deleting the models.'; });
  });
  el('device-delete-cancel').addEventListener('click', () => { if (!deleting) dialog.close(); });
  dialog.addEventListener('cancel', event => { if (deleting) event.preventDefault(); });
  dialog.addEventListener('close', () => el('device-delete').focus());
  el('device-delete-confirm').addEventListener('click', () => {
    if (deleting) return;
    deleting = true;
    preparing?.abort(new DOMException('Deleting downloaded models', 'AbortError')); preparing = undefined;
    onStop(); error = ''; notice = 'Deleting saved model files…';
    el('device-delete-error').hidden = true;
    const confirm = el<HTMLButtonElement>('device-delete-confirm');
    const cancel = el<HTMLButtonElement>('device-delete-cancel');
    confirm.disabled = true; cancel.disabled = true; confirm.textContent = 'Deleting…';
    dialog.setAttribute('aria-busy', 'true'); render();
    void deleteDeviceModels().then(count => {
      notice = count ? 'Downloaded models deleted. Your chat is still here. Start again to download the models you need.' : 'No downloaded models remain. Your chat is still here.';
      dialog.close();
    }).catch(reason => {
      notice = 'Models stopped. Download deletion did not finish.';
      el('device-delete-error').textContent = `${reason instanceof Error ? reason.message : 'Could not delete model files.'} Some files may already have been removed. Your chat is safe.`;
      el('device-delete-error').hidden = false;
    }).finally(() => {
      deleting = false; confirm.disabled = false; cancel.disabled = false; confirm.textContent = 'Delete models';
      dialog.removeAttribute('aria-busy');
      if (!disposed) { void checkSaved(); render(); if (dialog.open) cancel.focus(); else el('device-delete').focus(); }
    });
  });
  el('device-check-saved').addEventListener('click', () => { notice = ''; void checkSaved(); });
  const onFocus = () => { if (!preparing && !deleting) void checkSaved(); };
  window.addEventListener('focus', onFocus);
  const timer = setInterval(render, 700);
  const onProvider = () => { preparing?.abort(); preparing = undefined; error = ''; notice = ''; render(); };
  window.addEventListener('milo-provider-change', onProvider);
  window.addEventListener('milo-device-change', render);
  window.addEventListener('milo-voice-change', render);
  render(); void checkSaved();
  return {
    setConversation(value: boolean) { conversation = value; error = ''; render(); },
    /** The same consent action as the setup button, so other panels can offer it in place. */
    start() { const button = el<HTMLButtonElement>('device-start'); if (!button.disabled) button.click(); },
    describe() {
      return { supported, capability: supported ? '' : capability, saved: describeSaved(), busy: !!preparing || deleting || (checking && !saved), preparing: !!preparing, size: el('device-download-size').textContent || '' };
    },
    /** Stop a download or load in progress and release the engines, as the setup panel's own button does. */
    stop() { stopModels(); },
    dispose() { disposed = true; window.removeEventListener('focus', onFocus); preparing?.abort(); clearInterval(timer); window.removeEventListener('milo-device-change', render); window.removeEventListener('milo-voice-change', render); window.removeEventListener('milo-provider-change', onProvider); void unloadDevice(); },
  };
}
