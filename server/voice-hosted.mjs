// Hosted voice: a narrow same-origin proxy in front of Deepgram Flux text-to-speech (/v2/speak).
// The browser never sees the API key. Only the text Milo is about to say is sent
// upstream; microphone audio, transcripts and chat history never pass through here.
// Raw 24 kHz PCM is streamed back so playback can begin on the first bytes.
import http from 'node:http';
import { pathToFileURL } from 'node:url';

/** Milo voice ids map to Deepgram Flux voices; the same ids select Kokoro voices on the device. */
export const HOSTED_VOICES = { am_michael: 'flux-bruce-en', af_heart: 'flux-sienna-en', bf_emma: 'flux-gemma-en' };
export const PCM_TYPE = 'audio/pcm;codec=s16le;rate=24000';
const problem = (status, message) => Object.assign(new Error(message), { status });

export function createHostedVoice({
  port = 8792, host = '127.0.0.1', apiKey = '', fetchImpl = globalThis.fetch, voices = HOSTED_VOICES,
  upstream = 'https://api.deepgram.com/v2/speak', cacheBytes = 32 * 1024 * 1024, upstreamTimeoutMs = 30_000,
  limit = { requests: 60, characters: 60_000, windowMs: 60_000 },
} = {}) {
  // Finished clips are kept in memory so presets and repeated sentences cost nothing upstream.
  const cache = new Map();
  let cachedBytes = 0;
  function remember(key, type, body) {
    if (body.length > cacheBytes / 4) return;
    while (cache.size && cachedBytes + body.length > cacheBytes) {
      const oldest = cache.keys().next().value;
      cachedBytes -= cache.get(oldest).body.length; cache.delete(oldest);
    }
    cache.set(key, { type, body }); cachedBytes += body.length;
  }
  // A public endpoint spends the account's quota, so each address gets a bounded share.
  const buckets = new Map();
  function admit(ip, characters) {
    const now = Date.now();
    let bucket = buckets.get(ip);
    if (!bucket || now - bucket.start >= limit.windowMs) { bucket = { start: now, requests: 0, characters: 0 }; buckets.set(ip, bucket); }
    bucket.requests++; bucket.characters += characters;
    if (bucket.requests > limit.requests || bucket.characters > limit.characters) throw problem(429, 'The hosted voice is busy for this connection. Try again in a minute, or use the on-device voice.');
    if (buckets.size > 10_000) for (const [key, value] of buckets) if (now - value.start >= limit.windowMs) buckets.delete(key);
  }
  const clientAddress = req => (req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress || 'unknown';
  function readJson(req, maxBytes = 8192) {
    return new Promise((resolve, reject) => {
      if (!req.headers['content-type']?.toLowerCase().startsWith('application/json')) return reject(problem(415, 'Send the request as application/json.'));
      const chunks = []; let size = 0;
      req.on('error', reject);
      req.on('data', chunk => { size += chunk.length; if (size > maxBytes) { reject(problem(413, 'The request is too large.')); req.destroy(); } else chunks.push(chunk); });
      req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(problem(400, 'The request body must be valid JSON.')); } });
    });
  }
  const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };

  async function speak(req, res, url) {
    if (!apiKey) throw problem(503, 'The hosted voice is not configured on this server.');
    // Browsers label cross-site requests; a site embedding Milo must not spend its quota.
    const site = req.headers['sec-fetch-site'];
    if (site && site !== 'same-origin' && site !== 'none') throw problem(403, 'The hosted voice only serves Milo itself.');
    const body = await readJson(req);
    const text = typeof body?.text === 'string' ? body.text.replace(/\s+/g, ' ').trim() : '';
    if (!text || text.length > 600) throw problem(400, 'Send between 1 and 600 characters to speak.');
    const model = voices[body.voice ?? 'af_heart'];
    if (!model) throw problem(400, 'Choose a supported voice.');
    const mp3 = url.searchParams.get('format') === 'mp3';
    admit(clientAddress(req), text.length);
    const key = `${mp3 ? 'mp3' : 'pcm'}|${model}|${text}`;
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key); cache.set(key, hit);
      res.writeHead(200, { 'Content-Type': hit.type, 'Content-Length': hit.body.length, 'Cache-Control': 'no-store', 'X-Milo-Voice': 'cached' });
      return res.end(hit.body);
    }
    const query = mp3 ? 'encoding=mp3' : 'encoding=linear16&sample_rate=24000&container=none';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), upstreamTimeoutMs);
    req.on('close', () => { if (!res.writableEnded) controller.abort(); });
    let response;
    try {
      response = await fetchImpl(`${upstream}?model=${encodeURIComponent(model)}&${query}`, {
        method: 'POST', headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }), signal: controller.signal,
      });
    } catch { clearTimeout(timer); throw problem(502, 'The hosted voice did not respond. Milo can use the on-device voice instead.'); }
    if (!response.ok) {
      clearTimeout(timer);
      await response.body?.cancel().catch(() => {}); // Never read or log upstream error bodies.
      throw problem(502, response.status === 401 || response.status === 403 ? 'The hosted voice is not authorised on this server.' : 'The hosted voice could not speak that sentence.');
    }
    const type = mp3 ? 'audio/mpeg' : PCM_TYPE;
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Milo-Voice': 'deepgram' });
    const chunks = [];
    try {
      for await (const chunk of response.body) { chunks.push(chunk); if (!res.write(chunk)) await new Promise(resolve => res.once('drain', resolve)); }
    } catch { res.destroy(); return; } finally { clearTimeout(timer); }
    res.end();
    if (chunks.length) remember(key, type, Buffer.concat(chunks));
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      if (req.method === 'GET' && url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok\n'); }
      if (req.method === 'GET' && url.pathname === '/api/voice/health') return json(res, 200, { status: apiKey ? 'ready' : 'unconfigured', provider: 'deepgram', voices: Object.keys(voices) });
      if (req.method === 'POST' && url.pathname === '/api/voice/speak') return await speak(req, res, url);
      throw problem(404, 'Not found.');
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 500;
      if (res.headersSent) return res.destroy();
      json(res, status, { message: status === 500 ? 'The hosted voice failed. Milo can use the on-device voice instead.' : error.message });
    }
  });
  server.keepAliveTimeout = 65_000;
  return {
    server,
    listen: () => new Promise((resolve, reject) => server.once('error', reject).listen(port, host, () => resolve(server.address()))),
    close: () => new Promise(resolve => server.close(() => resolve())),
    cacheSize: () => cache.size,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const apiKey = process.env.DEEPGRAM_API_KEY ?? '';
  const voice = createHostedVoice({ port: Number(process.env.MILO_VOICE_PORT ?? 8792), host: process.env.MILO_VOICE_HOST ?? '127.0.0.1', apiKey });
  const address = await voice.listen();
  console.log(`[voice] Hosted voice proxy on http://${address.address}:${address.port} (${apiKey ? 'Deepgram configured' : 'no DEEPGRAM_API_KEY: reporting unconfigured'})`);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void voice.close().then(() => process.exit(0)); });
}
