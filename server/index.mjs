import http from 'node:http';
import { createSpeechEngine, SpeechError } from './engine.mjs';
import { createSTTEngine } from './stt-engine.mjs';
import { getChatMode, ChatError } from './chat-engine.mjs';
import { createAcceleratedChatEngine } from './chat-acceleration.mjs';

const HOST = '127.0.0.1';
const PORT = Number(process.env.SPEECH_PORT ?? 8787);
const MAX_BODY_BYTES = 8192;
const engine = createSpeechEngine();
const recognizer = createSTTEngine();
const conversation = createAcceleratedChatEngine();

const conversationHealth = () => ({ stt: recognizer.health(), chat: conversation.health(), tts: engine.health() });

function json(response, status, value, extraHeaders = {}) {
  if (response.destroyed || response.headersSent) return;
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders });
  response.end(JSON.stringify(value));
}

function isLocalOrigin(value) {
  try {
    const origin = new URL(value);
    return origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  } catch { return false; }
}

async function readJson(request, maxBytes = MAX_BODY_BYTES) {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    throw new SpeechError(415, 'invalid_content_type', 'Send the request as application/json.');
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    let failed = false;
    const chunks = [];
    request.on('error', reject);
    request.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > maxBytes) {
        failed = true;
        chunks.length = 0;
        reject(new SpeechError(413, 'request_too_large', 'The request body is too large.'));
      } else {
        chunks.push(chunk);
      }
    });
    request.on('end', () => {
      if (failed) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new SpeechError(400, 'invalid_json', 'The request body must contain valid JSON.')); }
    });
  });
}

async function readAudio(request) {
  if (!['audio/wav', 'audio/x-wav'].includes(request.headers['content-type']?.split(';')[0].trim())) {
    throw new SpeechError(415, 'invalid_audio_type', 'Send a WAV microphone recording.');
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, failed = false;
    request.on('error', reject);
    request.on('data', chunk => {
      if (failed) return;
      size += chunk.length;
      if (size > 1_000_000) {
        failed = true; chunks.length = 0;
        reject(new SpeechError(413, 'audio_too_long', 'Keep each voice message under 30 seconds.'));
      } else chunks.push(chunk);
    });
    request.on('end', () => { if (!failed) resolve(Buffer.concat(chunks)); });
  });
}

