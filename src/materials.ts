import * as THREE from 'three';

const TEXTURE_SIZE = 512;

type FinishSample = { height: number; roughness: number; pigment?: number };
type FinishMaps = {
  bumpMap: THREE.DataTexture;
  roughnessMap: THREE.DataTexture;
  normalMap?: THREE.DataTexture;
  map?: THREE.DataTexture;
};

/** Periodic lattice noise keeps every generated finish seamless when repeated. */
function noise(u: number, v: number, cellsX: number, cellsY: number, seed: number): number {
  const x = u * cellsX;
  const y = v * cellsY;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const hash = (px: number, py: number) => {
    let value = Math.imul(px % cellsX, 374761393) ^ Math.imul(py % cellsY, 668265263) ^ seed;
    value = Math.imul(value ^ (value >>> 13), 1274126177);
    return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
  };
  const top = THREE.MathUtils.lerp(hash(ix, iy), hash(ix + 1, iy), sx);
  const bottom = THREE.MathUtils.lerp(hash(ix, iy + 1), hash(ix + 1, iy + 1), sx);
  return THREE.MathUtils.lerp(top, bottom, sy);
}

/**
 * Real surface finishes generated once when the avatar is mounted. Bump and
 * roughness contain linear data only; color stays in the calibrated materials.
 * No image downloads, canvas dependency, or per-frame texture generation.
 */
