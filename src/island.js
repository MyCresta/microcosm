// The floating chunk of forest floor: shape functions shared with the simulation,
// plus the ground, the soil cross-section, rocks, a fallen log, roots and leaf litter.
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { noise3, fbm3, mulberry32, smooth } from './noise.js';
import { patchStandard, NOISE } from './glsl.js';

export const R = 2.35;      // nominal island radius
export const DEPTH = 2.6;   // rim to lowest tip
export const RG = 2.9;      // half extent of the surface fields
const TAU = Math.PI * 2;

// ---------------------------------------------------------------- shape ----

export function outline(th) {
  const c = Math.cos(th), s = Math.sin(th);
  return R * (1 + 0.09 * noise3(c * 1.3 + 5.1, s * 1.3 - 2.7, 0.5) + 0.035 * noise3(c * 3.1, s * 3.1, 9.2));
}

export function topH(x, z) {
  const r = Math.hypot(x, z);
  const q = r / outline(Math.atan2(z, x));
  let h = 0.17 * noise3(x * 0.55 + 3.3, 0.7, z * 0.55 - 1.2) + 0.05 * noise3(x * 1.7, 4.1, z * 1.7) + 0.1 * (1 - q * q);
  const e = smooth(0.7, 1.0, q);
  return h - 0.2 * e * e;
}

function depthAt(c, s) { return DEPTH * (1 + 0.14 * noise3(c * 0.9 - 4, s * 0.9 + 2, 3.3)); }

function profile(u, c, s) {
  const f = u < 0.3
    ? 1 - 0.08 * smooth(0, 0.3, u)
    : 0.92 * Math.pow(Math.max(0, 1 - Math.pow((u - 0.3) / 0.7, 1.75)), 0.8);
  const k = (0.03 + 0.15 * smooth(0.25, 0.9, u)) * smooth(0, 0.08, u);
  const n = noise3(c * 1.7 + u * 0.4, u * 4.2, s * 1.7) + 0.5 * noise3(c * 3.9, u * 9.0, s * 3.9);
  return Math.max(0, f * (1 + k * n));
}

/** Radius of the soil body in direction th at height y. */
export function bodyRadius(th, y) {
  const c = Math.cos(th), s = Math.sin(th), o = outline(th);
  const u = (topH(o * c, o * s) - y) / depthAt(c, s);
  if (u <= 0) return o;
  if (u >= 1) return 0;
  return o * profile(u, c, s);
}

export function inside(x, y, z, m = 0.06) {
  if (y > topH(x, z) - m) return false;
  return Math.hypot(x, z) < bodyRadius(Math.atan2(z, x), y) - m;
}

// ------------------------------------------------------------- geometry ----

