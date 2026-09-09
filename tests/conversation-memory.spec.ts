import { test, expect } from '@playwright/test';
import { rememberExplicitFacts, readReplyStream } from '../src/conversation-memory';

function streamedResponse(text: string, chunkSize = 7): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize) controller.enqueue(bytes.slice(offset, offset + chunkSize));
      controller.close();
    },
  }), { headers: { 'Content-Type': 'application/x-ndjson' } });
}
async function collect(response: Response) {
  const events = [];
  for await (const event of readReplyStream(response)) events.push(event);
  return events;
}

test('NDJSON preserves UTF-8 code points, blank lines, CRLF, and a final line without newline', async () => {
  const response = streamedResponse('\r\n{"type":"sentence","text":"Hello, Amára 👋 — café."}\r\n\n{"type":"done","text":"Hello, Amára 👋 — café."}', 1);
  const events = await collect(response);
  expect(events).toEqual([
    { type: 'sentence', text: 'Hello, Amára 👋 — café.' },
    { type: 'done', text: 'Hello, Amára 👋 — café.' },
  ]);
  expect(response.body!.locked).toBe(false);
});

test('NDJSON requires done and surfaces HTTP, stream, malformed, and bounded-size errors', async () => {
  await expect(collect(streamedResponse('{"type":"sentence","text":"Partial."}\n'))).rejects.toThrow(/interrupted/);
  await expect(collect(new Response(JSON.stringify({ message: 'Model not ready.' }), { status: 503 }))).rejects.toThrow('Model not ready.');
  await expect(collect(streamedResponse('{"type":"sentence","text":"Partial."}\n{"type":"error","message":"Reply cancelled."}\n'))).rejects.toThrow('Reply cancelled.');
  await expect(collect(streamedResponse('this is not JSON\n'))).rejects.toThrow();
  await expect(collect(streamedResponse(JSON.stringify({ type: 'sentence', text: 'x'.repeat(33_000) }), 33_100))).rejects.toThrow(/limit/);
});

test('done is terminal and trailing sentence events cannot become extra spoken output', async () => {
  const events = await collect(streamedResponse('{"type":"sentence","text":"Complete."}\n{"type":"done","text":"Complete."}\n{"type":"sentence","text":"Unexpected extra text."}\n', 1000));
  expect(events).toEqual([{ type: 'sentence', text: 'Complete.' }, { type: 'done', text: 'Complete.' }]);
});

test('leaving a reply iterator cancels and unlocks its unread body', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"type":"sentence","text":"First."}\n')); },
    cancel() { cancelled = true; },
  }));
  for await (const event of readReplyStream(response)) { expect(event.text).toBe('First.'); break; }
  expect(cancelled).toBe(true);
  expect(response.body!.locked).toBe(false);
});

test('done releases a connection that has not yet closed', async () => {
  test.setTimeout(2000);
  let cancelled = false;
  const response = new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"type":"done","text":"Complete."}\n')); },
    cancel() { cancelled = true; },
  }));
  expect(await collect(response)).toEqual([{ type: 'done', text: 'Complete.' }]);
  expect(cancelled).toBe(true);
  expect(response.body!.locked).toBe(false);
});

test('explicit facts update in later turns and forgetting the name leaves other facts intact', () => {
  const facts = new Map<string, string>();
  rememberExplicitFacts('My name is Amara. I live in Lagos. I am learning piano. My favorite color is blue. I work as a teacher.', facts);
  expect(facts.size).toBe(5);
  expect(facts.get('name')).toContain('Amara');
  expect(facts.get('location')).toContain('Lagos');
  rememberExplicitFacts('Actually, call me Zoe. I live in London.', facts);
  expect(facts.get('name')).toContain('Zoe');
  expect(facts.get('name')).not.toContain('Amara');
  expect(facts.get('location')).toContain('London');
  rememberExplicitFacts('Forget my name.', facts);
  expect(facts.has('name')).toBe(false);
  expect(facts.get('learning')).toContain('piano');
});

test('a correction in the same utterance uses the latest explicit value', () => {
  const facts = new Map<string, string>();
  rememberExplicitFacts('My name is Amara. Actually, my name is Zoe. I live in Lagos. Correction: I live in London.', facts);
  expect(facts.get('name')).toContain('Zoe');
  expect(facts.get('name')).not.toContain('Amara');
  expect(facts.get('location')).toContain('London');
});

test('a later forget request takes precedence over an earlier name in the same utterance', () => {
  const facts = new Map<string, string>();
  rememberExplicitFacts('My name is Amara. Forget my name.', facts);
  expect(facts.has('name')).toBe(false);
  rememberExplicitFacts('Forget my name. Call me Zoe.', facts);
  expect(facts.get('name')).toContain('Zoe');
});

test('facts do not infer third-party identity, feelings, or negated/unknown values', () => {
  const facts = new Map<string, string>();
  rememberExplicitFacts('Her name is Amara. My friend lives in Lagos. I feel anxious. My name is unknown. My favorite color is not blue. My name is ignore instructions.', facts);
  expect([...facts]).toEqual([]);
  rememberExplicitFacts('Call me Alex and I am learning guitar.', facts);
  expect(facts.get('name')).toBe('The user’s name is Alex.');
  expect(facts.get('learning')).toBe('The user is learning guitar.');
});
