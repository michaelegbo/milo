import { deviceHealth, initializeDevice, unloadDevice } from './transport';

/** Consent and recovery live beside the studio, before any model is requested. */
export function createDevicePanel(container: HTMLElement, onStop: () => void) {
  container.innerHTML = `<div class="device-setup-copy"><span class="eyebrow">YOUR DEVICE. YOUR CONVERSATION.</span><h2>Bring Milo to life.</h2><p id="device-setup-description">Download the voice once, then let Milo do the talking.</p><p class="device-privacy">Your words, voice recordings, and replies stay in this browser. No server inference.</p></div><div class="device-setup-action"><button id="device-start" class="primary-button">Download &amp; start voice <span aria-hidden="true">↘</span></button><button id="device-unload" class="text-button" hidden>Free up memory</button><span id="device-download-size">About 92 MB on first use</span></div><div class="device-progress-area"><p id="device-status" role="status">Ready for your permission to download.</p><progress id="device-progress" max="100" value="0" aria-label="Model preparation progress" hidden></progress><details class="device-requirements"><summary>Downloads &amp; device requirements</summary><p id="device-requirements-copy">Milo’s voice and listening use your CPU; compatible browsers can also accelerate replies with the GPU. A current desktop browser is recommended; phones and tablets may run out of memory. Voice is about 92 MB, listening about 80 MB, and Fast replies about 1.1 GB. Better answers add about 2.5 GB. Hybrid can download both reply models, up to 3.6 GB, and keeps one loaded at a time.</p><p>Model files download after you start. Your words and recordings are never included in download requests. Cached files may be removed by your browser. Closing the tab releases the models; Free up memory stops them sooner and keeps your chat here.</p><p id="device-capability">Checking browser capabilities…</p></details></div>`;
  const el = <T extends HTMLElement = HTMLElement>(id: string) => container.querySelector<T>(`#${id}`)!;
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
    const engines = conversation ? [['Voice', health.tts], ['Listening', health.stt], ['Replies', health.chat]] as const : [['Voice', health.tts]] as const;
    const ready = engines.every(([, value]) => value.status === 'ready');
    const active = engines.some(([, value]) => value.status !== 'unloaded');
    const failed = engines.find(([, value]) => value.status === 'error');
    const loading = engines.find(([, value]) => value.status === 'loading');
    el('device-setup-description').textContent = conversation ? profile === 'hybrid' ? 'Simple turns stay quick. Deeper questions load the stronger model on this device.' : profile === 'quality' ? 'Make room for Milo’s larger reply model. This can be demanding on smaller devices.' : 'Download Milo’s voice, ears, and quick replies to chat right here.' : 'Download the voice once, then let Milo do the talking.';
    el('device-download-size').textContent = conversation ? profile === 'fast' ? 'About 1.3 GB total on first use' : profile === 'hybrid' ? 'About 1.3 GB to start · up to 3.8 GB with deeper replies' : 'About 2.7 GB total on first use' : 'About 92 MB on first use';
    const start = el<HTMLButtonElement>('device-start');
    start.textContent = preparing || loading ? 'Preparing on your device…' : ready ? 'Ready on this device ✓' : error || failed ? 'Try loading again ↘' : conversation ? 'Download & start conversation ↘' : 'Download & start voice ↘';
    start.disabled = !supported || !!preparing || !!loading || ready;
    const unload = el<HTMLButtonElement>('device-unload');
    unload.hidden = !preparing && !active;
    unload.textContent = preparing ? 'Cancel download' : 'Free up memory';
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
    if (preparing) return;
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
  const timer = setInterval(render, 700);
  window.addEventListener('milo-device-change', render);
  render();
  return {
    setConversation(value: boolean) { conversation = value; error = ''; render(); },
    dispose() { disposed = true; preparing?.abort(); clearInterval(timer); window.removeEventListener('milo-device-change', render); void unloadDevice(); },
  };
}
