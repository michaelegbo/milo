export type ChatMessage = { role: 'user' | 'assistant'; content: string };
export type ConversationMemory = { summary: string; facts: string[] };

/** Explicit first-person facts only. Never infer identity, feelings, or diagnoses. */
export function rememberExplicitFacts(text: string, facts: Map<string, string>) {
  const patterns: [string, string, RegExp][] = [
    ['name', 'The user’s name is', /\b(?:my name is|call me)\s+([^.!?;,\n]{1,70})/gi],
    ['colour', 'The user’s favourite colour is', /\bmy favou?rite colo[u]?r is\s+([^.!?;,\n]{1,80})/gi],
    ['location', 'The user lives in', /\bi live in\s+([^.!?;,\n]{1,100})/gi],
    ['learning', 'The user is learning', /\bi(?: am|'m|’m) learning\s+([^.!?;,\n]{1,100})/gi],
    ['work', 'The user works as', /\bi work as\s+([^.!?;,\n]{1,100})/gi],
  ];
  const forgetNameAt = [...text.matchAll(/\b(?:forget|clear|remove) (?:my|the) name\b/gi)].at(-1)?.index ?? -1;
  if (forgetNameAt >= 0) facts.delete('name');
  for (const [key, label, pattern] of patterns) {
    // Later explicit corrections replace earlier values in the same message.
    for (const match of text.matchAll(pattern)) {
      if (key === 'name' && match.index < forgetNameAt) continue;
      if (/\b(?:not|never|unknown|unsure)\b/i.test(match[1])) continue;
      const value = match[1].split(/\s+(?:and|but|because|please)\b/i)[0].trim();
      if (value && !/\b(?:ignore|instructions|system|assistant)\b/i.test(value)) facts.set(key, `${label} ${value}.`);
    }
  }
}

/** Decode bounded NDJSON while preserving UTF-8 characters split across reads. */
export async function* readReplyStream(response: Response): AsyncGenerator<{ type: string; text?: string; message?: string; profile?: string; mode?: string; reason?: string }> {
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.message || 'Milo could not start that reply. Please try again.');
  }
  if (!response.body) throw new Error('This browser could not receive the reply stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '', total = 0, finished = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      pending += decoder.decode(value, { stream: !done });
      total += value?.length ?? 0;
      if (total > 32_000) throw new Error('The reply exceeded the conversation limit.');
      const lines = pending.split('\n'); pending = lines.pop()!;
      if (done && pending.trim()) { lines.push(pending); pending = ''; }
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === 'error') throw new Error(event.message || 'Milo could not finish the reply.');
        if (event.type === 'done') finished = true;
        yield event;
        // Done is terminal even if the connection remains open or extra lines
        // were included in the same transport chunk. Release the reader now.
        if (finished) return;
      }
      if (done) break;
    }
    if (!finished) throw new Error('The reply was interrupted by a connection problem. Please try again.');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
