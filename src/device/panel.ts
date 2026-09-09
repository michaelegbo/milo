import { deleteDeviceModels, deviceHealth, initializeDevice, unloadDevice } from './transport';
import { storedModels } from './model-storage';
import { usesCodex } from '../reply-provider';

/** Consent and recovery live beside the studio, before any model is requested. */
export function createDevicePanel(container: HTMLElement, onStop: () => void) {
  container.innerHTML = `<div class="device-setup-copy"><span class="eyebrow">YOUR DEVICE. YOUR CONVERSATION.</span><h2>Bring Milo to life.</h2><p id="device-setup-description">Download the voice once, then let Milo do the talking.</p><p class="device-privacy">Your words, voice recordings, and replies stay in this browser. No server inference.</p></div><div class="device-setup-action"><button id="device-start" class="primary-button">Download &amp; start voice <span aria-hidden="true">↘</span></button><button id="device-unload" class="text-button" hidden>Free up memory</button><span id="device-download-size">About 92 MB on first use</span></div><div class="device-progress-area"><p id="device-status" role="status">Ready for your permission to download.</p><progress id="device-progress" max="100" value="0" aria-label="Model preparation progress" hidden></progress><details class="device-requirements"><summary>Downloads &amp; device requirements</summary><p id="device-requirements-copy">Milo’s voice and listening use your CPU; compatible browsers can also accelerate replies with the GPU. A current desktop browser is recommended; phones and tablets may run out of memory. Voice is about 92 MB, listening about 80 MB, and Fast replies about 1.1 GB. Better answers add about 2.5 GB. Hybrid can download both reply models, up to 3.6 GB, and keeps one loaded at a time.</p><p>Model files download after you start. Your words and recordings are never included in download requests. Cached files may be removed by your browser. Closing the tab releases the models; Free up memory stops them sooner and keeps your chat here.</p><p id="device-capability">Checking browser capabilities…</p></details></div>`;
  const el = <T extends HTMLElement = HTMLElement>(id: string) => container.querySelector<T>(`#${id}`)!;
  el('device-unload').insertAdjacentHTML('afterend', '<button id="device-delete" class="text-button">Delete downloaded models</button>');
  container.insertAdjacentHTML('beforeend', `<dialog id="device-delete-dialog" aria-labelledby="device-delete-title" aria-describedby="device-delete-description"><span class="eyebrow">BROWSER STORAGE</span><h2 id="device-delete-title">Delete downloaded models?</h2><p id="device-delete-description">This stops Milo and removes saved voice, listening and reply models from this browser. Your chat and preferences stay here. You’ll need to download models again to use Milo.</p><p>Close other Milo tabs first. This affects this browser’s storage for Milo only.</p><p id="device-delete-inventory" role="status">Checking saved files…</p><p id="device-delete-error" role="alert" hidden></p><div class="device-delete-actions"><button id="device-delete-cancel" class="text-button" autofocus>Keep downloads</button><button id="device-delete-confirm" class="primary-button">Delete models</button></div></dialog>`);
  const dialog = el<HTMLDialogElement>('device-delete-dialog');
  let deleting = false;
  let conversation = false, preparing: AbortController | undefined, error = '', notice = '', disposed = false;
  let quota = '';
  const supported = globalThis.isSecureContext && globalThis.crossOriginIsolated && typeof WebAssembly !== 'undefined' && typeof Worker !== 'undefined';
  const capability = !supported ? 'This browser cannot start local AI here. Open Milo in a current desktop browser over HTTPS with cross-origin isolation enabled. There is no server fallback.' : 'Browser features available. Model loading will check whether this device has enough memory.';
  void navigator.storage?.estimate().then(value => {
    if (disposed || !value.quota) return;
    quota = ` Browser storage currently allows about ${Math.max(0, (value.quota - (value.usage ?? 0)) / 1e9).toFixed(1)} GB more; this is not a RAM estimate.`;
    render();
  }).catch(() => {});

  function render() {
    const health = deviceHealth();
    const profile = health.chat.profile;
    const engines = conversation ? usesCodex() ? [['Voice', health.tts], ['Listening', health.stt]] as const : [['Voice', health.tts], ['Listening', health.stt], ['Replies', health.chat]] as const : [['Voice', health.tts]] as const;
    const ready = engines.every(([, value]) => value.status === 'ready');
    const active = engines.some(([, value]) => value.status !== 'unloaded');
    const failed = engines.find(([, value]) => value.status === 'error');
    const loading = engines.find(([, value]) => value.status === 'loading');
    el('device-setup-description').textContent = conversation ? profile === 'hybrid' ? 'Simple turns stay quick. Deeper questions load the stronger model on this device.' : profile === 'quality' ? 'Make room for Milo’s larger reply model. This can be demanding on smaller devices.' : 'Download Milo’s voice, ears, and quick replies to chat right here.' : 'Download the voice once, then let Milo do the talking.';
    el('device-download-size').textContent = conversation ? profile === 'fast' ? 'About 1.3 GB total on first use' : profile === 'hybrid' ? 'About 1.3 GB to start · up to 3.8 GB with deeper replies' : 'About 2.7 GB total on first use' : 'About 92 MB on first use';
    if (conversation && usesCodex()) {
      el('device-setup-description').textContent = 'Prepare Milo’s voice and listening here. Your ChatGPT account provides the replies.';
      el('device-download-size').textContent = 'About 172 MB total · no local reply model needed';
    }
    container.querySelector('.device-privacy')!.textContent = usesCodex() ? 'Voice recordings stay on your device. Messages and conversation context go to OpenAI through Milo for ChatGPT replies.' : 'Your words, voice recordings, and replies stay in this browser. No server inference.';
    const start = el<HTMLButtonElement>('device-start');
    start.textContent = preparing || loading ? 'Preparing on your device…' : ready ? 'Ready on this device ✓' : error || failed ? 'Try loading again ↘' : conversation ? 'Download & start conversation ↘' : 'Download & start voice ↘';
    start.disabled = deleting || !supported || !!preparing || !!loading || ready;
    el<HTMLButtonElement>('device-delete').disabled = deleting;
    const unload = el<HTMLButtonElement>('device-unload');
    unload.hidden = !preparing && !active;
    unload.textContent = preparing ? 'Cancel download' : 'Free up memory';
    unload.disabled = deleting;
    const detail = error || (failed?.[1].message) || (!supported ? capability : preparing || loading ? engines.map(([name, value]) => `${name}: ${value.status === 'ready' ? 'ready' : value.status === 'loading' ? Number.isFinite(value.progress) ? `${Math.round(value.progress!)}%` : 'preparing' : 'waiting'}`).join(' · ') : ready ? 'Ready. Choose a sentence or start a conversation below.' : notice || 'Ready for your permission to download.');
    el('device-status').textContent = detail;
    container.dataset.state = error || failed || !supported ? 'error' : preparing || loading ? 'loading' : ready ? 'ready' : 'unloaded';
    const progress = el<HTMLProgressElement>('device-progress');
    progress.hidden = !preparing && !loading;
    if (loading && Number.isFinite(loading[1].progress)) progress.value = loading[1].progress!;
    else progress.removeAttribute('value');
    el('device-capability').textContent = capability + quota;
  }

  el('device-start').addEventListener('click', () => {
    if (preparing || deleting) return;
    error = ''; notice = '';
    const controller = new AbortController(); preparing = controller; render();
    void initializeDevice(conversation, controller.signal).catch(reason => {
      if (controller.signal.aborted) return;
      error = reason instanceof Error ? reason.message : 'Milo could not load on this device. Free some memory and try Fast mode.';
    }).finally(() => {
      if (preparing === controller) preparing = undefined;
      if (!disposed) { render(); window.dispatchEvent(new Event('milo-device-change')); }
    });
  });
  el('device-unload').addEventListener('click', () => {
    preparing?.abort(new DOMException('Stopped by you', 'AbortError')); preparing = undefined;
    onStop(); error = ''; notice = 'Models stopped. Your chat is still here. Start again to use cached downloads where available.';
    void unloadDevice().then(() => { if (!disposed) render(); });
  });
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
      if (!disposed) { render(); if (dialog.open) cancel.focus(); else el('device-delete').focus(); }
    });
  });
  const timer = setInterval(render, 700);
  const onProvider = () => { preparing?.abort(); preparing = undefined; error = ''; notice = ''; render(); };
  window.addEventListener('milo-provider-change', onProvider);
  window.addEventListener('milo-device-change', render);
  render();
  return {
    setConversation(value: boolean) { conversation = value; error = ''; render(); },
    dispose() { disposed = true; preparing?.abort(); clearInterval(timer); window.removeEventListener('milo-device-change', render); window.removeEventListener('milo-provider-change', onProvider); void unloadDevice(); },
  };
}
