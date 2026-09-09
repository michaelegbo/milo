/** Additive offsets from the avatar's neutral pose; all rotations are radians. */
export type TalkingPose = {
  bodyX: number; bodyY: number; bodyZ: number; bodyLift: number;
  headX: number; headY: number; headZ: number;
  leftShoulderX: number; leftShoulderZ: number;
  rightShoulderX: number; rightShoulderZ: number;
  leftElbow: number; rightElbow: number;
  leftWristX: number; leftWristZ: number;
  rightWristX: number; rightWristZ: number;
};

type MotionAudio = { level: number; bands: number[]; speaking: boolean };

function restPose(): TalkingPose {
  return {
    bodyX: 0, bodyY: 0, bodyZ: 0, bodyLift: 0,
    headX: 0, headY: 0, headZ: 0,
    leftShoulderX: 0, leftShoulderZ: 0,
    rightShoulderX: 0, rightShoulderZ: 0,
    leftElbow: 0, rightElbow: 0,
    leftWristX: 0, leftWristZ: 0,
    rightWristX: 0, rightWristZ: 0,
  };
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));
const approach = (dt: number, seconds: number) => 1 - Math.exp(-dt / seconds);
function ease(a: number, b: number, value: number) {
  const t = clamp((value - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Phrase-sized gestures driven by real audio, with no timer-based idle motion.
 * Each instance owns one reused pose object. Consumers should read its values,
 * rather than mutate or retain it as a snapshot of an earlier frame.
 */
export function createTalkingMotion() {
  const pose = restPose();
  const target = restPose();
  const keys = Object.keys(pose) as (keyof TalkingPose)[];
  let energy = 0;
  let baseline = 0;
  let presence = 0;
  let silence = 1;
  let cooldown = 0;
  let gesture = -1;
  let progress = 0;
  let duration = 1.4;
  let active = false;
  let wasVoiced = false;
  let previousEnergy = 0;

  return {
    update(dt: number, audio: MotionAudio, enabled: boolean): TalkingPose {
      // Background-tab jumps and corrupt analyser values cannot create a pose jump.
      dt = Number.isFinite(dt) ? clamp(dt, 0, 0.08) : 0;
      const raw = audio.speaking && Number.isFinite(audio.level)
        ? clamp(audio.level, 0, 1) : 0;
      energy += (raw - energy) * approach(dt, 0.10);
      baseline += (energy - baseline) * approach(dt, 0.55);
      const voiced = audio.speaking && raw > 0.035;
      const precedingSilence = silence;
      silence = voiced ? 0 : silence + dt;
      const carryingPhrase = enabled && audio.speaking && silence < 0.18;
      const presenceTarget = carryingPhrase ? 1 : 0;
      const releaseTime = !enabled ? 0.035 : audio.speaking ? 0.09 : 0.075;
      presence += (presenceTarget - presence) * approach(dt, presenceTarget ? 0.08 : releaseTime);

      if (!enabled) {
        active = false;
        cooldown = 0;
      }
      // A pause freezes the gesture clock; its visible pose still settles below.
      if (carryingPhrase) cooldown = Math.max(0, cooldown - dt);
      const onset = voiced && !wasVoiced && precedingSilence >= 0.075;
      const accent = voiced && energy > baseline + 0.018 && energy > previousEnergy + 0.0001;
      // Sustained speech can start the next phrase gesture, but only while actual
      // audio is present. The cooldown and completed envelope bound the cadence.
      const continuingPhrase = voiced && energy > 0.045 && cooldown === 0;
      if (enabled && !active && cooldown === 0 && (onset || accent || continuingPhrase)) {
        gesture += 1;
        duration = 1.28 + (gesture % 4) * 0.13;
        cooldown = 1.25 + (gesture % 3) * 0.24;
        progress = 0;
        active = true;
      }
      wasVoiced = voiced;
      previousEnergy = energy;
      if (active && carryingPhrase) {
        progress = Math.min(1, progress + dt / duration);
        if (progress === 1) active = false;
      }

      for (const key of keys) target[key] = 0;
      if (active) {
        const envelope = ease(0, 0.24, progress) * (1 - ease(0.61, 1, progress));
        const emphasis = 0.70 + 0.30 * clamp(energy * 2.5, 0, 1);
        const amount = envelope * presence * emphasis;
        const left = gesture % 2 === 0;
        const side = left ? -1 : 1;
        const kind = gesture % 5;
        const sweep = kind === 4 ? ease(0.25, 0.70, progress) : 0;
        const shoulder = -(0.48 - sweep * 0.06) * amount;
        const outward = (0.24 + sweep * 0.17) * amount;
        const elbow = -(0.64 - sweep * 0.16) * amount;
        const wrist = -(0.12 + sweep * 0.06) * amount;

        if (kind === 2) {
          // A compact, symmetrical emphasis pose between one-handed gestures.
          target.leftShoulderX = target.rightShoulderX = -0.36 * amount;
          target.leftShoulderZ = -0.20 * amount;
          target.rightShoulderZ = 0.20 * amount;
          target.leftElbow = target.rightElbow = -0.59 * amount;
          target.leftWristX = target.rightWristX = -0.11 * amount;
          target.leftWristZ = -0.12 * amount;
          target.rightWristZ = 0.12 * amount;
        } else if (left) {
          target.leftShoulderX = shoulder;
          target.leftShoulderZ = -outward;
          target.leftElbow = elbow;
          target.leftWristX = wrist;
          target.leftWristZ = -(0.13 + sweep * 0.07) * amount;
          target.rightShoulderX = -0.05 * amount;
          target.rightElbow = -0.10 * amount;
        } else {
          target.rightShoulderX = shoulder;
          target.rightShoulderZ = outward;
          target.rightElbow = elbow;
          target.rightWristX = wrist;
          target.rightWristZ = (0.13 + sweep * 0.07) * amount;
          target.leftShoulderX = -0.05 * amount;
          target.leftElbow = -0.10 * amount;
        }

        const direction = kind === 2 ? 0 : side;
        const nod = ease(0.12, 0.36, progress) * (1 - ease(0.42, 0.76, progress));
        target.bodyX = 0.024 * amount;
        target.bodyY = direction * 0.028 * amount;
        target.bodyZ = direction * 0.020 * amount;
        target.bodyLift = 0.010 * amount;
        target.headX = (0.028 * envelope + 0.068 * nod) * presence * emphasis;
        target.headY = direction * -0.034 * amount;
        target.headZ = direction * -0.025 * amount;
      }

      const smoothing = approach(dt, !enabled ? 0.045 : audio.speaking ? 0.065 : 0.09);
      for (const key of keys) {
        pose[key] += (target[key] - pose[key]) * smoothing;
        if (Math.abs(pose[key]) < 0.00001 && Math.abs(target[key]) < 0.00001) pose[key] = 0;
      }
      return pose;
    },
  };
}
