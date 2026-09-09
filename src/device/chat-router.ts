import type { ChatMessage, ConversationMemory } from '../conversation-memory';
import type { ChatProfile } from './chat-policy';

const GREETING = /^(?:(?:hi|hey|hello|greetings)(?:\s+(?:there|again|milo))?|(?:good\s+(?:morning|afternoon|evening))(?:\s+milo)?|how are you(?:\s+(?:doing|today|milo))?|how(?:'s| is) it going|what(?:'s| is) up|thanks(?:\s+(?:a lot|milo|so much))?|thank you(?:\s+milo)?|you(?:'re| are) welcome|bye(?:\s+milo)?|goodbye|good night|okay|ok|got it|that(?:'s| is) all)[\s!?.]*$/i;
const LIGHT_CREATIVE = /^(?:please\s+)?(?:tell (?:me|us) (?:a|one) (?:short |quick |funny )?joke|say hello|greet me|wish me (?:a )?(?:good morning|good night|happy birthday))[\s!?.]*$/i;
const LITERAL = /^(?:please\s+)?(?:say|repeat|read)(?:\s+aloud)?(?:\s+the (?:words|sentence|phrase|text))?\s+["“'][\s\S]+["”'][\s.!?]*$/i;
const MEMORY = /\b(?:remember|recall|earlier|previously|last time|my (?:name|age|birthday|address|favourite|favorite|job|work|hobby|hobbies|preference|preferences|goal|goals|plan|plans|pet|pets|family)|(?:what|which)\s+(?:did|have)\s+i\s+(?:say|tell|mention)|what do you know about me|who am i|where do i live|what am i learning|i (?:live in|prefer|am learning)|my name is|i(?:'m| am) called|correction|actually i)\b/i;
const CODE = /```|=>|\bfunction\s+\w+\s*\(|\b(?:code|coding|debug|debugging|typescript|javascript|python|sql|regex|algorithm|stack trace|exception|compiler|programming|api|database|react|three\.js|threejs|architecture)\b/i;
const REASONING = /\b(?:why|explain|reasoning|reason|analy[sz]e|analysis|compare|comparison|contrast|trade[ -]?offs?|pros and cons|evaluate|prove|derive|calculate|solve|equation|mathematics|math|plan|planning|design|strategy|recommend|step[ -]by[ -]step|deeper|in[ -]depth|think carefully|best way|advantages|disadvantages)\b|^how (?:do|does|can|could|should|would|to)\b|^should (?:i|we)\b/i;
const ARITHMETIC = /\d\s*(?:[+*/=]|\s-\s)\s*[\d(]|\b\d+\s*(?:plus|minus|times|divided by|percent of)\s*\d+\b/i;
const COMPARISON = /\bdifference between\b|\b(?:better|safer|faster|slower|cheaper|worse) than\b|\bwhich (?:is|would be) (?:better|safer|faster|cheaper|best)\b|\bwould you (?:pick|choose|prefer)\b|\bchoose between\b/i;
const FOLLOWUP = /^(?:and\b|but\b|what about\b|how about\b|why[?.!]*$|yes(?: please)?[?.!]*$|continue\b|go on\b|tell me more\b|can you (?:expand|elaborate|give (?:me )?an example)|could you (?:expand|elaborate))|\b(?:that|those|the same|option (?:two|three|one|\d+)|more detail)\b/i;

function baseRoute(text: string): { profile: ChatProfile; rule: string; reason: string } | null {
  if (LITERAL.test(text)) return { profile: 'fast', rule: 'literal_output', reason: 'A short request to repeat supplied words.' };
  if (GREETING.test(text) || LIGHT_CREATIVE.test(text)) return { profile: 'fast', rule: 'social', reason: 'A short greeting, acknowledgement, or light request.' };
  if (MEMORY.test(text)) return { profile: 'quality', rule: 'personal_context', reason: 'This uses personal details or earlier conversation memory.' };
  if (CODE.test(text)) return { profile: 'quality', rule: 'technical', reason: 'This asks for technical or coding work.' };
  if (REASONING.test(text) || ARITHMETIC.test(text) || COMPARISON.test(text)) return { profile: 'quality', rule: 'reasoning', reason: 'This asks for reasoning, planning, calculation, or comparison.' };
  if (text.length > 220 || text.split(/\s+/).length > 40 || (text.match(/\?/g) ?? []).length > 1) return { profile: 'quality', rule: 'multi_part', reason: 'This is a longer or multi-part request.' };
  return null;
}

/** Route once using only supplied conversation context; no model confidence guess. */
export function routeHybrid(messages: ChatMessage[], memory: ConversationMemory = { summary: '', facts: [] }, { operation = 'reply' }: { operation?: string } = {}): { profile: ChatProfile; rule: string; reason: string } {
  if (operation === 'summary') return { profile: 'quality', rule: 'memory_summary', reason: 'Retaining conversation details needs the stronger model.' };
  const latest = messages.at(-1)?.content.trim() ?? '';
  const direct = baseRoute(latest);
  if (direct) return direct;
  if (latest.length <= 220 && FOLLOWUP.test(latest)) {
    const priorUsers = messages.slice(0, -1).filter(message => message.role === 'user').slice(-6);
    if (priorUsers.some(message => baseRoute(message.content)?.profile === 'quality') || memory.summary || memory.facts?.length) {
      return { profile: 'quality', rule: 'context_followup', reason: 'This follows up on a more involved conversation.' };
    }
  }
  return { profile: 'fast', rule: 'simple', reason: 'A short, straightforward request.' };
}