function buildTop(NR = 60, NT = 240) {
  const pos = [], idx = [];
  pos.push(0, topH(0, 0), 0);
  for (let i = 1; i <= NR; i++) {
    const q = Math.pow(i / NR, 0.85);
    for (let j = 0; j < NT; j++) {
      const th = (j / NT) * TAU, r = outline(th) * q;
      const x = r * Math.cos(th), z = r * Math.sin(th);
      pos.push(x, topH(x, z), z);
    }
  }
  for (let j = 0; j < NT; j++) idx.push(0, 1 + ((j + 1) % NT), 1 + j);
  for (let i = 0; i < NR - 1; i++) {
    for (let j = 0; j < NT; j++) {
      const a = 1 + i * NT + j, b = 1 + i * NT + ((j + 1) % NT), c = a + NT, d = b + NT;
      idx.push(a, d, c, a, b, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function buildWall(NU = 96, NT = 240) {
  const pos = [], dep = [], uvs = [], idx = [];
  for (let j = 0; j <= NT; j++) {
    const th = ((j % NT) / NT) * TAU, c = Math.cos(th), s = Math.sin(th);
    const o = outline(th), rimY = topH(o * c, o * s), D = depthAt(c, s);
    for (let k = 0; k <= NU; k++) {
      const u = k / NU;
      const r = k === 0 ? o : o * profile(u, c, s);
      pos.push(r * c, rimY - u * D, r * s);
      dep.push(u * D); uvs.push(j / NT, u);
    }
  }
  const W = NU + 1;
  for (let j = 0; j < NT; j++) {
    for (let k = 0; k < NU; k++) {
      const a = j * W + k, b = (j + 1) * W + k, c = a + 1, d = b + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aDepth', new THREE.Float32BufferAttribute(dep, 1));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  // weld the seam normals
  const n = g.attributes.normal;
  for (let k = 0; k <= NU; k++) {
    const a = k, b = NT * W + k;
    const x = n.getX(a) + n.getX(b), y = n.getY(a) + n.getY(b), z = n.getZ(a) + n.getZ(b);
    const l = Math.hypot(x, y, z) || 1;
    n.setXYZ(a, x / l, y / l, z / l); n.setXYZ(b, x / l, y / l, z / l);
  }
  return g;
}

function rockGeo(seed) {
  const rnd = mulberry32(seed);
  let g = new THREE.IcosahedronGeometry(1, 5);
  g.deleteAttribute('uv'); g.deleteAttribute('normal');
  g = mergeVertices(g, 1e-4);
  const planes = [];
  for (let i = 0; i < 9; i++) {
    const v = new THREE.Vector3(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
    planes.push([v, 0.55 + rnd() * 0.35]);
  }
  const p = g.attributes.position, v = new THREE.Vector3();
  const off = seed * 3.7;
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    for (const [n, d] of planes) { const e = v.dot(n) - d; if (e > 0) v.addScaledVector(n, -e * 0.92); }
    const l = 1 + 0.16 * fbm3(v.x * 1.4 + off, v.y * 1.4, v.z * 1.4, 3) + 0.03 * noise3(v.x * 7 + off, v.y * 7, v.z * 7);
    v.multiplyScalar(l);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

// ------------------------------------------------------------ materials ----

const INV = (1 / (2 * RG)).toFixed(5);

// The cross-section shading is costly (two 3D Voronoi lookups per pixel), so it is
// painted once into a texture at start-up and only sampled at run time.
const WALL_COLOR = /* glsl */ `
      vec3 q = vPos;
      float d = vDepth + 0.18*(fbm(q*1.4)-0.5)*smoothstep(0.0,0.3,vDepth);
      float grain = dnoise(q, 46.0), grain2 = dnoise(q+3.1, 105.0);
      float b1=smoothstep(0.07,0.15,d), b2=smoothstep(0.52,0.64,d), b3=smoothstep(1.0,1.08,d), b4=smoothstep(1.46,1.58,d);
      vec3 col = mix(vec3(0.028,0.020,0.015), vec3(0.090,0.054,0.032), b1);
      col = mix(col, vec3(0.215,0.120,0.062), b2);
      col = mix(col, vec3(0.300,0.220,0.155), b3);
      col = mix(col, vec3(0.165,0.175,0.20), b4);
      col *= 0.68 + 0.64*fbm(q*6.0+9.0);
      col *= 0.82 + 0.36*grain;
      float lines = sin((d + 0.02*vnoise(q*9.0))*85.0);
      col *= 1.0 - 0.14*smoothstep(0.55,1.0,lines)*b2*(1.0-b4);
      vec4 vo = voro3(q*vec3(7.0,9.0,7.0));
      float pebMask = smoothstep(0.42,0.66,d)*(1.0-b4)*step(0.5, vo.z + 0.22*b3);
      float peb = pebMask*smoothstep(0.34,0.27,vo.x);
      vec3 pebCol = mix(vec3(0.34,0.32,0.29), vec3(0.46,0.35,0.25), vo.w)*(0.55+0.7*vo.z);
      col = mix(col, pebCol, peb);
      float hgt = grain*0.25 + grain2*0.1 + peb*(1.0-vo.x/0.34)*1.3;
      vec4 vr = voro3(q*vec3(2.6,3.6,2.6)+4.0);
      float crack = smoothstep(0.07,0.0,vr.y-vr.x);
      col = mix(col, col*(0.7+0.7*vr.z), b4);
      col *= 1.0 - 0.65*crack*b4;
      hgt += b4*(vr.z*0.9 - crack*1.6);
      float rn = abs(vnoise(q*vec3(5.0,2.2,5.0)+fbm(q*2.0)*2.0)-0.5);
      float root = smoothstep(0.02,0.004,rn)*b1*(1.0-b3)*step(0.4,vnoise(q*1.7+20.0));
      col = mix(col, vec3(0.34,0.25,0.16), root*0.8); hgt += root*0.7;
      col += vec3(0.5,0.45,0.35)*step(0.968,grain2)*b2*0.45;
      col *= mix(0.45,1.0,smoothstep(0.0,0.2,vDepth));
      col *= mix(1.0,0.85,smoothstep(1.4,2.6,vDepth));
      diffuseColor.rgb = col;`;

export function bakeWall(renderer, wall) {
  const rt = new THREE.WebGLRenderTarget(4096, 1024, {
    type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter, wrapS: THREE.RepeatWrapping, depthBuffer: false,
  });
  rt.texture.anisotropy = 4;
  const mat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide, depthTest: false,
    vertexShader: 'attribute float aDepth; varying float vDepth; varying vec3 vPos; void main(){ vDepth = aDepth; vPos = position; gl_Position = vec4(uv*2.0-1.0, 0.0, 1.0); }',
    fragmentShader: `varying float vDepth; varying vec3 vPos;\n${NOISE}\nvoid main(){ vec4 diffuseColor = vec4(1.0);\n${WALL_COLOR}\ngl_FragColor = vec4(diffuseColor.rgb, clamp((hgt+2.0)/5.0, 0.0, 1.0)); }`,
  });
  const mesh = new THREE.Mesh(wall.geometry, mat); mesh.frustumCulled = false;
  const sc = new THREE.Scene(); sc.add(mesh);
  renderer.setRenderTarget(rt); renderer.render(sc, new THREE.Camera()); renderer.setRenderTarget(null);
  mat.dispose();
  return rt.texture;
}

function wallMaterial(U) {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 });
  return patchStandard(m, 'wall', {
    vertPars: 'attribute float aDepth; varying float vDepth; varying vec2 vUvW;',
    vert: 'vDepth = aDepth; vUvW = uv;',
    fragPars: 'varying float vDepth; varying vec2 vUvW; uniform sampler2D uBake;',
    color: 'vec4 bk = texture2D(uBake, vUvW); diffuseColor.rgb = bk.rgb; float hgt = bk.a*5.0-2.0; float b4 = smoothstep(1.46,1.58,vDepth);',
    rough: 'roughnessFactor = mix(0.96, 0.74, b4);',
    normal: 'normal = bumpN(normal, hgt, 0.014);',
  }, U);
}

function groundMaterial(U) {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.96, metalness: 0 });
  return patchStandard(m, 'ground', {
    fragPars: 'uniform sampler2D uVital;',
    color: /* glsl */ `
      vec3 q = vPos;
      float n1=fbm(q*3.0), n2=dnoise(q, 36.0), n3=dnoise(q, 95.0);
      vec3 soil = mix(vec3(0.045,0.030,0.020), vec3(0.125,0.080,0.046), n1);
      soil *= 0.72 + 0.56*n2;
      float fl = step(0.7, vnoise(q*23.0+7.0))*step(0.45,n3);
      soil = mix(soil, vec3(0.24,0.15,0.065), fl*0.55);
      vec4 vt = texture2D(uVital, q.xz*${INV}+0.5);
      float mAmt = smoothstep(0.08,0.5, vt.r + (n1-0.5)*0.5);
      vec3 mossU = mix(vec3(0.020,0.045,0.014), vec3(0.02,0.085,0.07), vt.g);
      float hgt = n2*0.5 + n3*0.3 + fl*0.5;
      diffuseColor.rgb = mix(soil, mossU*(0.6+0.8*n2), mAmt*0.94);`,
    normal: 'normal = bumpN(normal, hgt, 0.01);',
  }, U);
}

function rockMaterial(U) {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 });
  return patchStandard(m, 'rock', {
    fragPars: 'uniform sampler2D uVital;',
    color: /* glsl */ `
      vec3 q = vLPos*5.0 + vOrigin*3.1;
      float n = fbm(q*1.1), n2 = fbm(q*2.0+7.0);
      vec3 col = mix(vec3(0.17,0.16,0.15), vec3(0.35,0.32,0.28), n);
      col = mix(col, vec3(0.20,0.22,0.26), smoothstep(0.45,0.7,fbm(q*0.8+5.0)));
      col *= 0.82 + 0.36*n2;
      vec4 vo = voro3(q*1.5);
      float crack = (1.0 - smoothstep(0.0, 0.05, vo.y - vo.x))*step(0.6, vo.w)*smoothstep(0.35, 0.6, n2);
      col *= 1.0 - 0.3*crack;
      float lich = smoothstep(0.34,0.2,vo.x + 0.15*n2)*step(0.7,vo.z);
      col = mix(col, mix(vec3(0.50,0.52,0.36), vec3(0.62,0.53,0.28), vo.w), lich*0.7);
      vec4 vt = texture2D(uVital, vLPos.xz*${INV}+0.5);
      float mfz = 0.5*dnoise(q, 6.0) + 0.5*dnoise(q + 3.0, 15.0);
      float mossAmt = smoothstep(0.3,0.75, vWN.y*0.9 + (n2-0.5)*1.2 + vt.r*0.6 - 0.25)*step(-0.3, vLPos.y);
      vec3 mossC = mix(vec3(0.04,0.09,0.025), vec3(0.16,0.28,0.055), mfz);
      mossC = mix(mossC, vec3(0.05,0.30,0.25), vt.g*0.6);
      col = mix(col, mossC, mossAmt);
      float hgt = n*0.8 - crack*0.4 + mossAmt*0.4;
      diffuseColor.rgb = col;`,
    rough: 'roughnessFactor = mix(0.8, 1.0, mossAmt);',
    normal: 'normal = bumpN(normal, hgt, 0.012);',
  }, U);
}

