import { CHAT_MAX_REPLY_LENGTH, ChatError } from './chat-config.mjs';

const ABBREVIATIONS = new Set(['mr.', 'mrs.', 'ms.', 'dr.', 'prof.', 'sr.', 'jr.', 'st.', 'vs.', 'etc.', 'e.g.', 'i.e.', 'no.', 'fig.', 'approx.', 'dept.', 'inc.', 'ltd.']);
function endsSentence(word) {
  const bare = word.replace(/^["'(\[]+|["')\]]+$/g, '');
  if (/[!?]$/.test(bare)) return true;
  if (!bare.endsWith('.') || ABBREVIATIONS.has(bare.toLowerCase())) return false;
  // A. Smith, U.S., numbered items, and decimals inside a sentence are not
  // reliable sentence boundaries. Prefer a slightly longer reply to lost words.
  if (/^(?:[a-z]\.)+$/i.test(bare) || /^\d+\.$/.test(bare)) return false;
  return true;
}

// Emit cleaned words while generation continues. Hold only the small initial
// role-label prefix and the unfinished word. Concatenating deltas equals the
// final reply exactly; the client can play each completed sentence once.
export function createReplyStream(onChunk, onLimit = () => {}) {
  let pending = '';
  let text = '';
  let sentences = 0;
  let closed = false;
  let prefixReady = false;
  function close() {
    if (closed) return;
    closed = true;
    onLimit();
  }
  function emitWord(word) {
    if (closed || !word) return;
    const separator = text ? ' ' : '';
    if (text.length + separator.length + word.length > CHAT_MAX_REPLY_LENGTH) {
      const remaining = CHAT_MAX_REPLY_LENGTH - text.length;
      const suffix = text ? (remaining ? '…' : '') : `${word.slice(0, CHAT_MAX_REPLY_LENGTH - 1)}…`;
      if (suffix) { text += suffix; onChunk?.(suffix); }
      close();
      return;
    }
    const delta = separator + word;
    text += delta;
    onChunk?.(delta);
    if (endsSentence(word)) sentences += 1;
    if (sentences >= 3 || text.length >= CHAT_MAX_REPLY_LENGTH) close();
  }
  function drain(final = false) {
    if (!prefixReady) {
      // A role label can arrive over several model chunks ("Mi", "lo", ":").
      if (!final && pending.length < 24) return;
      pending = pending.replace(/^\s*(?:Milo|Assistant)\s*:\s*/i, '').trimStart();
      prefixReady = true;
    }
    pending = pending.replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trimStart();
    const end = final ? pending.length : pending.lastIndexOf(' ');
    if (end > 0) {
      const complete = pending.slice(0, end);
      pending = final ? '' : pending.slice(end + 1);
      for (const word of complete.split(' ')) {
        if (closed) break;
        emitWord(word);
      }
    }
    if (!closed && pending.length > CHAT_MAX_REPLY_LENGTH) {
      emitWord(pending);
      pending = '';
    }
  }
  function push(chunk) {
    if (closed) return;
    pending += chunk;
    drain();
  }
  function finish() {
    if (!closed) drain(true);
    pending = '';
    if (!text) throw new ChatError(500, 'empty_reply', 'Milo could not form a reply. Please try a shorter question.');
    return text;
  }
  return { push, finish };
}
