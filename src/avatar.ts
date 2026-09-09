import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createMiloMaterials } from './materials';
import { createTalkingMotion } from './talking-motion';
import { createAvatarExpression, type AvatarPresence } from './avatar-expression';

export type { AvatarPresence } from './avatar-expression';

export type AvatarAudio = { level: number; bands: number[]; speaking: boolean };

/** A completely procedural character. The mouth is driven only by real audio. */
export function createAvatar(container: HTMLElement, getAudio: () => AvatarAudio, getPresence?: () => AvatarPresence) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#e8ece3');
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.94;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.domElement.setAttribute('aria-label', 'Milo, an animated cream and orange robot. Drag to turn and scroll to zoom.');
  renderer.domElement.setAttribute('role', 'img');
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.touchAction = 'pan-y';
  container.appendChild(renderer.domElement);

  // A locally generated studio provides real reflections across rough and
  // polished finishes, with no HDR download or external asset dependency.
  const studio = new RoomEnvironment();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(studio, 0.04);
  scene.environment = environment.texture;
  scene.environmentIntensity = 0.78;
  scene.environmentRotation.y = 0.45;
  studio.dispose();
  pmrem.dispose();

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.075;
  controls.enablePan = false;
  controls.minDistance = 4.5;
  controls.maxDistance = 11;
  controls.minPolarAngle = Math.PI * 0.28;
  controls.maxPolarAngle = Math.PI * 0.52;
  controls.minAzimuthAngle = -Math.PI * 0.52;
  controls.maxAzimuthAngle = Math.PI * 0.52;
  controls.target.set(0, 1.63, 0);
  camera.position.set(2.6, 2.45, 7.6);
  controls.update();
  controls.saveState();

  const finishes = createMiloMaterials(renderer);
  const { cream, orange, orangeDark, rubber, screenMaterial, rimMaterial,
    metal, fastener, eyeMaterial, cheekMaterial, interiorMaterial, lightMaterial, groundMaterial } = finishes;
  const materials: THREE.Material[] = [];
  const detailTextures: THREE.Texture[] = [];
  const geometries = new Set<THREE.BufferGeometry>();

  function mesh(geometry: THREE.BufferGeometry, material: THREE.Material, parent: THREE.Object3D,
    x = 0, y = 0, z = 0, shadow = true) {
    geometries.add(geometry);
    const result = new THREE.Mesh(geometry, material);
    result.position.set(x, y, z);
    result.castShadow = shadow;
    result.receiveShadow = shadow;
    parent.add(result);
    return result;
  }
  function box(w: number, h: number, d: number, radius: number, material: THREE.Material,
    parent: THREE.Object3D, x = 0, y = 0, z = 0, shadow = true) {
    // Round the face in XY before flattening; shallow geometry otherwise clamps
    // the corner radius to half its depth and turns the eyes into rectangles.
    const roundedDepth = Math.max(d, radius * 2);
    const result = mesh(new RoundedBoxGeometry(w, h, roundedDepth, 5, radius), material, parent, x, y, z, shadow);
    result.scale.z = d / roundedDepth;
    return result;
  }
  function sphere(radius: number, material: THREE.Material, parent: THREE.Object3D,
    x = 0, y = 0, z = 0) {
    return mesh(new THREE.SphereGeometry(radius, 28, 20), material, parent, x, y, z);
  }
  function cylinder(radius: number, length: number, material: THREE.Material, parent: THREE.Object3D,
    x = 0, y = 0, z = 0) {
    return mesh(new THREE.CylinderGeometry(radius, radius, length, 40), material, parent, x, y, z);
  }

  function ring(radius: number, thickness: number, material: THREE.Material,
    parent: THREE.Object3D, x: number, y: number, z: number, axis: 'x' | 'y' | 'z' = 'y') {
    const result = mesh(new THREE.TorusGeometry(radius, thickness, 8, 40), material, parent, x, y, z);
    if (axis === 'y') result.rotation.x = Math.PI / 2;
    if (axis === 'x') result.rotation.y = Math.PI / 2;
    return result;
  }

  function frontScrew(parent: THREE.Object3D, x: number, y: number, z: number, radius = 0.022) {
    const screw = cylinder(radius, 0.012, fastener, parent, x, y, z);
    screw.rotation.x = Math.PI / 2;
    const socket = mesh(new THREE.CylinderGeometry(radius * 0.40, radius * 0.40, 0.004, 6), rubber, parent, x, y, z + 0.007, false);
    socket.rotation.x = Math.PI / 2;
  }

  function panelSeam(parent: THREE.Object3D, width: number, height: number, radius: number,
    x: number, y: number, z: number, material: THREE.Material) {
    const shape = new THREE.Shape();
    const w = width / 2, h = height / 2;
    shape.moveTo(w - radius, h);
    shape.lineTo(-w + radius, h);
    shape.absarc(-w + radius, h - radius, radius, Math.PI / 2, Math.PI, false);
    shape.lineTo(-w, -h + radius);
    shape.absarc(-w + radius, -h + radius, radius, Math.PI, Math.PI * 1.5, false);
    shape.lineTo(w - radius, -h);
    shape.absarc(w - radius, -h + radius, radius, Math.PI * 1.5, Math.PI * 2, false);
    shape.lineTo(w, h - radius);
    shape.absarc(w - radius, h - radius, radius, 0, Math.PI / 2, false);
    const points = shape.getPoints(20).slice(0, -1).map(point => new THREE.Vector3(point.x, point.y, 0));
    const curve = new THREE.CatmullRomCurve3(points, true, 'centripetal');
    return mesh(new THREE.TubeGeometry(curve, 160, 0.0055, 6, true), material, parent, x, y, z, false);
  }

  scene.add(new THREE.HemisphereLight('#fff8ed', '#829287', 0.75));
  const key = new THREE.DirectionalLight('#fff1df', 2.65);
  key.position.set(-3.5, 6.5, 5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -4;
  key.shadow.camera.right = 4;
  key.shadow.camera.top = 5;
  key.shadow.camera.bottom = -4;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 18;
  key.shadow.bias = -0.0003;
  key.shadow.normalBias = 0.03;
  key.shadow.radius = 5;
  scene.add(key);
  const fill = new THREE.DirectionalLight('#dcecf2', 0.8);
  fill.position.set(4, 3, -2);
  scene.add(fill);
  const rimLight = new THREE.DirectionalLight('#fff7e9', 1.6);
  rimLight.position.set(-2, 4, -4);
  scene.add(rimLight);

  // A compact, fog-blended floor avoids the old hard line across the preview.
  scene.fog = new THREE.Fog('#e8ece3', 10, 25);
  const ground = mesh(new THREE.PlaneGeometry(80, 80), groundMaterial, scene, 0, -0.027, 0, false);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;

  // A soft contact shadow grounds the feet without any downloaded textures.
  const shadowCanvas = document.createElement('canvas');
  shadowCanvas.width = 128;
  shadowCanvas.height = 128;
  const shadowContext = shadowCanvas.getContext('2d');
  if (shadowContext) {
    const gradient = shadowContext.createRadialGradient(64, 64, 4, 64, 64, 64);
    gradient.addColorStop(0, 'rgba(42,68,51,0.30)');
    gradient.addColorStop(0.48, 'rgba(42,68,51,0.15)');
    gradient.addColorStop(1, 'rgba(42,68,51,0)');
    shadowContext.fillStyle = gradient;
    shadowContext.fillRect(0, 0, 128, 128);
  }
  const contactTexture = new THREE.CanvasTexture(shadowCanvas);
  const contactMaterial = new THREE.MeshBasicMaterial({ map: contactTexture, transparent: true, depthWrite: false });
  materials.push(contactMaterial);
  const contact = mesh(new THREE.PlaneGeometry(3.2, 2.5), contactMaterial, scene, 0, -0.016, 0.02, false);
  contact.rotation.x = -Math.PI / 2;

  const character = new THREE.Group();
  scene.add(character);
  // Rotate about the hips, keeping both feet planted on the studio floor.
  const bodyPivot = new THREE.Group();
  bodyPivot.position.y = 0.78;
  character.add(bodyPivot);
  const upperBody = new THREE.Group();
  upperBody.position.y = -0.78;
  bodyPivot.add(upperBody);

  // Feet remain planted while the shoulders and head breathe.
  for (const side of [-1, 1]) {
    const x = side * 0.30;
    cylinder(0.125, 0.28, rubber, character, x, 0.65, 0);
    box(0.33, 0.40, 0.36, 0.115, orange, character, x, 0.42, 0);
    box(0.43, 0.12, 0.60, 0.052, rubber, character, x, 0.065, 0.105);
    box(0.47, 0.25, 0.64, 0.10, cream, character, x, 0.20, 0.105);
    box(0.25, 0.055, 0.012, 0.018, orange, character, x, 0.218, 0.429, false);
    for (let rib = 0; rib < 5; rib++) ring(0.128, 0.009, rubber, character, x, 0.573 + rib * 0.035, 0);
    for (let tread = 0; tread < 5; tread++) {
      box(0.045, 0.036, 0.014, 0.004, orangeDark, character, x - 0.136 + tread * 0.068, 0.068, 0.409, false);
    }
    ring(0.128, 0.014, metal, character, x, 0.605, 0);
  }

  box(1.09, 0.89, 0.76, 0.20, orange, upperBody, 0, 1.19, 0);
  panelSeam(upperBody, 1.095, 0.895, 0.20, 0, 1.19, -0.10, orangeDark);
  box(0.933, 0.644, 0.133, 0.164, rubber, upperBody, 0, 1.24, 0.378);
  box(0.91, 0.62, 0.13, 0.16, cream, upperBody, 0, 1.24, 0.390);
  for (const x of [-0.315, 0.315]) for (const y of [1.05, 1.43]) frontScrew(upperBody, x, y, 0.459, 0.019);
  for (let vent = 0; vent < 3; vent++) box(0.27, 0.017, 0.012, 0.008, rubber, upperBody, 0, 1.41 - vent * 0.038, 0.459, false);
  const chestLight = sphere(0.04, lightMaterial, upperBody, 0, 1.118, 0.466);
  chestLight.scale.z = 0.28;
  ring(0.047, 0.010, metal, upperBody, 0, 1.118, 0.460, 'z');
  // Printed identification is a local canvas decal, kept small like real hardware.
  const labelCanvas = document.createElement('canvas');
  labelCanvas.width = 512; labelCanvas.height = 128;
  const labelContext = labelCanvas.getContext('2d');
  if (labelContext) {
    labelContext.fillStyle = '#616c62';
    labelContext.font = '500 39px monospace';
    labelContext.textAlign = 'center';
    labelContext.fillText('M I L O', 256, 46);
    labelContext.font = '24px monospace';
    labelContext.fillStyle = '#899084';
    labelContext.fillText('COMPANION / 001', 256, 91);
  }
  const labelTexture = new THREE.CanvasTexture(labelCanvas);
  labelTexture.colorSpace = THREE.SRGBColorSpace;
  labelTexture.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
  detailTextures.push(labelTexture);
  const labelMaterial = new THREE.MeshStandardMaterial({ map: labelTexture, transparent: true, roughness: 0.73, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 });
  materials.push(labelMaterial);
  mesh(new THREE.PlaneGeometry(0.33, 0.083), labelMaterial, upperBody, 0, 1.232, 0.462, false);

  box(0.72, 0.52, 0.085, 0.10, rimMaterial, upperBody, 0, 1.20, -0.365);
  for (let vent = 0; vent < 5; vent++) box(0.47, 0.021, 0.008, 0.007, rubber, upperBody, 0, 1.33 - vent * 0.061, -0.411, false);
  box(0.72, 0.105, 0.58, 0.04, rubber, upperBody, 0, 0.771, -0.005);
  cylinder(0.18, 0.27, rubber, upperBody, 0, 1.74, 0);
  for (let rib = 0; rib < 5; rib++) ring(0.183, 0.014, rubber, upperBody, 0, 1.64 + rib * 0.045, 0);
  ring(0.186, 0.018, metal, upperBody, 0, 1.638, 0);

  const arms: THREE.Group[] = [];
  const elbows: THREE.Group[] = [];
  const wrists: THREE.Group[] = [];
  for (const side of [-1, 1]) {
    const arm = new THREE.Group();
    arm.position.set(side * 0.63, 1.48, 0);
    arm.rotation.z = side * 0.13;
    upperBody.add(arm);
    arms.push(arm);
    sphere(0.184, cream, arm);
    const shoulderPivot = cylinder(0.09, 0.018, metal, arm, side * 0.16, 0, 0);
    shoulderPivot.rotation.z = Math.PI / 2;
    mesh(new THREE.CapsuleGeometry(0.142, 0.07, 8, 24), orange, arm, side * 0.035, -0.185, 0);

    const elbow = new THREE.Group();
    elbow.position.set(side * 0.055, -0.345, 0);
    arm.add(elbow);
    elbows.push(elbow);
    sphere(0.119, rubber, elbow);
    const elbowAxle = cylinder(0.075, 0.248, metal, elbow);
    elbowAxle.rotation.z = Math.PI / 2;
    mesh(new THREE.CapsuleGeometry(0.128, 0.05, 8, 24), orange, elbow, 0, -0.105, 0);

    const wrist = new THREE.Group();
    wrist.position.set(0, -0.215, 0);
    elbow.add(wrist);
    wrists.push(wrist);
    cylinder(0.11, 0.09, rubber, wrist, 0, -0.010, 0);
    for (let rib = 0; rib < 3; rib++) ring(0.111, 0.008, rubber, wrist, 0, 0.02 - rib * 0.027, 0);
    ring(0.113, 0.012, metal, wrist, 0, -0.049, 0);
    box(0.295, 0.30, 0.31, 0.13, cream, wrist, 0, -0.083, 0.025);
    sphere(0.075, cream, wrist, -side * 0.155, -0.028, 0.10);
    box(0.022, 0.12, 0.009, 0.008, rimMaterial, wrist, 0, -0.148, 0.183, false);
  }

  const head = new THREE.Group();
  head.position.set(0, 2.335, 0);
  upperBody.add(head);
  box(1.76, 1.36, 1.19, 0.32, cream, head);
  panelSeam(head, 1.763, 1.363, 0.32, 0, 0, -0.255, rubber);
  box(1.605, 1.116, 0.152, 0.25, rubber, head, 0, 0.008, 0.565);
  box(1.57, 1.085, 0.16, 0.24, rimMaterial, head, 0, 0.008, 0.575);
  box(1.49, 1.01, 0.14, 0.225, screenMaterial, head, 0, 0.013, 0.646);
  for (const side of [-1, 1]) {
    const ear = cylinder(0.22, 0.115, orange, head, side * 0.882, -0.015, -0.05);
    ear.rotation.z = Math.PI / 2;
    ring(0.182, 0.012, metal, head, side * 0.945, -0.015, -0.05, 'x');
    const earInset = cylinder(0.125, 0.128, metal, head, side * 0.893, -0.015, -0.05);
    earInset.rotation.z = Math.PI / 2;
    for (let hole = 0; hole < 7; hole++) {
      const angle = hole * Math.PI * 2 / 7;
      const port = cylinder(0.012, 0.007, rubber, head, side * 0.961, -0.015 + Math.sin(angle) * 0.074, -0.05 + Math.cos(angle) * 0.074);
      port.rotation.z = Math.PI / 2;
    }
  }

  const eyes: THREE.Group[] = [];
  const eyebrows: THREE.Mesh[] = [];
  for (const side of [-1, 1]) {
    const eye = new THREE.Group();
    eye.position.set(side * 0.319, 0.096, 0.724);
    head.add(eye);
    box(0.152, 0.239, 0.027, 0.073, eyeMaterial, eye, 0, 0, 0, false);
    eyes.push(eye);
    const brow = box(0.186, 0.027, 0.018, 0.012, eyeMaterial, head, side * 0.319, 0.309, 0.724, false);
    brow.rotation.z = -side * 0.13;
    eyebrows.push(brow);
    box(0.125, 0.032, 0.02, 0.015, cheekMaterial, head, side * 0.52, -0.116, 0.719, false);
  }
  const mouth = new THREE.Group();
  mouth.position.set(0, -0.215, 0.728);
  head.add(mouth);
  box(0.377, 0.195, 0.026, 0.09, eyeMaterial, mouth, 0, 0, 0, false);
  const mouthInset = box(0.297, 0.130, 0.028, 0.058, interiorMaterial, mouth, 0, 0.004, 0.022, false);
  mouth.scale.y = 0.14;
  // Prebuilt morph targets bend the closed LED smile while preserving its tube
  // thickness, so neutral mouths remain legible at the mobile viewing distance.
  const smileCurve = new THREE.QuadraticBezierCurve3(
    new THREE.Vector3(-0.190, 0.010, 0),
    new THREE.Vector3(0, -0.145, 0),
    new THREE.Vector3(0.190, 0.010, 0),
  );
  const smileGeometry = new THREE.TubeGeometry(new THREE.LineCurve3(
    new THREE.Vector3(-0.190, 0, 0), new THREE.Vector3(0.190, 0, 0),
  ), 40, 0.013, 8, false);
  const curvedSmileGeometry = new THREE.TubeGeometry(smileCurve, 40, 0.013, 8, false);
  geometries.add(curvedSmileGeometry);
  smileGeometry.morphAttributes.position = [curvedSmileGeometry.attributes.position];
  smileGeometry.morphAttributes.normal = [curvedSmileGeometry.attributes.normal];
  const smileLine = mesh(smileGeometry, eyeMaterial, head, 0, -0.203, 0.746, false);

  // An offset antenna gives the silhouette a little asymmetry.
  cylinder(0.065, 0.072, orangeDark, head, 0.46, 0.681, -0.02);
  cylinder(0.031, 0.225, metal, head, 0.46, 0.809, -0.02);
  ring(0.053, 0.011, fastener, head, 0.46, 0.709, -0.02);
  sphere(0.099, orange, head, 0.46, 0.941, -0.02);
  sphere(0.035, lightMaterial, head, 0.46, 0.963, 0.064);

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let motionEnabled = !reducedMotion.matches;
  let gesturesEnabled = !reducedMotion.matches;
  const talkingMotion = createTalkingMotion();
  const expressionRig = createAvatarExpression();
  const defaultPresence: AvatarPresence = { state: 'idle', inputLevel: 0, expression: 'neutral' };
  const expressionMotion = { idle: motionEnabled, gestures: gesturesEnabled, reducedMotion: reducedMotion.matches };
  const presenceDescriptions: Record<AvatarPresence['state'], string> = {
    idle: 'ready to talk', listening: 'listening attentively', transcribing: 'considering your words',
    thinking: 'thinking', voicing: 'preparing to speak', speaking: 'speaking', error: 'waiting to try again',
  };
  let lastPresenceLabel = '';
  let disposed = false;
  let animationFrame = 0;
  let lastTimestamp = 0;

  function resize() {
    const width = Math.max(container.clientWidth, 1);
    const height = Math.max(container.clientHeight, 1);
    camera.aspect = width / height;
    // Keep the entire silhouette visible in tall/narrow mobile cards too.
    camera.fov = camera.aspect < 0.8 ? 38 : 32;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  }
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);
  resize();

  function animate(timestamp: number) {
    if (disposed) return;
    animationFrame = requestAnimationFrame(animate);
    const dt = Math.min((timestamp - lastTimestamp) / 1000 || 0.016, 0.05);
    lastTimestamp = timestamp;
    const t = timestamp / 1000;
    const audio = getAudio();
    const presence = getPresence?.() ?? defaultPresence;
    expressionMotion.idle = motionEnabled;
    expressionMotion.gestures = gesturesEnabled;
    expressionMotion.reducedMotion = reducedMotion.matches;
    const face = expressionRig.update(dt, audio, presence, expressionMotion);
    const pose = talkingMotion.update(dt, audio, gesturesEnabled && !reducedMotion.matches);
    const gestureScale = face.gestureScale;
    const presenceLabel = `${audio.speaking ? 'speaking' : presence.state}:${presence.expression}`;
    if (presenceLabel !== lastPresenceLabel) {
      lastPresenceLabel = presenceLabel;
      renderer.domElement.setAttribute('aria-label', `Milo, a cream and orange robot, ${presenceDescriptions[audio.speaking ? 'speaking' : presence.state]} with a ${presence.expression} expression. Drag to turn and scroll to zoom.`);
    }
    mouth.scale.y = 0.14 + face.mouthOpen * (1.32 + face.mouthRound * 0.16);
    mouth.scale.x = face.mouthWidth;
    mouth.visible = face.mouthOpen > 0.035;
    smileLine.visible = !mouth.visible;
    smileLine.scale.x = 0.96 + face.smile * 0.10;
    if (smileLine.morphTargetInfluences) smileLine.morphTargetInfluences[0] = face.smile;
    // Collapse the dark inset in silence to leave a clean, closed LED line.
    // A subpixel hollow ring shimmered at the normal viewing distance.
    mouthInset.visible = face.mouthOpen > 0.025;
    mouthInset.scale.y = THREE.MathUtils.smoothstep(face.mouthOpen, 0.025, 0.22);

    const idle = motionEnabled && !reducedMotion.matches ? 1 : 0;
    bodyPivot.position.y = 0.78 + Math.sin(t * 1.65) * 0.010 * idle + pose.bodyLift;
    bodyPivot.rotation.set(pose.bodyX * gestureScale + face.bodyX, pose.bodyY * gestureScale + face.bodyY, pose.bodyZ * gestureScale + face.bodyZ);
    head.rotation.set(
      Math.sin(t * 0.88) * 0.012 * idle + pose.headX * gestureScale + face.headX,
      Math.sin(t * 0.46) * 0.040 * idle + pose.headY * gestureScale + face.headY,
      Math.sin(t * 0.68) * 0.025 * idle + pose.headZ * gestureScale + face.headZ,
    );
    arms[0].rotation.set(pose.leftShoulderX * gestureScale, 0, -0.13 - Math.sin(t * 1.3) * 0.012 * idle + pose.leftShoulderZ * gestureScale);
    arms[1].rotation.set(pose.rightShoulderX * gestureScale, 0, 0.13 + Math.sin(t * 1.3 + 0.7) * 0.012 * idle + pose.rightShoulderZ * gestureScale);
    elbows[0].rotation.x = pose.leftElbow * gestureScale;
    elbows[1].rotation.x = pose.rightElbow * gestureScale;
    wrists[0].rotation.set(pose.leftWristX * gestureScale, 0, pose.leftWristZ * gestureScale);
    wrists[1].rotation.set(pose.rightWristX * gestureScale, 0, pose.rightWristZ * gestureScale);
    eyes[0].position.set(-0.319 + face.gazeX, 0.096 + face.gazeY, 0.724);
    eyes[1].position.set(0.319 + face.gazeX, 0.096 + face.gazeY, 0.724);
    eyes[0].scale.set(face.eyeWidth, face.eyeOpenLeft, 1);
    eyes[1].scale.set(face.eyeWidth, face.eyeOpenRight, 1);
    eyebrows[0].position.y = 0.309 + face.browLeftY;
    eyebrows[1].position.y = 0.309 + face.browRightY;
    eyebrows[0].rotation.z = face.browLeftZ;
    eyebrows[1].rotation.z = face.browRightZ;
    cheekMaterial.emissiveIntensity = face.cheekGlow;
    lightMaterial.color.setRGB(face.lightR, face.lightG, face.lightB);
    lightMaterial.emissive.setRGB(face.lightR, face.lightG, face.lightB);
    lightMaterial.emissiveIntensity = face.lightIntensity;
    controls.update();
    renderer.render(scene, camera);
  }
  animationFrame = requestAnimationFrame(animate);

  return {
    reset() { controls.reset(); },
    setMotion(enabled: boolean) { motionEnabled = enabled; },
    setGestures(enabled: boolean) { gesturesEnabled = enabled; },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      controls.dispose();
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      for (const texture of detailTextures) texture.dispose();
      finishes.dispose();
      scene.environment = null;
      environment.dispose();
      contactTexture.dispose();
      key.shadow.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