const server = http.createServer(async (request, response) => {
  const operation = new AbortController();
  const abort = () => { if (!response.writableEnded) operation.abort(); };
  response.on('close', abort);
  response.setHeader('X-Content-Type-Options', 'nosniff');
  const origin = request.headers.origin;
  if (origin && !isLocalOrigin(origin)) {
    json(response, 403, { error: 'origin_rejected', message: 'Use the local Avatar Studio app to access speech.' });
    return;
  }
  if (origin) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
    response.setHeader('Access-Control-Expose-Headers', 'X-Audio-Duration, X-Generation-Ms, X-Audio-Cached');
  }
  if (request.method === 'OPTIONS') {
    response.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' });
    response.end();
    return;
  }
  try {
    const pathname = new URL(request.url, `http://${HOST}:${PORT}`).pathname;
    if (request.method === 'GET' && pathname === '/api/health') {
      json(response, 200, engine.health());
      return;
    }
    if (request.method === 'GET' && pathname === '/api/conversation/health') {
      json(response, 200, conversationHealth());
      return;
    }
    if (request.method === 'POST' && pathname === '/api/conversation/acceleration') {
      const body = await readJson(request);
      const pending = conversation.setAcceleration(body?.enabled);
      void pending.catch(error => console.error('[conversation] Acceleration switch:', error.message));
      json(response, 202, conversationHealth());
      return;
    }
    if (request.method === 'POST' && pathname === '/api/conversation/prepare') {
      const body = await readJson(request);
      const profile = getChatMode(body?.profile ?? 'fast');
      if (body?.provider === 'codex') {
        void recognizer.initialize().catch(error => console.error('[conversation] Recognizer initialization:', error.message));
        json(response, 202, conversationHealth());
        return;
      }
      const current = conversation.health();
      if (current.profile !== profile.id && (current.status === 'loading' || current.queueDepth > 0)) {
        throw new ChatError(409, 'profile_busy', 'Finish loading or stop the current turn before changing profiles.');
      }
      void recognizer.initialize().catch(error => console.error('[conversation] Recognizer initialization:', error.message));
      void conversation.initialize({ profile: profile.id }).catch(error => console.error('[conversation] Chat initialization:', error.message));
      json(response, 202, conversationHealth());
      return;
    }
    if (request.method === 'POST' && pathname === '/api/transcribe') {
      const result = await recognizer.transcribe(await readAudio(request), { signal: operation.signal });
      json(response, 200, result);
      return;
    }
    if (request.method === 'POST' && pathname === '/api/chat') {
      const body = await readJson(request, 64_000);
      const result = await conversation.reply(body?.messages, { signal: operation.signal, profile: body?.profile, memory: body?.memory });
      json(response, 200, result);
      return;
    }
    if (request.method === 'POST' && pathname === '/api/chat/summary') {
      const body = await readJson(request, 64_000);
      const result = await conversation.summarize(body?.messages, { signal: operation.signal, profile: body?.profile, memory: body?.memory });
      json(response, 200, result);
      return;
    }
    if (request.method === 'POST' && pathname === '/api/chat/stream') {
      const body = await readJson(request, 64_000);
      let streamReady = false;
      const bufferedEvents = [];
      function emit(event) {
        if (response.destroyed || response.writableEnded) return;
        if (!streamReady) bufferedEvents.push(event);
        else response.write(`${JSON.stringify(event)}\n`);
      }
      const pending = conversation.reply(body?.messages, {
        signal: operation.signal, profile: body?.profile, memory: body?.memory,
        onRouting({ profile, reason }) { emit({ type: 'routing', profile, reason }); },
        onTextChunk(text) { emit({ type: 'delta', text }); },
      });
      response.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      response.flushHeaders();
      streamReady = true;
      for (const event of bufferedEvents) emit(event);
      const result = await pending;
      if (!response.destroyed && !response.writableEnded) response.end(`${JSON.stringify({ type: 'done', ...result })}\n`);
      return;
    }
    if (request.method === 'POST' && pathname === '/api/speech') {
      const result = await engine.generate(await readJson(request));
      if (response.destroyed) return;
      response.writeHead(200, {
        'Content-Type': 'audio/wav',
        'Content-Length': result.wav.length,
        'Cache-Control': 'no-store',
        'X-Audio-Duration': result.duration.toFixed(3),
        'X-Generation-Ms': String(result.generationMs),
        'X-Audio-Cached': String(result.cached),
      });
      response.end(result.wav);
      return;
    }
    json(response, 404, { error: 'not_found', message: 'Use GET /api/health or POST /api/speech.' });
  } catch (error) {
    const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
    if (status === 500) console.error('[speech] Request failed:', error);
    const message = status !== 500 ? error.message : 'The local engine encountered an error. Please try again.';
    if (response.headersSent) {
      if (!response.destroyed && !response.writableEnded) response.end(`${JSON.stringify({ type: 'error', code: error.code ?? 'internal_error', message })}\n`);
    } else json(response, status, { error: error.code ?? 'internal_error', message }, status === 429 || status === 503 ? { 'Retry-After': '3' } : {});
  } finally {
    response.off('close', abort);
  }
});

server.requestTimeout = 180000;
server.headersTimeout = 10000;
server.on('error', (error) => {
  console.error(`[speech] Cannot listen on ${HOST}:${PORT}: ${error.message}`);
  process.exitCode = 1;
});
server.listen(PORT, HOST, () => {
  console.log(`[speech] Local CPU speech server: http://${HOST}:${PORT}`);
  void engine.initialize();
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void recognizer.dispose?.();
    void conversation.dispose?.();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
