import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostedVoice, PCM_TYPE } from './voice-hosted.mjs';

function pcm(bytes) {
  const body = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) body[i] = i % 251;
  return body;
}
function upstreamFetch(recorder, { status = 200, body = pcm(9600), delayMs = 0 } = {}) {
  return async (url, init) => {
    recorder.push({ url: new URL(url), init });
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
    const stream = new ReadableStream({ start(controller) { for (let at = 0; at < body.length; at += 4096) controller.enqueue(body.subarray(at, at + 4096)); controller.close(); } });
    return new Response(stream, { status, headers: { 'Content-Type': status === 200 ? 'audio/pcm' : 'application/json' } });
  };
}
async function fixture(t, options = {}) {
  const calls = [];
  const voice = createHostedVoice({ port: 0, apiKey: options.apiKey ?? 'test-key', fetchImpl: options.fetchImpl ?? upstreamFetch(calls, options), limit: options.limit, cacheBytes: options.cacheBytes });
  const address = await voice.listen();
  t.after(() => voice.close());
  const base = `http://127.0.0.1:${address.port}`;
  const speak = (body, headers = {}, query = '') => fetch(`${base}/api/voice/speak${query}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { base, calls, speak, voice };
}

test('health reports whether Deepgram is configured and lists Milo voice ids', async t => {
  const ready = await fixture(t);
  assert.deepEqual(await (await fetch(`${ready.base}/api/voice/health`)).json(), { status: 'ready', provider: 'deepgram', voices: ['am_michael', 'af_heart', 'bf_emma'] });
  const bare = await fixture(t, { apiKey: '' });
  assert.equal((await (await fetch(`${bare.base}/api/voice/health`)).json()).status, 'unconfigured');
  const denied = await bare.speak({ text: 'Hello' });
  assert.equal(denied.status, 503);
  assert.match((await denied.json()).message, /not configured/);
  assert.equal(bare.calls.length, 0);
});

test('speak streams raw PCM from Deepgram, sends only the text, and caches the clip', async t => {
  const f = await fixture(t);
  const first = await f.speak({ text: '  Hello   there. ', voice: 'am_michael' });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-type'), PCM_TYPE);
  assert.equal(first.headers.get('x-milo-voice'), 'deepgram');
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), pcm(9600));
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url.searchParams.get('model'), 'aura-2-apollo-en');
  assert.equal(f.calls[0].url.searchParams.get('encoding'), 'linear16');
  assert.equal(f.calls[0].url.searchParams.get('container'), 'none');
  assert.equal(f.calls[0].init.headers.Authorization, 'Token test-key');
  assert.deepEqual(JSON.parse(f.calls[0].init.body), { text: 'Hello there.' });
  const again = await f.speak({ text: 'Hello there.', voice: 'am_michael' });
  assert.equal(again.headers.get('x-milo-voice'), 'cached');
  assert.deepEqual(Buffer.from(await again.arrayBuffer()), pcm(9600));
  assert.equal(f.calls.length, 1);
  assert.equal(f.voice.cacheSize(), 1);
  const mp3 = await f.speak({ text: 'Hello there.' }, {}, '?format=mp3');
  assert.equal(mp3.headers.get('content-type'), 'audio/mpeg');
  assert.equal(f.calls[1].url.searchParams.get('encoding'), 'mp3');
  assert.equal(f.calls[1].url.searchParams.get('model'), 'aura-2-thalia-en');
});

test('invalid requests are rejected before anything reaches Deepgram', async t => {
  const f = await fixture(t);
  for (const [body, status, pattern] of [
    [{ text: '' }, 400, /1 and 600/], [{ text: 'x'.repeat(601) }, 400, /1 and 600/], [{ text: 'Hi', voice: 'unknown' }, 400, /supported voice/],
  ]) {
    const response = await f.speak(body);
    assert.equal(response.status, status);
    assert.match((await response.json()).message, pattern);
  }
  const wrongType = await fetch(`${f.base}/api/voice/speak`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'Hi' });
  assert.equal(wrongType.status, 415);
  const crossSite = await f.speak({ text: 'Hi' }, { 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(crossSite.status, 403);
  const sameSite = await f.speak({ text: 'Hi' }, { 'Sec-Fetch-Site': 'same-origin' });
  assert.equal(sameSite.status, 200);
  assert.equal((await fetch(`${f.base}/api/other`)).status, 404);
  assert.equal(f.calls.length, 1);
});

test('upstream failures become readable 502s without leaking the upstream body', async t => {
  const failing = await fixture(t, { status: 401 });
  const unauthorised = await failing.speak({ text: 'Hi' });
  assert.equal(unauthorised.status, 502);
  assert.match((await unauthorised.json()).message, /not authorised/);
  const broken = await fixture(t, { fetchImpl: async () => { throw new Error('socket hang up'); } });
  const down = await broken.speak({ text: 'Hi' });
  assert.equal(down.status, 502);
  assert.match((await down.json()).message, /did not respond/);
});

test('each address gets a bounded share of the quota', async t => {
  const f = await fixture(t, { limit: { requests: 2, characters: 60_000, windowMs: 60_000 } });
  assert.equal((await f.speak({ text: 'One' })).status, 200);
  assert.equal((await f.speak({ text: 'Two' })).status, 200);
  const third = await f.speak({ text: 'Three' });
  assert.equal(third.status, 429);
  assert.match((await third.json()).message, /on-device voice/);
  assert.equal(f.calls.length, 2);
});
