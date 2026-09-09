import type { AvatarPresence } from './avatar-expression';

/**
 * A small delivery cue based only on words Milo is about to say.
 * These are transparent punctuation/phrase rules, not emotion recognition.
 */
export function inferUtteranceMood(text: string): AvatarPresence['expression'] {
  const words = text.replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
  if (!words) return 'neutral';
  if (/\b(i(?:'m| am) not (?:sure|certain)|i (?:do not|don't) know|i (?:may|might) be wrong|let me think|i need to think)\b/.test(words)) return 'thoughtful';
  if (/\b(you(?:'ve| have) got this|you can do it|well done|great job|keep going|keep creating|small steps|i believe in you|proud of you)\b/.test(words)) return 'encouraging';
  if (words.includes('?')) return 'curious';
  return 'warm';
}