function logMaterial(U) {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 });
  return patchStandard(m, 'log', {
    fragPars: 'uniform sampler2D uVital;',
    color: /* glsl */ `
      float rad = length(vPos.yz);
      vec3 bw = vPos + (vec3(fbm(vPos*3.0), fbm(vPos*3.0+4.7), fbm(vPos*3.0+9.1)) - 0.5)*0.22;
      float bark = fbm(vec3(bw.x*3.0, bw.y*11.0, bw.z*11.0));
      vec4 bv = voro3(vec3(bw.x*4.5, bw.y*9.0, bw.z*9.0));
      float furrow = 1.0 - smoothstep(0.0, 0.34, bv.y - bv.x);
      vec3 col = mix(vec3(0.075,0.05,0.035), vec3(0.25,0.175,0.11), smoothstep(0.25,0.75,bark));
      col *= 0.88 + 0.24*bv.z;
      col *= 1.0 - 0.55*furrow;
      float cap = smoothstep(0.8,0.95,abs(vWN.x));
      float rings = 0.5+0.5*sin(rad*150.0 + 4.0*vnoise(vPos*7.0));
      col = mix(col, mix(vec3(0.40,0.28,0.16), vec3(0.27,0.18,0.10), rings)*(0.4+0.6*smoothstep(0.0,0.12,rad)), cap);
      float g = 0.5*dnoise(vPos, 22.0) + 0.5*dnoise(vPos + 5.0, 55.0);
      float mossAmt = smoothstep(0.3,0.75, vWN.y + (bark-0.5)*1.5)*(1.0-cap);
      col = mix(col, mix(vec3(0.04,0.09,0.025), vec3(0.17,0.30,0.06), g), mossAmt*0.92);
      float hgt = (bark*0.7 - furrow*1.0)*(1.0-cap) + rings*cap*0.3 + mossAmt*0.4;
      diffuseColor.rgb = col;`,
    normal: 'normal = bumpN(normal, hgt, 0.012);',
  }, U);
}