export function createMiloMaterials(renderer: THREE.WebGLRenderer) {
  const textures = new Set<THREE.Texture>();
  const maxAnisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  function texture(name: string, data: Uint8Array, repeat: number) {
    const result = new THREE.DataTexture(data, TEXTURE_SIZE, TEXTURE_SIZE, THREE.RGBAFormat);
    result.name = name;
    result.colorSpace = THREE.NoColorSpace;
    result.wrapS = result.wrapT = THREE.RepeatWrapping;
    result.repeat.set(repeat, repeat);
    result.magFilter = THREE.LinearFilter;
    result.minFilter = THREE.LinearMipmapLinearFilter;
    result.generateMipmaps = true;
    result.anisotropy = maxAnisotropy;
    result.needsUpdate = true;
    textures.add(result);
    return result;
  }

  function finish(name: string, repeat: number, sample: (u: number, v: number) => FinishSample,
    normalStrength = 0): FinishMaps {
    const height = new Uint8Array(TEXTURE_SIZE * TEXTURE_SIZE * 4);
    const roughness = new Uint8Array(height.length);
    const pigment = normalStrength ? new Uint8Array(height.length) : undefined;
    for (let y = 0; y < TEXTURE_SIZE; y++) {
      for (let x = 0; x < TEXTURE_SIZE; x++) {
        const value = sample(x / TEXTURE_SIZE, y / TEXTURE_SIZE);
        const offset = (y * TEXTURE_SIZE + x) * 4;
        const h = Math.round(THREE.MathUtils.clamp(value.height, 0, 1) * 255);
        const r = Math.round(THREE.MathUtils.clamp(value.roughness, 0, 1) * 255);
        height[offset] = height[offset + 1] = height[offset + 2] = h;
        roughness[offset] = roughness[offset + 1] = roughness[offset + 2] = r;
        height[offset + 3] = roughness[offset + 3] = 255;
        if (pigment) {
          const p = Math.round(THREE.MathUtils.clamp(value.pigment ?? 1, 0, 1) * 255);
          pigment[offset] = pigment[offset + 1] = pigment[offset + 2] = p;
          pigment[offset + 3] = 255;
        }
      }
    }
    const maps: FinishMaps = {
      bumpMap: texture(`${name} / microrelief`, height, repeat),
      roughnessMap: texture(`${name} / roughness`, roughness, repeat),
    };
    if (normalStrength && pigment) {
      // Authored tangent-space normals survive minification more reliably than
      // screen-space bump derivatives. Central differences also wrap seamlessly.
      const normals = new Uint8Array(height.length);
      const h = (x: number, y: number) => height[((y + TEXTURE_SIZE) % TEXTURE_SIZE * TEXTURE_SIZE
        + (x + TEXTURE_SIZE) % TEXTURE_SIZE) * 4] / 255;
      for (let y = 0; y < TEXTURE_SIZE; y++) {
        for (let x = 0; x < TEXTURE_SIZE; x++) {
          const nx = (h(x - 1, y) - h(x + 1, y)) * normalStrength;
          const ny = (h(x, y - 1) - h(x, y + 1)) * normalStrength;
          const length = Math.sqrt(nx * nx + ny * ny + 1);
          const offset = (y * TEXTURE_SIZE + x) * 4;
          normals[offset] = Math.round((nx / length * 0.5 + 0.5) * 255);
          normals[offset + 1] = Math.round((ny / length * 0.5 + 0.5) * 255);
          normals[offset + 2] = Math.round((1 / length * 0.5 + 0.5) * 255);
          normals[offset + 3] = 255;
        }
      }
      maps.normalMap = texture(`${name} / surface normal`, normals, repeat);
      maps.map = texture(`${name} / subtle pigment`, pigment, repeat);
      maps.map.colorSpace = THREE.SRGBColorSpace;
    }
    return maps;
  }

  const enamel = finish('Ivory ceramic enamel', 2, (u, v) => {
    const grain = noise(u, v, 32, 32, 173);
    const fine = noise(u, v, 94, 94, 659);
    const glaze = noise(u, v, 18, 18, 211);
    return {
      height: 0.34 + grain * 0.29 + fine * 0.16 + glaze * 0.09,
      roughness: 0.69 + grain * 0.20 + glaze * 0.09,
      pigment: 0.977 + grain * 0.016 + fine * 0.007,
    };
  }, 5);
  const powder = finish('Terracotta powder coat', 2, (u, v) => {
    const peel = noise(u, v, 30, 30, 857);
    const grain = noise(u, v, 64, 64, 1297);
    const fine = noise(u, v, 144, 144, 523);
    return {
      height: 0.19 + peel * 0.40 + grain * 0.24 + fine * 0.13,
      roughness: 0.63 + peel * 0.21 + grain * 0.14,
      pigment: 0.97 + peel * 0.018 + grain * 0.012,
    };
  }, 9);
  const elastomer = finish('Dense molded elastomer', 3, (u, v) => {
    const grain = noise(u, v, 110, 110, 1907);
    const small = noise(u, v, 225, 225, 317);
    const pores = Math.pow(1 - grain, 3);
    return {
      height: 0.35 + grain * 0.25 + small * 0.21 - pores * 0.16,
      roughness: 0.86 + grain * 0.08 + small * 0.05,
    };
  });
  const brushed = finish('Fine brushed titanium', 2, (u, v) => {
    // Long, fine scratches follow V; crossed low-amplitude grain avoids stripes.
    const brush = noise(u, v, 245, 5, 3079);
    const fine = noise(u, v, 440, 11, 811);
    const grain = noise(u, v, 48, 48, 131);
    return {
      height: 0.30 + brush * 0.27 + fine * 0.10 + grain * 0.06,
      roughness: 0.68 + brush * 0.23 + fine * 0.05,
    };
  });
  const floor = finish('Matte studio floor', 90, (u, v) => {
    const grain = noise(u, v, 70, 70, 1699);
    const small = noise(u, v, 180, 180, 733);
    return { height: 0.35 + grain * 0.18 + small * 0.12, roughness: 0.90 + grain * 0.09 };
  });

  const cream = new THREE.MeshPhysicalMaterial({
    name: 'Warm ivory / ceramic enamel',
    color: '#e7ddc9',
    metalness: 0,
    roughness: 0.48,
    clearcoat: 0.52,
    clearcoatRoughness: 0.32,
    clearcoatRoughnessMap: enamel.roughnessMap,
    clearcoatNormalMap: enamel.normalMap,
    clearcoatNormalScale: new THREE.Vector2(0.24, 0.24),
    normalScale: new THREE.Vector2(0.48, 0.48),
    ior: 1.48,
    bumpScale: 0.0045,
    envMapIntensity: 0.85,
    ...enamel,
  });
  const orange = new THREE.MeshPhysicalMaterial({
    name: 'Terracotta / powder-coated alloy',
    color: '#c56743',
    metalness: 0.015,
    roughness: 0.78,
    clearcoat: 0.12,
    clearcoatRoughness: 0.44,
    normalScale: new THREE.Vector2(0.38, 0.38),
    bumpScale: 0.010,
    envMapIntensity: 0.75,
    ...powder,
  });
  const orangeDark = new THREE.MeshStandardMaterial({
    name: 'Deep clay / recessed powder coat',
    color: '#87412c',
    metalness: 0.025,
    roughness: 0.86,
    normalScale: new THREE.Vector2(0.38, 0.38),
    bumpScale: 0.009,
    ...powder,
  });
  const rubber = new THREE.MeshStandardMaterial({
    name: 'Charcoal teal / molded rubber',
    color: '#263b38',
    metalness: 0,
    roughness: 0.93,
    bumpScale: 0.010,
    envMapIntensity: 0.35,
    ...elastomer,
  });
  const screenMaterial = new THREE.MeshPhysicalMaterial({
    name: 'Smoked teal / polished face lens',
    color: '#123238',
    metalness: 0.06,
    roughness: 0.24,
    clearcoat: 1,
    clearcoatRoughness: 0.12,
    ior: 1.48,
    envMapIntensity: 0.68,
    // Opaque smoked lens keeps the physical face and the animated LEDs crisp.
    transmission: 0,
  });
  const rimMaterial = new THREE.MeshPhysicalMaterial({
    name: 'Dark titanium / brushed bezel',
    color: '#536663',
    metalness: 0.88,
    roughness: 0.47,
    anisotropy: 0.42,
    anisotropyRotation: Math.PI / 2,
    bumpScale: 0.004,
    envMapIntensity: 1.0,
    ...brushed,
  });
  const metal = new THREE.MeshPhysicalMaterial({
    name: 'Titanium / exposed hardware',
    color: '#a6afaa',
    metalness: 0.93,
    roughness: 0.43,
    anisotropy: 0.46,
    anisotropyRotation: Math.PI / 2,
    bumpScale: 0.004,
    envMapIntensity: 1.0,
    ...brushed,
  });
  const fastener = new THREE.MeshStandardMaterial({
    name: 'Graphite steel / fasteners',
    color: '#4b5550',
    metalness: 0.92,
    roughness: 0.42,
    bumpScale: 0.003,
    ...brushed,
  });
  const eyeMaterial = new THREE.MeshPhysicalMaterial({
    name: 'Mint LED / frosted diffuser',
    color: '#c2f2d5',
    emissive: '#8adbb8',
    emissiveIntensity: 1.0,
    metalness: 0,
    roughness: 0.34,
    clearcoat: 0.3,
    clearcoatRoughness: 0.25,
  });
  const cheekMaterial = new THREE.MeshStandardMaterial({
    name: 'Apricot LED / frosted diffuser',
    color: '#ed9872',
    emissive: '#d57245',
    emissiveIntensity: 0.46,
    roughness: 0.42,
  });
  const interiorMaterial = new THREE.MeshStandardMaterial({
    name: 'Mouth / dark inset',
    color: '#0a1b1e',
    roughness: 1,
    envMapIntensity: 0.1,
  });
  const lightMaterial = new THREE.MeshPhysicalMaterial({
    name: 'Amber status LED / rounded lens',
    color: '#ffedb9',
    emissive: '#ffc16d',
    emissiveIntensity: 1.05,
    roughness: 0.24,
    clearcoat: 0.7,
    clearcoatRoughness: 0.17,
  });
  const groundMaterial = new THREE.MeshStandardMaterial({
    name: 'Warm sage / matte studio floor',
    color: '#e4e8df',
    roughness: 1,
    bumpScale: 0.004,
    envMapIntensity: 0.25,
    ...floor,
  });
  const materials = [cream, orange, orangeDark, rubber, screenMaterial, rimMaterial, metal,
    fastener, eyeMaterial, cheekMaterial, interiorMaterial, lightMaterial, groundMaterial];
  let disposed = false;

  return {
    cream, orange, orangeDark, rubber, screenMaterial, rimMaterial, metal, fastener,
    eyeMaterial, cheekMaterial, interiorMaterial, lightMaterial, groundMaterial,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const material of materials) material.dispose();
      for (const map of textures) map.dispose();
      textures.clear();
    },
  };
}
