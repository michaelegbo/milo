import { test, expect } from '@playwright/test';
import { createTalkingMotion, type TalkingPose } from '../src/talking-motion';

const magnitude = (pose: TalkingPose) => Math.max(...Object.values(pose).map(Math.abs));
const silence = { level: 0, bands: [0, 0, 0], speaking: false };
const voice = { level: 0.22, bands: [0.3, 0.4, 0.2], speaking: true };

test('gestures require audible speech, use both hands, and settle on pause and disable', () => {
  const motion = createTalkingMotion();
  for (let frame = 0; frame < 120; frame++) {
    expect(magnitude(motion.update(1 / 60, { ...silence, speaking: true }, true))).toBe(0);
  }
  let leftPeak = 0, rightPeak = 0, bodyPeak = 0;
  for (let frame = 0; frame < 600; frame++) {
    const pose = motion.update(1 / 60, voice, true);
    leftPeak = Math.max(leftPeak, Math.abs(pose.leftElbow));
    rightPeak = Math.max(rightPeak, Math.abs(pose.rightElbow));
    bodyPeak = Math.max(bodyPeak, Math.abs(pose.bodyY));
  }
  expect(leftPeak).toBeGreaterThan(0.3);
  expect(rightPeak).toBeGreaterThan(0.3);
  expect(bodyPeak).toBeGreaterThan(0.01);
  let rest = motion.update(1 / 60, silence, true);
  for (let frame = 0; frame < 60; frame++) rest = motion.update(1 / 60, silence, true);
  expect(magnitude(rest)).toBeLessThan(0.0001);
  for (let frame = 0; frame < 80; frame++) motion.update(1 / 60, voice, true);
  for (let frame = 0; frame < 30; frame++) rest = motion.update(1 / 60, voice, false);
  expect(magnitude(rest)).toBeLessThan(0.0001);
});

test('gesture joints stay bounded through accents, silence and irregular frame times', () => {
  const motion = createTalkingMotion();
  const first = motion.update(0, silence, true);
  for (let frame = 0; frame < 900; frame++) {
    const voiced = frame % 190 < 140;
    const dt = frame % 97 === 0 ? 2 : frame % 59 === 0 ? Number.NaN : 1 / 60;
    const pose = motion.update(dt, { level: voiced ? 0.5 + Math.sin(frame * 0.3) * 0.5 : 0, bands: [], speaking: voiced }, true);
    expect(pose).toBe(first);
    expect(Object.values(pose).every(Number.isFinite)).toBe(true);
    expect(pose.leftShoulderZ).toBeLessThanOrEqual(0);
    expect(pose.rightShoulderZ).toBeGreaterThanOrEqual(0);
    expect(Math.abs(pose.leftElbow)).toBeLessThanOrEqual(0.85);
    expect(Math.abs(pose.rightElbow)).toBeLessThanOrEqual(0.85);
    expect(Math.abs(pose.bodyY)).toBeLessThanOrEqual(0.07);
    expect(Math.abs(pose.headX)).toBeLessThanOrEqual(0.12);
  }
  expect(Object.values(motion.update(1 / 60, { level: NaN, bands: [], speaking: true }, true)).every(Number.isFinite)).toBe(true);
});
