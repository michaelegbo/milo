/** Studio presets. Shared with scripts/prepare-preset-audio.mjs, which pre-renders them. */
export const presets = [
  { title: 'A little introduction', category: 'SAY HELLO', icon: 'hand', text: "Hey there! I'm Milo, your little digital companion. Pick a sentence, and let's bring it to life." },
  { title: 'You’ve got this', category: 'A LITTLE ENCOURAGEMENT', icon: 'spark', text: "Big things start with small steps. You don't have to have it all figured out. Just keep creating. You've got this!" },
  { title: 'A moment to slow down', category: 'TAKE A BREATHER', icon: 'leaf', text: "Let's take a little break. Relax your shoulders, take a deep breath, and give yourself a moment. There's no rush." },
] as const;

export const PRESET_VOICES = ['am_michael', 'af_heart', 'bf_emma'] as const;

/** Pre-rendered Kokoro clip at normal pace; other paces and custom text are generated on the device. */
export function presetClipPath(index: number, voice: string) {
  return `/presets/${index + 1}-${voice}.mp3`;
}
