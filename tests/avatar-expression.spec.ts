import { test, expect } from '@playwright/test';
import { createAvatarExpression, type AvatarPresence, type ExpressionAudio, type ExpressionMotion } from '../src/avatar-expression';

const silence: ExpressionAudio = { level: 0, bands: [0, 0, 0], speaking: false };
const idle: AvatarPresence = { state: 'idle', inputLevel: 0, expression: 'neutral' };
const still: ExpressionMotion = { idle: false, gestures: false, reducedMotion: false };
const settle = (audio: ExpressionAudio, presence: AvatarPresence, motion = still) => {
  const controller = createAvatarExpression();
  let pose = controller.update(1 / 60, audio, presence, motion);
  for (let frame = 0; frame < 120; frame++) pose = controller.update(1 / 60, audio, presence, motion);
  return { ...pose };
};

test('listening and thinking have distinct faces but microphone activity never opens Milo’s mouth', () => {
  const rest = settle(silence, idle);
  const listening = settle({ ...silence, level: 1 }, { ...idle, state: 'listening', inputLevel: 1 });
  const thinking = settle(silence, { ...idle, state: 'thinking' });
  expect(listening.eyeOpenLeft).toBeGreaterThan(rest.eyeOpenLeft);
  expect(listening.lightG).toBeGreaterThan(rest.lightG);
  expect(thinking.browLeftY).toBeGreaterThan(thinking.browRightY);
  expect(thinking.gazeX).not.toBe(listening.gazeX);
  for (const pose of [rest, listening, thinking]) expect(pose.mouthOpen).toBe(0);
  for (const expression of ['warm', 'curious', 'encouraging', 'thoughtful'] as const) {
    expect(settle(silence, { ...idle, expression }).mouthOpen).toBe(0);
  }
});

test('real speech energy opens the mouth, spectrum changes its shape, and stopped speech settles closed', () => {
  const low = settle({ level: 0.3, bands: [1, 0.1, 0.1], speaking: true }, { ...idle, state: 'speaking' });
  const high = settle({ level: 0.3, bands: [0.1, 0.5, 1], speaking: true }, { ...idle, state: 'speaking' });
  expect(low.mouthOpen).toBeGreaterThan(0.5);
  expect(high.mouthOpen).toBeCloseTo(low.mouthOpen, 4);
  expect(low.mouthRound).toBeGreaterThan(high.mouthRound + 0.5);
  expect(high.mouthWidth).toBeGreaterThan(low.mouthWidth + 0.2);
  const controller = createAvatarExpression();
  const pose = controller.update(1 / 60, { level: 1, bands: [0.3, 0.2, 0.4], speaking: true }, idle, still);
  for (let frame = 0; frame < 90; frame++) {
    expect(controller.update(1 / 60, silence, idle, still)).toBe(pose);
  }
  expect(pose.mouthOpen).toBeLessThan(0.00001);
  expect(pose.mouthRound).toBeLessThan(0.00001);
  expect(pose.mouthWidth).toBeCloseTo(1, 5);
});

test('reduced motion stops ambient movement while keeping expression and speech; disabled gestures and invalid frames stay safe', () => {
  const controller = createAvatarExpression();
  const presence: AvatarPresence = { state: 'listening', inputLevel: 0.6, expression: 'encouraging' };
  const moving: ExpressionMotion = { idle: true, gestures: true, reducedMotion: false };
  for (let frame = 0; frame < 120; frame++) controller.update(1 / 60, silence, presence, moving);
  const reduced = { ...moving, reducedMotion: true };
  const pose = controller.update(1 / 60, silence, presence, reduced);
  for (const key of ['headX', 'headY', 'headZ', 'bodyX', 'bodyY', 'bodyZ', 'gazeX', 'gazeY'] as const) expect(pose[key]).toBe(0);
  expect(pose.smile).toBeGreaterThan(0.8);
  const stableEyes = pose.eyeOpenLeft;
  const stableLight = pose.lightIntensity;
  for (let frame = 0; frame < 400; frame++) controller.update(1 / 60, silence, presence, reduced);
  expect(pose.eyeOpenLeft).toBe(stableEyes);
  expect(pose.lightIntensity).toBe(stableLight);
  controller.update(0.08, { level: 0.5, bands: [0.3, 0.2, 0.5], speaking: true }, presence, reduced);
  expect(pose.mouthOpen).toBeGreaterThan(0.5);
  for (const dt of [Number.NaN, 99, -1, 0]) {
    const safe = controller.update(dt, { level: Number.NaN, bands: [Infinity, NaN], speaking: true }, { ...presence, inputLevel: Infinity }, { ...moving, gestures: false });
    expect(Object.values(safe).every(Number.isFinite)).toBe(true);
    for (const key of ['headX', 'headY', 'headZ', 'bodyX', 'bodyY', 'bodyZ'] as const) expect(safe[key]).toBe(0);
  }
});
