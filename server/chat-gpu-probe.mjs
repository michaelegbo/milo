// A separate process keeps native driver initialization out of Milo's server.
// Device visibility must be supplied before Windows starts the native runtime.
process.on('disconnect', () => process.exit(0));

let handled = false;
process.on('message', async (request) => {
  if (handled) return;
  handled = true;
  let llama;
  let result;
  try {
    const library = await import('node-llama-cpp');
    if (request.type === 'supported') {
      result = { supported: (await library.getLlamaGpuTypes('supported')).filter(Boolean) };
    } else if (request.type === 'inspect' && ['cuda', 'vulkan', 'metal'].includes(request.backend)) {
      llama = await library.getLlama({ gpu: request.backend, build: 'never', skipDownload: true, logLevel: 'error', progressLogs: false });
      if (llama.gpu !== request.backend || !llama.supportsGpuOffloading) throw new Error('GPU backend unavailable.');
      result = { backend: llama.gpu, devices: await llama.getGpuDeviceNames(), vram: await llama.getVramState() };
    } else {
      throw new Error('Invalid GPU probe.');
    }
  } catch {
    result = { error: 'This bundled GPU runtime could not initialize with the current driver.' };
  } finally {
    try { await llama?.dispose(); } catch { result = { error: 'The GPU runtime did not close cleanly.' }; }
  }
  if (process.connected) process.send(result, () => process.disconnect());
});
