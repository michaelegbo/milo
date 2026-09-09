export type AvatarPresence = {
  state: 'idle' | 'listening' | 'transcribing' | 'thinking' | 'voicing' | 'speaking' | 'error';
  inputLevel: number;
  expression: 'neutral' | 'warm' | 'curious' | 'encouraging' | 'thoughtful';
};

export type ExpressionAudio = { level: number; bands: number[]; speaking: boolean };
export type ExpressionMotion = { idle: boolean; gestures: boolean; reducedMotion: boolean };

/** Face scales, local gaze offsets, additive body/head radians, and linear LED RGB. */
export type AvatarExpressionPose = {
  mouthOpen: number; mouthWidth: number; mouthRound: number;
  eyeOpenLeft: number; eyeOpenRight: number; eyeWidth: number;
  gazeX: number; gazeY: number;
  browLeftY: number; browRightY: number; browLeftZ: number; browRightZ: number;
  headX: number; headY: number; headZ: number;
  bodyX: number; bodyY: number; bodyZ: number;
  smile: number; cheekGlow: number;
  lightR: number; lightG: number; lightB: number; lightIntensity: number;
  gestureScale: number;
};

const REST: AvatarExpressionPose = {
  mouthOpen: 0, mouthWidth: 1, mouthRound: 0,
  eyeOpenLeft: 1, eyeOpenRight: 1, eyeWidth: 1,
  gazeX: 0, gazeY: 0,
  browLeftY: 0, browRightY: 0, browLeftZ: 0.13, browRightZ: -0.13,
  headX: 0, headY: 0, headZ: 0,
  bodyX: 0, bodyY: 0, bodyZ: 0,
  smile: 0.16, cheekGlow: 0.5,
  lightR: 1, lightG: 0.57, lightB: 0.22, lightIntensity: 1.05,
  gestureScale: 1,
};
const KEYS = Object.keys(REST) as (keyof AvatarExpressionPose)[];
const BODY_KEYS = ['headX', 'headY', 'headZ', 'bodyX', 'bodyY', 'bodyZ'] as const;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const finite = (value: number, fallback = 0) => Number.isFinite(value) ? value : fallback;
const approach = (dt: number, seconds: number) => 1 - Math.exp(-dt / seconds);

/**
 * One allocation per rig, not per frame. The returned pose is reused.
 * Spectrum-driven mouth shapes are visual approximations, not phoneme timing.
 * Input microphone energy can acknowledge a listener, but never opens the mouth.
 */