// -------------------------------------------------------------- builder ----

export function buildIsland(U, rnd) {
  const group = new THREE.Group();
  const obstacles = []; // {x, z, r} discs where nothing should sprout

  const ground = new THREE.Mesh(buildTop(), groundMaterial(U));
  ground.receiveShadow = true;
  const wall = new THREE.Mesh(buildWall(), wallMaterial(U));
  wall.receiveShadow = true;
  group.add(ground, wall);
  // coarse stand-ins for mouse picking, so hovering never ray-tests the full meshes
  const pickGround = new THREE.Mesh(buildTop(14, 48)), pickWall = new THREE.Mesh(buildWall(18, 48));
  pickGround.visible = pickWall.visible = false;
  group.add(pickGround, pickWall);

  // --- rocks: three shapes, instanced everywhere ---------------------------
  const rmat = rockMaterial(U);
  const placements = [[], [], []];
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler();
  const add = (x, y, z, sx, sy, sz) => {
    E.set(rnd() * 0.6 - 0.3, rnd() * TAU, rnd() * 0.6 - 0.3);
    Q.setFromEuler(E);
    M.compose(new THREE.Vector3(x, y, z), Q, new THREE.Vector3(sx, sy, sz));
    placements[(rnd() * 3) | 0].push(M.clone());
  };
  const surfaceRocks = [[-1.05, 0.55, 0.42], [-0.62, 0.95, 0.2], [1.25, -0.75, 0.3], [0.5, 1.45, 0.17],
                        [-1.5, -0.85, 0.22], [1.55, 0.6, 0.14], [0.15, -1.6, 0.19], [-0.25, 0.3, 0.1]];
  for (const [x, z, s] of surfaceRocks) {
    add(x, topH(x, z) + s * 0.12, z, s, s * (0.55 + rnd() * 0.25), s * (0.8 + rnd() * 0.3));
    obstacles.push({ x, z, r: s * 0.95 });
  }
  for (let i = 0; i < 46; i++) { // pebbles on the surface
    const th = rnd() * TAU, r = outline(th) * Math.sqrt(rnd()) * 0.96;
    const x = r * Math.cos(th), z = r * Math.sin(th), s = 0.02 + rnd() * 0.035;
    add(x, topH(x, z) + s * 0.2, z, s, s * 0.6, s);
  }
  for (let i = 0; i < 34; i++) { // stones lodged in the cross-section
    const th = rnd() * TAU, y0 = -(0.35 + rnd() * 1.1);
    const o = outline(th), y = topH(o * Math.cos(th), o * Math.sin(th)) + y0;
    const s = 0.05 + rnd() * rnd() * 0.16, r = bodyRadius(th, y) - s * 0.35;
    add(r * Math.cos(th), y, r * Math.sin(th), s, s * (0.6 + rnd() * 0.4), s);
  }
  for (let i = 0; i < 16; i++) { // heavy rock at the base
    const th = rnd() * TAU, o = outline(th);
    const y = topH(o * Math.cos(th), o * Math.sin(th)) - (1.45 + rnd() * 0.95);
    const s = 0.16 + rnd() * 0.2, r = Math.max(0, bodyRadius(th, y) - s * 0.5);
    add(r * Math.cos(th), y, r * Math.sin(th), s, s * (0.9 + rnd() * 0.8), s);
  }
  placements.forEach((list, i) => {
    const im = new THREE.InstancedMesh(rockGeo(31 + i * 17), rmat, list.length);
    list.forEach((m, k) => im.setMatrixAt(k, m));
    im.castShadow = im.receiveShadow = true;
    im.renderOrder = 2;
    group.add(im);
  });

  // --- fallen log ---------------------------------------------------------
  const LEN = 1.35;
  const lg = new THREE.CylinderGeometry(0.15, 0.17, LEN, 32, 44, false);
  lg.rotateZ(Math.PI / 2);
  {
    const p = lg.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const a = Math.atan2(z, y), rad = Math.hypot(y, z);
      const k = rad < 1e-4 ? 1 : 1 + 0.1 * noise3(Math.cos(a) * 1.5, x * 1.3, Math.sin(a) * 1.5) + 0.035 * noise3(Math.cos(a) * 6, x * 2.5, Math.sin(a) * 6);
      p.setXYZ(i, x + 0.02 * noise3(y * 9, z * 9, x) * (Math.abs(x) > LEN * 0.49 ? 1 : 0), y * k, z * k * 0.92);
    }
    lg.computeVertexNormals();
  }
  const log = new THREE.Mesh(lg, logMaterial(U));
  const lx = 0.55, lz = 0.25, yaw = 0.7;
  log.position.set(lx, topH(lx, lz) + 0.085, lz);
  log.rotation.set(0, yaw, 0.05);
  log.castShadow = log.receiveShadow = true;
  log.renderOrder = 2;
  group.add(log);
  for (let t = -0.5; t <= 0.5; t += 0.125) {
    obstacles.push({ x: lx + Math.cos(yaw) * t * LEN, z: lz - Math.sin(yaw) * t * LEN, r: 0.18 });
  }

  // --- hanging roots ------------------------------------------------------
  const rootGeos = [];
  for (let i = 0; i < 26; i++) {
    const th = rnd() * TAU, c = Math.cos(th), s = Math.sin(th), o = outline(th);
    const y0 = topH(o * c, o * s) - (0.25 + rnd() * 1.7);
    const r0 = bodyRadius(th, y0) - 0.03;
    const len = 0.25 + rnd() * 0.75, pts = [];
    let x = r0 * c, y = y0, z = r0 * s;
    const dx = (rnd() - 0.5) * 0.25, dz = (rnd() - 0.5) * 0.25;
    for (let k = 0; k <= 5; k++) {
      const t = k / 5;
      pts.push(new THREE.Vector3(
        x + c * 0.07 * Math.sin(t * 2.2) + dx * t * t + 0.03 * noise3(i, t * 3, 0),
        y - len * t * (0.4 + 0.6 * t),
        z + s * 0.07 * Math.sin(t * 2.2) + dz * t * t + 0.03 * noise3(i, t * 3, 5)));
    }
    const TS = 18, RS = 5;
    const tg = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), TS, 0.016, RS, false);
    const p = tg.attributes.position, curve = tg.parameters.path;
    for (let a = 0; a <= TS; a++) {
      const ctr = curve.getPointAt(a / TS), k = 1 - 0.9 * (a / TS);
      for (let b = 0; b <= RS; b++) {
        const id = a * (RS + 1) + b;
        p.setXYZ(id, ctr.x + (p.getX(id) - ctr.x) * k, ctr.y + (p.getY(id) - ctr.y) * k, ctr.z + (p.getZ(id) - ctr.z) * k);
      }
    }
    rootGeos.push(tg);
  }
  const roots = new THREE.Mesh(mergeGeometries(rootGeos), new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 0.9 }));
  roots.castShadow = true; roots.renderOrder = 2;
  group.add(roots);

  // --- leaf litter --------------------------------------------------------
  const leafGeo = (() => {
    const N = 7, pos = [], idx = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N, w = 0.42 * Math.pow(Math.sin(Math.PI * t), 0.8) * (1 - 0.35 * t) + 0.012;
      const y = 0.09 * Math.sin(t * Math.PI) * 0.6;
      pos.push(-w, y + 0.05 * w, t - 0.5, 0, y - 0.03, t - 0.5, w, y + 0.05 * w, t - 0.5);
    }
    for (let i = 0; i < N; i++) {
      const a = i * 3;
      idx.push(a, a + 3, a + 1, a + 1, a + 3, a + 4, a + 1, a + 4, a + 2, a + 2, a + 4, a + 5);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx); g.computeVertexNormals();
    return g;
  })();
  const NL = 230;
  const leaves = new THREE.InstancedMesh(leafGeo, new THREE.MeshStandardMaterial({ roughness: 0.8, side: THREE.DoubleSide }), NL);
  const col = new THREE.Color();
  const palette = [0x5a3413, 0x7a4a1a, 0x8a5a20, 0x3d2610, 0x94421a, 0xa87428, 0x4f3a1c];
  for (let i = 0; i < NL; i++) {
    const th = rnd() * TAU, r = outline(th) * Math.sqrt(rnd()) * 0.97;
    const x = r * Math.cos(th), z = r * Math.sin(th), s = 0.07 + rnd() * 0.07;
    E.set((rnd() - 0.5) * 0.5, rnd() * TAU, (rnd() - 0.5) * 0.5);
    Q.setFromEuler(E);
    M.compose(new THREE.Vector3(x, topH(x, z) + 0.012 + rnd() * 0.012, z), Q, new THREE.Vector3(s, s * (0.5 + rnd()), s * (1 + rnd() * 0.5)));
    leaves.setMatrixAt(i, M);
    col.setHex(palette[(rnd() * palette.length) | 0]).multiplyScalar(0.55 + rnd() * 0.6);
    leaves.setColorAt(i, col);
  }
  leaves.castShadow = leaves.receiveShadow = true; leaves.renderOrder = 2;
  group.add(leaves);

  // --- a few twigs --------------------------------------------------------
  const twigGeos = [];
  for (let i = 0; i < 7; i++) {
    const th = rnd() * TAU, r = outline(th) * (0.25 + rnd() * 0.65);
    const x = r * Math.cos(th), z = r * Math.sin(th), a = rnd() * TAU, l = 0.2 + rnd() * 0.3;
    const pts = [];
    for (let k = 0; k <= 4; k++) {
      const t = k / 4 - 0.5, px = x + Math.cos(a) * t * l + 0.02 * noise3(i, k, 1), pz = z + Math.sin(a) * t * l + 0.02 * noise3(i, k, 7);
      pts.push(new THREE.Vector3(px, topH(px, pz) + 0.022 + 0.01 * k * (i % 2), pz));
    }
    twigGeos.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 10, 0.009 + rnd() * 0.006, 5, false));
  }
  const twigs = new THREE.Mesh(mergeGeometries(twigGeos), new THREE.MeshStandardMaterial({ color: 0x3a281a, roughness: 0.95 }));
  twigs.castShadow = twigs.receiveShadow = true; twigs.renderOrder = 2;
  group.add(twigs);

  return { group, ground, wall, pickGround, pickWall, obstacles, shellGeometry: buildTop(40, 168) };
}

export function blocked(obstacles, x, z, pad = 0) {
  for (const o of obstacles) if (Math.hypot(x - o.x, z - o.z) < o.r + pad) return true;
  return false;
}

export function randomSurfacePoint(rnd, margin = 0.96) {
  const th = rnd() * TAU, r = outline(th) * Math.sqrt(rnd()) * margin;
  return [r * Math.cos(th), r * Math.sin(th)];
}