export function createAvatarExpression() {
  const pose = { ...REST };
  const target = { ...REST };
  let clock = 0;
  let blinkAt = 3.3;
  let blinkTime = -1;
  let blinkCount = 0;
  let nodProgress = -1;
  let nodCooldown = 0;
  let microphone = 0;
  let lastMicrophone = 0;
  let previousState: AvatarPresence['state'] = 'idle';

  return {
    update(dt: number, audio: ExpressionAudio, presence: AvatarPresence, motion: ExpressionMotion): AvatarExpressionPose {
      dt = clamp(finite(dt), 0, 0.08);
      const ambient = motion.idle && !motion.reducedMotion;
      const gestures = motion.gestures && !motion.reducedMotion;
      const state = audio.speaking ? 'speaking' : presence.state;
      const input = audio.speaking ? clamp(finite(audio.level), 0, 1) : 0;
      const level = input < 0.016 ? 0 : Math.min(1, input * 2.15);
      const micInput = state === 'listening' ? clamp(finite(presence.inputLevel), 0, 1) : 0;
      microphone += (micInput - microphone) * approach(dt, 0.09);
      for (const key of KEYS) target[key] = REST[key];

      // Presets affect the little LED face without changing the robot's identity.
      switch (presence.expression) {
        case 'warm':
          target.smile = 0.76;
          target.eyeOpenLeft = target.eyeOpenRight = 0.94;
          target.eyeWidth = 1.08;
          target.browLeftY = target.browRightY = 0.012;
          target.browLeftZ = -0.035; target.browRightZ = 0.035;
          target.gestureScale = 1.03;
          break;
        case 'curious':
          target.smile = 0.3;
          target.eyeOpenLeft = 1.1; target.eyeOpenRight = 0.98;
          target.browLeftY = 0.043; target.browRightY = 0.003;
          target.browLeftZ = 0.23; target.browRightZ = -0.06;
          target.gestureScale = 0.94;
          break;
        case 'encouraging':
          target.smile = 0.95;
          target.eyeOpenLeft = target.eyeOpenRight = 0.92;
          target.eyeWidth = 1.11;
          target.browLeftY = target.browRightY = 0.026;
          target.browLeftZ = -0.07; target.browRightZ = 0.07;
          target.gestureScale = 1.12;
          break;
        case 'thoughtful':
          target.smile = 0.07;
          target.eyeOpenLeft = 0.98; target.eyeOpenRight = 0.88;
          target.eyeWidth = 0.93;
          target.browLeftY = 0.035; target.browRightY = -0.004;
          target.browLeftZ = 0.25; target.browRightZ = -0.04;
          target.gestureScale = 0.82;
          break;
      }

      if (state !== previousState) {
        nodProgress = -1;
        nodCooldown = 0;
        lastMicrophone = 0;
        previousState = state;
      }
      nodCooldown = Math.max(0, nodCooldown - dt);
      if (state === 'listening') {
        target.eyeOpenLeft += 0.1; target.eyeOpenRight += 0.1;
        target.browLeftY += 0.018; target.browRightY += 0.028;
        target.smile = Math.max(target.smile, 0.32);
        target.headX = 0.026; target.headZ = -0.045;
        target.bodyX = 0.024; target.bodyZ = -0.006;
        target.lightR = 0.20; target.lightG = 0.88; target.lightB = 0.57;
        target.lightIntensity = 1.4;
        // A restrained acknowledgment on a voice onset, with a long cooldown.
        if (gestures && nodCooldown === 0 && nodProgress < 0 && microphone > 0.075 && lastMicrophone <= 0.075) {
          nodProgress = 0;
          nodCooldown = 2.4;
        }
        if (nodProgress >= 0 && gestures) {
          nodProgress = Math.min(1, nodProgress + dt / 0.68);
          target.headX += Math.sin(nodProgress * Math.PI) * 0.055;
          if (nodProgress === 1) nodProgress = -1;
        }
      } else if (state === 'thinking' || state === 'transcribing' || state === 'voicing') {
        target.gazeX = state === 'transcribing' ? -0.025 : 0.042;
        target.gazeY = 0.036;
        target.browLeftY = Math.max(target.browLeftY, 0.051);
        target.browRightY = 0.004;
        target.browLeftZ = 0.23; target.browRightZ = -0.045;
        target.eyeOpenLeft = 1.02; target.eyeOpenRight = 0.92;
        target.headX = -0.018; target.headY = 0.038; target.headZ = 0.023;
        target.smile = 0.12;
        target.lightR = 1; target.lightG = 0.55; target.lightB = 0.14;
        target.lightIntensity = 1.23;
      } else if (state === 'speaking') {
        target.lightR = 0.42; target.lightG = 0.81; target.lightB = 0.63;
        target.lightIntensity = 1.25;
        if (ambient) {
          target.browLeftY += level * 0.018;
          target.browRightY += level * 0.018;
        }
      } else if (state === 'error') {
        target.smile = 0.02;
        target.eyeOpenLeft = target.eyeOpenRight = 0.91;
        target.browLeftY = target.browRightY = 0.022;
        target.browLeftZ = 0.24; target.browRightZ = -0.24;
        target.lightR = 1; target.lightG = 0.31; target.lightB = 0.15;
        target.lightIntensity = 1.05;
      }
      lastMicrophone = microphone;

      // Fixed, bounded spectrum proportions keep silence still and avoid fake
      // syllables. High bands widen the mouth; lower bands round it slightly.
      const low = clamp(finite(audio.bands[0]), 0, 1);
      const middle = clamp(finite(audio.bands[1]), 0, 1);
      const high = clamp(finite(audio.bands[2]), 0, 1);
      const spectrum = low + middle + high;
      const round = level && spectrum > 0.0001 ? clamp((low / spectrum - 0.22) * 1.55, 0, 1) : 0;
      const wide = level && spectrum > 0.0001 ? clamp((middle + high) / spectrum, 0, 1) : 0;
      target.mouthOpen = level;
      target.mouthRound = round;
      target.mouthWidth = level ? clamp(1 + wide * 0.29 - round * 0.30 - level * 0.06, 0.68, 1.27) : 1;
      target.cheekGlow = 0.43 + target.smile * 0.55 + (state === 'listening' ? 0.09 : 0);

      if (ambient) {
        clock += dt;
        if (blinkTime < 0 && clock >= blinkAt) { blinkTime = 0; blinkCount++; }
        let blink = 1;
        if (blinkTime >= 0) {
          blinkTime += dt;
          blink = 1 - Math.sin(Math.min(1, blinkTime / 0.18) * Math.PI) * 0.94;
          if (blinkTime >= 0.18) {
            blinkTime = -1;
            blinkAt = clock + 3.5 + (blinkCount % 3) * 0.57;
          }
        }
        target.eyeOpenLeft *= blink; target.eyeOpenRight *= blink;
        target.lightIntensity += Math.sin(clock * 2.0) * 0.055;
        if (state === 'listening') target.lightIntensity += microphone * 0.15;
      } else {
        blinkTime = -1;
      }
      if (motion.reducedMotion) {
        target.gazeX = target.gazeY = 0;
      }
      if (!gestures) {
        nodProgress = -1;
        for (const key of BODY_KEYS) target[key] = 0;
      }

      for (const key of KEYS) {
        let smoothing = ambient ? approach(dt, 0.16) : 1;
        if (key === 'mouthOpen') smoothing = approach(dt, level > pose.mouthOpen ? 1 / 26 : 1 / 17);
        else if (key === 'mouthWidth' || key === 'mouthRound') smoothing = approach(dt, 0.06);
        else if ((key === 'eyeOpenLeft' || key === 'eyeOpenRight') && ambient) smoothing = approach(dt, blinkTime >= 0 ? 0.018 : 0.06);
        else if (key === 'headX' || key === 'headY' || key === 'headZ' || key === 'bodyX' || key === 'bodyY' || key === 'bodyZ') {
          smoothing = gestures ? approach(dt, 0.20) : 1;
        }
        pose[key] += (target[key] - pose[key]) * smoothing;
        if (Math.abs(pose[key]) < 0.00001 && target[key] === 0) pose[key] = 0;
      }
      return pose;
    },
  };
}
