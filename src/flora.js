// Everything that grows, and the surface "vitality" fields that drive it. The
// snail's trail and the food it eats leave fertile patches. Moss height reads the field directly; ferns,
// pennywort, lantern stalks and mushrooms sprout where it is high enough.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { noise3, smooth, clamp } from './noise.js';
import { patchStandard, patchDepth, NOISE } from './glsl.js';
import { RG, topH, outline, blocked, randomSurfacePoint } from './island.js';

const TAU = Math.PI * 2;
const G = 64;
const INV = (1 / (2 * RG)).toFixed(5);
const MOSS_H = 0.07;

/** Static moss fields (patchiness, cushions, fine relief) painted once, plus a tiling noise for the fibres. */
export function bakeMoss(renderer) {
  const rt = new THREE.WebGLRenderTarget(1024, 1024, { depthBuffer: false });
  const mat = new THREE.ShaderMaterial({
    depthTest: false,
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `varying vec2 vUv;\n${NOISE}\nvoid main(){ vec2 mp = (vUv-0.5)*${(2 * RG).toFixed(3)};
      gl_FragColor = vec4(fbm(vec3(mp*1.3, 1.7)), smoothstep(0.2, 0.8, vnoise(vec3(mp*4.6, 3.0))), vnoise(vec3(mp*31.0, 3.0)), 1.0); }`,
  });
  const sc = new THREE.Scene(), quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  quad.frustumCulled = false; sc.add(quad);
  renderer.setRenderTarget(rt); renderer.render(sc, new THREE.Camera()); renderer.setRenderTarget(null);
  mat.dispose(); quad.geometry.dispose();
  const N = 256, data = new Uint8Array(N * N * 4);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 256) | 0;
  const noise = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  noise.wrapS = noise.wrapT = THREE.RepeatWrapping; noise.magFilter = THREE.LinearFilter;
  // mipmaps make far-off moss resolve to a solid carpet instead of sparkling
  noise.minFilter = THREE.LinearMipmapLinearFilter; noise.generateMipmaps = true; noise.needsUpdate = true;
  return { bake: rt.texture, noise };
}

// ------------------------------------------------------------ geometry ----

function frondGeo() {
  const pos = [], col = [];
  const tri = (a, b, c, ca, cb, cc) => { pos.push(...a, ...b, ...c); col.push(...ca, ...cb, ...cc); };
  const dark = [0.045, 0.15, 0.03], mid = [0.11, 0.29, 0.055], light = [0.27, 0.47, 0.1], stem = [0.16, 0.15, 0.05];
  for (let k = 0; k < 10; k++) {
    const y0 = k / 10, y1 = (k + 1) / 10, w0 = 0.013 * (1 - y0 * 0.8), w1 = 0.013 * (1 - y1 * 0.8);
    tri([-w0, y0, 0], [w0, y0, 0], [-w1, y1, 0], stem, stem, stem);
    tri([w0, y0, 0], [w1, y1, 0], [-w1, y1, 0], stem, stem, stem);
  }
  const N = 15;
  for (let i = 0; i < N; i++) {
    const t = (i + 1) / (N + 1.5);
    const len = 0.36 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.75)), 0.85) * (1 - 0.15 * t) + 0.02;
    const w = 0.064 * (1 - 0.45 * t);
    for (const s of [-1, 1]) {
      const b0 = [0, t - w * 0.5, 0], b1 = [0, t + w * 0.5, 0];
      const m1 = [s * len * 0.5, t + len * 0.2 + w * 0.5, 0.022], m2 = [s * len * 0.55, t + len * 0.16 - w * 0.42, 0.022];
      const tip = [s * len, t + len * 0.36, -0.018];
      tri(b0, m2, b1, dark, mid, dark); tri(b1, m2, m1, dark, mid, mid); tri(m1, m2, tip, mid, mid, light);
    }
  }
  tri([-0.03, 0.93, 0], [0.03, 0.93, 0], [0, 1.05, 0], mid, mid, light);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

function cloverGeo() {
  const pos = [], col = [], idx = [];
  const H = 0.15, K = 5, S = 4;
  for (let k = 0; k <= K; k++) {
    const t = k / K, r = 0.0045 * (1 - 0.4 * t);
    for (let j = 0; j < S; j++) {
      const a = (j / S) * TAU;
      pos.push(0.035 * t * t + Math.cos(a) * r, t * H, Math.sin(a) * r); col.push(0.17, 0.27, 0.08);
    }
  }
  for (let k = 0; k < K; k++) for (let j = 0; j < S; j++) {
    const a = k * S + j, b = k * S + ((j + 1) % S);
    idx.push(a, a + S, b, b, a + S, b + S);
  }
  const base = pos.length / 3, N = 14, RR = 0.062, tilt = 0.4;
  const put = (x, y, z, c) => { // tilt the leaf about z
    pos.push(0.035 + x * Math.cos(tilt) - y * Math.sin(tilt), H + x * Math.sin(tilt) + y * Math.cos(tilt), z); col.push(...c);
  };
  put(0, -0.006, 0, [0.26, 0.44, 0.12]);
  for (let j = 0; j < N; j++) {
    const a = (j / N) * TAU, r = RR * (1 + 0.07 * Math.cos(a * 7)) * (1 + 0.15 * Math.cos(a));
    put(Math.cos(a) * r * 0.55, -0.001, Math.sin(a) * r * 0.55, [0.11, 0.3, 0.06]);
    put(Math.cos(a) * r, 0.006 * Math.cos(a * 7), Math.sin(a) * r, [0.05, 0.2, 0.04]);
  }
  for (let j = 0; j < N; j++) {
    const i0 = base + 1 + j * 2, i1 = base + 1 + ((j + 1) % N) * 2;
    idx.push(base, i1, i0, i0, i1, i0 + 1, i1, i1 + 1, i0 + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

function tuftGeo() {
  const pos = [], col = [];
  const B = 5, K = 3;
  for (let b = 0; b < B; b++) {
    const a = (b / B) * TAU + 0.4 * Math.sin(b * 7.1), lean = 0.55 + 0.5 * Math.abs(Math.sin(b * 3.3)), h = 0.05 + 0.03 * Math.abs(Math.cos(b * 5.7));
    const ca = Math.cos(a), sa = Math.sin(a), w = 0.0075;
    const pt = (t, s) => {
      const out = lean * h * t * t, y = h * t * (1 - 0.25 * t * lean), ww = w * (1 - t) * s;
      return [ca * out - sa * ww + ca * 0.012, y, sa * out + ca * ww + sa * 0.012];
    };
    const c = (t) => [0.06 + 0.3 * t * t, 0.15 + 0.38 * t, 0.03 + 0.08 * t];
    for (let k = 0; k < K; k++) {
      const t0 = k / K, t1 = (k + 1) / K;
      const a0 = pt(t0, -1), b0 = pt(t0, 1), a1 = pt(t1, -1), b1 = pt(t1, 1);
      pos.push(...a0, ...b0, ...a1, ...b0, ...b1, ...a1);
      col.push(...c(t0), ...c(t0), ...c(t1), ...c(t0), ...c(t1), ...c(t1));
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

function lanternGeo() {
  const parts = [];
  const paint = (g, colorFn, glowFn) => {
    g = g.index ? g.toNonIndexed() : g;
    g.deleteAttribute('uv');
    const p = g.attributes.position, c = new Float32Array(p.count * 3), gl = new Float32Array(p.count);
    for (let i = 0; i < p.count; i++) {
      const cc = colorFn(p.getX(i), p.getY(i), p.getZ(i)); c[i * 3] = cc[0]; c[i * 3 + 1] = cc[1]; c[i * 3 + 2] = cc[2];
      gl[i] = glowFn ? glowFn(p.getX(i), p.getY(i), p.getZ(i)) : 0;
    }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
    g.setAttribute('aGlow', new THREE.BufferAttribute(gl, 1));
    parts.push(g);
  };
  const pts = [[0, 0], [0.015, 0.2], [0.04, 0.4], [0.11, 0.56], [0.22, 0.615], [0.31, 0.57], [0.345, 0.5]].map(([x, y]) => new THREE.Vector3(x, y, 0));
  paint(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 22, 0.011, 6, false), (x, y) => [0.1 + 0.12 * y, 0.16 + 0.1 * y, 0.12 + 0.12 * y]);
  const prof = [];
  for (let i = 0; i <= 12; i++) { const v = i / 12; prof.push(new THREE.Vector2(0.06 * Math.pow(Math.sin(Math.PI * v), 0.75) * (0.5 + 0.8 * v) + 0.0005, -0.16 * v)); }
  const bulb = new THREE.LatheGeometry(prof, 16); bulb.translate(0.345, 0.5, 0);
  paint(bulb, (x, y) => { const v = clamp((0.5 - y) / 0.16, 0, 1); return [0.16 + 0.3 * v, 0.4 + 0.4 * v, 0.4 + 0.35 * v]; }, (x, y) => 0.15 + 0.85 * Math.pow(clamp((0.5 - y) / 0.16, 0, 1), 1.5));
  const cal = new THREE.ConeGeometry(0.028, 0.05, 8); cal.translate(0.345, 0.5, 0);
  paint(cal, () => [0.08, 0.2, 0.12]);
  for (const s of [-1, 1]) { // two basal leaves
    const N = 6, pos = [], idx = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N, w = 0.045 * Math.sin(Math.PI * Math.pow(t, 0.7)), out = 0.2 * t, y = 0.1 * Math.sin(t * 2.2);
      pos.push(-w, y, s * out, 0, y - 0.012, s * out, w, y, s * out);
    }
    for (let i = 0; i < N; i++) { const a = i * 3; idx.push(a, a + 3, a + 1, a + 1, a + 3, a + 4, a + 1, a + 4, a + 2, a + 2, a + 4, a + 5); }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); lg.setIndex(idx); lg.computeVertexNormals();
    paint(lg, (x, y, z) => { const t = Math.abs(z) / 0.2; return [0.05 + 0.1 * t, 0.2 + 0.18 * t, 0.12 + 0.08 * t]; });
  }
  return mergeGeometries(parts);
}

function mushroomGeo(o) {
  const { stemH, stemR, capR, capH, pr, py, bend, seed, lip = 0, under = 0.22 } = o;
  const SEG = 24, pos = [], clo = [], part = [], uv = [], idx = [];
  let rows = 0;
  const ring = (cx, y, r, p, a, cr, cy, wob) => {
    for (let j = 0; j <= SEG; j++) {
      const th = (j / SEG) * TAU, c = Math.cos(th), s = Math.sin(th);
      const w = 1 + wob * (r / capR) * (0.09 * noise3(c * 1.3 + seed, s * 1.3, 0.5) + 0.03 * noise3(c * 4 + seed, s * 4, 2.5));
      pos.push(cx + c * r * w, y + wob * 0.04 * capH * noise3(c * 2 + seed, s * 2, 7) * (r / capR), s * r * w);
      clo.push(cx + c * cr, cy, s * cr); part.push(p); uv.push(a, th);
    }
    return rows++;
  };
  const strip = (r0, r1) => {
    for (let j = 0; j < SEG; j++) { const a = r0 * (SEG + 1) + j, b = a + 1, c = r1 * (SEG + 1) + j, d = c + 1; idx.push(a, c, b, b, c, d); }
  };
  let prev = -1;
  for (let k = 0; k <= 7; k++) { // stem
    const t = k / 7, r = stemR * (1 + 0.6 * (1 - smooth(0, 0.3, t))) * (1 - 0.12 * t);
    const cur = ring(bend * t * t, t * stemH, r, 0, t, r, t * stemH, 0);
    if (prev >= 0) strip(prev, cur); prev = cur;
  }
  const y0 = stemH * 0.96, rimR = capR * (1 + lip * 0.3);
  prev = -1;
  for (let k = 0; k <= 10; k++) { // cap top
    const a = k / 10, fl = smooth(0.72, 1, a);
    const r = capR * Math.pow(a, pr) * (1 + lip * 0.3 * fl), y = y0 + capH * (1 - Math.pow(a, py)) + lip * capH * 0.12 * fl;
    const cr = stemR * 2.1 * Math.sin((a * Math.PI) / 2), cy = y0 - capH * 0.3 + capH * 1.25 * Math.cos((a * Math.PI) / 2);
    const cur = ring(bend, y, r, 1, a, cr, cy, 1);
    if (prev >= 0) strip(prev, cur); prev = cur;
  }
  prev = -1;
  for (let k = 0; k <= 4; k++) { // gills
    const b = k / 4, r = rimR * (1 - b) + stemR * 1.05 * b;
    const y = y0 + lip * capH * 0.12 * (1 - b) + capH * under * Math.sin((b * Math.PI) / 2);
    const cur = ring(bend, y, r, 2, b, stemR * (2.1 - 1.0 * b), y0 - capH * 0.3, 1);
    if (prev >= 0) strip(prev, cur); prev = cur;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aClosed', new THREE.Float32BufferAttribute(clo, 3));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
  g.setAttribute('aUv2', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

// ------------------------------------------------------------ materials ----

function mushroomMaterial(key, U, p) {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.6, side: THREE.DoubleSide });
  const u = {
    uTime: U.uTime, uNight: U.uNight,
    uCapA: { value: new THREE.Color(...p.capA) }, uCapB: { value: new THREE.Color(...p.capB) },
    uStem: { value: new THREE.Color(...p.stem) }, uGill: { value: new THREE.Color(...p.gill) },
    uGlow: { value: new THREE.Color(...(p.glow || [0, 0, 0])) }, uGlowAmt: { value: p.glowAmt || 0 },
    uSpots: { value: p.spots || 0 }, uGillN: { value: p.gillN || 48 }, uCapRough: { value: p.capRough ?? 0.5 },
  };
  return patchStandard(m, key, {
    vertPars: `attribute vec3 aClosed; attribute float aPart; attribute vec2 aUv2; attribute float aOpen; attribute float aSeed;
      varying vec3 vM; varying vec2 vUv2; uniform float uTime;`,
    vert: `transformed = mix(aClosed, position, aOpen);
      float swayPh = uTime*0.9 + aSeed*6.28;
      transformed.x += sin(swayPh)*0.03*position.y*position.y; transformed.z += cos(swayPh*0.8)*0.02*position.y*position.y;
      vM = vec3(aPart, aSeed, aOpen); vUv2 = aUv2;`,
    fragPars: `varying vec3 vM; varying vec2 vUv2; uniform float uTime, uNight, uGlowAmt, uSpots, uGillN, uCapRough;
      uniform vec3 uCapA, uCapB, uStem, uGill, uGlow;`,
    color: /* glsl */ `
      float ma = vUv2.x, mth = vUv2.y, mseed = vM.y;
      float mn = fbm(vPos*6.0 + mseed*20.0), mgl = 0.0;
      vec3 mcol;
      if (vM.x < 0.5) {
        float fib = vnoise(vec3(mth*9.0, vPos.y*3.0, mseed*9.0));
        mcol = uStem*(0.72+0.42*fib)*(0.65+0.35*smoothstep(0.0,0.25,ma));
        mgl = 0.3*ma;
      } else if (vM.x < 1.5) {
        mcol = mix(uCapA, uCapB, smoothstep(0.15,1.0,ma))*(0.78+0.44*mn);
        mcol *= 1.0 + 0.35*vnoise(vec3(mth*38.0, ma*3.0, mseed))*smoothstep(0.65,1.0,ma);
        vec4 mvo = voro3(vPos*7.0 + mseed*13.0);
        float spot = smoothstep(0.3,0.22,mvo.x)*step(0.3,mvo.z)*uSpots*(1.0-smoothstep(0.8,1.0,ma));
        mcol = mix(mcol, vec3(0.88,0.82,0.68), spot);
        mgl = 0.06 + 0.7*ma*ma + spot;
      } else {
        float stripes = 0.5+0.5*sin(mth*uGillN);
        mcol = uGill*(0.4+0.6*stripes)*(0.55+0.45*ma);
        mgl = 0.7 + 1.5*stripes;
      }
      diffuseColor.rgb = mcol;`,
    rough: 'roughnessFactor = (vM.x > 0.5 && vM.x < 1.5) ? uCapRough : 0.85;',
    normal: 'normal = bumpN(normal, mn, 0.01);',
    emissive: `float mpulse = 0.75+0.25*sin(uTime*1.4+mseed*40.0);
      totalEmissiveRadiance += uGlow*uGlowAmt*mgl*mpulse*vM.z*mix(0.22,1.0,uNight);`,
  }, u);
}

const FERN_VERT_PARS = 'attribute float aGrow; attribute float aSeed; uniform float uTime;';
const FERN_VERT = /* glsl */ `
  float fy = position.y, curl = 1.0 - aGrow;
  float fk = 0.95*(0.35+0.65*fy) + 0.1*sin(uTime*1.2 + aSeed*6.28 + fy*2.0) - curl*curl*11.0*fy - curl*0.6;
  float fang = fk*fy, fkk = abs(fk) < 1e-3 ? 1e-3 : fk;
  transformed.y = sin(fang)/fkk;
  transformed.z = position.z*cos(fang) + (1.0-cos(fang))/fkk;
  transformed.x *= mix(0.3, 1.0, smoothstep(0.1,0.9,aGrow));`;

// ------------------------------------------------------- instanced pool ----

class Pool {
  constructor(geo, mat, max, attrs = {}, cast = true) {
    this.max = max; this.n = 0; this.free = [];
    this.attr = {};
    for (const k in attrs) {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(max * attrs[k]), attrs[k]);
      a.setUsage(THREE.DynamicDrawUsage); geo.setAttribute(k, a); this.attr[k] = a;
    }
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.count = 0; this.mesh.frustumCulled = false; this.mesh.renderOrder = 2;
    this.mesh.castShadow = cast; this.mesh.receiveShadow = true;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }
  alloc() { if (this.free.length) return this.free.pop(); if (this.n < this.max) { this.mesh.count = ++this.n; return this.n - 1; } return -1; }
  set(i, m) { this.mesh.setMatrixAt(i, m); this.mesh.instanceMatrix.needsUpdate = true; }
  setAttr(k, i, v) { this.attr[k].array[i] = v; this.attr[k].needsUpdate = true; }
  release(i) { this.set(i, ZERO); this.free.push(i); }
}
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(), _v = new THREE.Vector3();

// ------------------------------------------------------------ ecosystem ----

export class Ecosystem {
  constructor(island, U, rnd, opts = {}) {
    this.rnd = rnd; this.U = U; this.obstacles = island.obstacles;
    this.group = new THREE.Group();
    this.fx = { puff() {} };

    // surface fields
    this.presence = new Float32Array(G * G); this.fert = new Float32Array(G * G); this.lum = new Float32Array(G * G);
    this.base = new Float32Array(G * G); this.vital = new Float32Array(G * G); this.lumV = new Float32Array(G * G);
    this.tmp = new Float32Array(G * G);
    for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
      const x = ((i + 0.5) / G - 0.5) * 2 * RG, z = ((j + 0.5) / G - 0.5) * 2 * RG;
      const n = 0.5 + 0.5 * noise3(x * 0.8 + 9, 2.2, z * 0.8 - 4);
      this.base[j * G + i] = this.vital[j * G + i] = 0.2 + 0.26 * smooth(0.35, 0.8, n);
    }
    this.texData = new Uint8Array(G * G * 4);
    this.tex = new THREE.DataTexture(this.texData, G, G, THREE.RGBAFormat);
    this.tex.magFilter = this.tex.minFilter = THREE.LinearFilter;
    this.tex.wrapS = this.tex.wrapT = THREE.ClampToEdgeWrapping;
    U.uVital.value = this.tex;
    this.fieldTimer = 0; this.spawnTimer = 0; this.fruitTimer = 0;
    this.bankSap = 1.5; this.bankDew = 0; // food in the ground, waiting to fruit
    this._upload();

    // --- moss: shell layers over the ground ------------------------------
    const SHELLS = opts.shells || 10;
    const sg = island.shellGeometry;
    const sh = new Float32Array(SHELLS);
    for (let i = 0; i < SHELLS; i++) sh[i] = 1 - i / SHELLS; // top first for early-z
    sg.setAttribute('aShell', new THREE.InstancedBufferAttribute(sh, 1));
    // The layers are drawn twice. First a bare pass that only decides which fibres
    // exist and writes depth; then the lit pass, which draws exactly the one visible
    // fragment per pixel (depth test "equal"), so lighting is never paid for twice.
    const mossU = { uVital: U.uVital, uTime: U.uTime, uNight: U.uNight, uMossBake: U.uMossBake, uNoiseTex: U.uNoiseTex };
    const mossVert = {
      vertPars: 'invariant gl_Position;\nattribute float aShell; varying float vShell; varying float vMossH; varying vec3 vBase; uniform float uTime; uniform sampler2D uVital, uMossBake;',
      vert: `vShell = aShell; vBase = position;
        // moss height varies slowly, so it is worked out per vertex rather than per pixel per layer
        vec2 muvV = position.xz*${INV}+0.5; vec4 vtV = texture2D(uVital, muvV); vec4 mbV = texture2D(uMossBake, muvV);
        float mHV = vtV.r*(0.35+0.65*mbV.g)*smoothstep(0.2, 0.5, mbV.r*0.8 + vtV.r*0.6);
        vMossH = mHV < 0.05 ? 0.0 : 0.28 + 0.72*mHV; // where moss grows at all, it has some body
        float mw = sin(uTime*1.1 + position.x*2.3 + position.z*1.9) + sin(uTime*0.7 + position.z*3.1);
        transformed += objectNormal*aShell*${MOSS_H} + vec3(mw, 0.0, mw*0.6)*0.0035*aShell*aShell;`,
      fragPars: 'varying float vShell; varying float vMossH; varying vec3 vBase; uniform sampler2D uVital, uMossBake, uNoiseTex; uniform float uNight;',
    };
    const mossFibre = /* glsl */ `
        vec2 mp = vBase.xz, muv = mp*${INV}+0.5;
        float mtip = vShell/max(vMossH, 1e-3);
        MOSS_EARLY
        vec4 mb = texture2D(uMossBake, muv);
        float fz = 0.55*texture2D(uNoiseTex, mp*(95.0/256.0)).r + 0.3*texture2D(uNoiseTex, mp*(190.0/256.0)+0.37).g + 0.15*mb.b;`;
    const mossPre = patchStandard(new THREE.MeshLambertMaterial({ colorWrite: false }), 'moss-pre', {
      ...mossVert,
      fragStart: mossFibre.replace('MOSS_EARLY', 'if (mtip > 1.0) discard;   // above the moss here: nothing to look up') + `
        if (fz < 0.1 + 0.6*mtip) discard;
        gl_FragColor = vec4(0.0); return;`,
    }, mossU);
    const mossMat = patchStandard(new THREE.MeshLambertMaterial({ depthFunc: THREE.EqualDepth, depthWrite: false }), 'moss', {
      ...mossVert,
      fragStart: mossFibre.replace('MOSS_EARLY', '') + `
        vec4 vt = texture2D(uVital, muv);
        float patchN = mb.r, cush = mb.g;
        float mspark = hash21(floor(mp*55.0));`,
      color: /* glsl */ `
        vec3 mossC = mix(vec3(0.014,0.04,0.01), mix(vec3(0.075,0.19,0.03), vec3(0.15,0.24,0.045), patchN), smoothstep(0.0,0.6,mtip));
        mossC = mix(mossC, mix(vec3(0.26,0.40,0.07), vec3(0.42,0.47,0.11), cush), smoothstep(0.5,1.0,mtip));
        mossC = mix(mossC, vec3(mossC.r*0.3, mossC.g*1.05, mossC.g*0.9), vt.g*0.8);
        mossC *= mix(0.45, 1.0, mtip)*(0.55+0.9*fz);
        diffuseColor.rgb = mossC;`,
      normal: 'normal = bumpN(normal, mb.b + cush, 0.012);',
      emissive: `totalEmissiveRadiance += vec3(0.08,0.75,0.62)*vt.g*step(0.86,mspark)*pow(mtip,3.0)*mix(0.25,1.3,uNight);`,
    }, mossU);
    const shellsPre = new THREE.InstancedMesh(sg, mossPre, SHELLS), shells = new THREE.InstancedMesh(sg, mossMat, SHELLS);
    for (const m of [shellsPre, shells]) {
      for (let i = 0; i < SHELLS; i++) m.setMatrixAt(i, _m.identity());
      m.frustumCulled = false; this.group.add(m);
    }
    shellsPre.renderOrder = 2; shells.renderOrder = 2.5; shells.receiveShadow = true;
    this.shells = shells; this.shellsPre = shellsPre;
    this.shellAttr = sg.attributes.aShell;

    // --- tufts ------------------------------------------------------------
    const NT = opts.tufts || 3600;
    const tg = tuftGeo();
    const tr = new Float32Array(NT * 3);
    tg.setAttribute('aRnd', new THREE.InstancedBufferAttribute(tr, 3));
    const tuftMat = patchStandard(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), 'tuft', {
      vertPars: 'attribute vec3 aRnd; uniform sampler2D uVital; uniform float uTime; varying vec3 vTuft;',
      vert: `vec3 tio = instanceMatrix[3].xyz;
        vec4 tvt = texture2D(uVital, tio.xz*${INV}+0.5);
        transformed *= smoothstep(0.1, 0.7, tvt.r + (aRnd.x-0.5)*0.45);
        float thh = position.y/0.08, tph = uTime*1.4 + tio.x*2.1 + tio.z*1.7 + aRnd.z*6.28;
        transformed.x += sin(tph)*0.008*thh*thh; transformed.z += cos(tph*0.8)*0.006*thh*thh;
        vTuft = vec3(thh, aRnd.y, tvt.g);`,
      fragPars: 'varying vec3 vTuft; uniform float uNight;',
      color: `diffuseColor.rgb *= mix(vec3(0.75,1.0,0.7), vec3(1.25,1.05,0.8), vTuft.y);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(diffuseColor.r*0.3, diffuseColor.g*1.05, diffuseColor.g*0.9), vTuft.z*0.8);`,
      emissive: 'totalEmissiveRadiance += vec3(0.08,0.8,0.65)*vTuft.z*pow(vTuft.x,3.0)*step(0.7,vTuft.y)*mix(0.2,1.0,uNight);',
    }, { uVital: U.uVital, uTime: U.uTime, uNight: U.uNight });
    const tufts = new THREE.InstancedMesh(tg, tuftMat, NT);
    for (let i = 0; i < NT; i++) {
      let x, z;
      if (i % 4 === 0) { const th = rnd() * TAU, r = outline(th) * (0.9 + rnd() * 0.09); x = r * Math.cos(th); z = r * Math.sin(th); }
      else [x, z] = randomSurfacePoint(rnd, 0.97);
      const s = blocked(this.obstacles, x, z, -0.04) ? 0 : 0.7 + rnd() * 0.9;
      const edge = i % 4 === 0 ? 0.5 : 0;
      _e.set((rnd() - 0.5) * 0.4 + edge * Math.sin(Math.atan2(z, x)), rnd() * TAU, (rnd() - 0.5) * 0.4 - edge * Math.cos(Math.atan2(z, x)), 'XZY');
      _m.compose(_v.set(x, topH(x, z) + 0.005, z), _q.setFromEuler(_e), _s.set(s, s * (0.8 + rnd() * 0.6), s));
      tufts.setMatrixAt(i, _m);
      tr[i * 3] = rnd() + (i % 4 === 0 ? 0.25 : 0); tr[i * 3 + 1] = rnd(); tr[i * 3 + 2] = rnd();
    }
    tufts.receiveShadow = true; tufts.renderOrder = 2; tufts.frustumCulled = false;
    this.group.add(tufts);

    // --- growing things ----------------------------------------------------
    const tU = { uTime: U.uTime, uNight: U.uNight };
    const fernMat = patchStandard(new THREE.MeshStandardMaterial({ roughness: 0.65, vertexColors: true, side: THREE.DoubleSide }), 'fern',
      { vertPars: FERN_VERT_PARS, vert: FERN_VERT }, tU);
    this.ferns = new Pool(frondGeo(), fernMat, 440, { aGrow: 1, aSeed: 1 });
    this.ferns.mesh.customDepthMaterial = patchDepth(new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking }), 'fernD',
      { vertPars: FERN_VERT_PARS, vert: FERN_VERT }, tU);

    const cloverMat = patchStandard(new THREE.MeshStandardMaterial({ roughness: 0.55, vertexColors: true, side: THREE.DoubleSide }), 'clover', {
      vertPars: 'attribute float aSeed; uniform float uTime;',
      vert: `float cph = uTime*1.6 + aSeed*6.28, chh = position.y/0.15;
        transformed.x += sin(cph)*0.012*chh*chh; transformed.z += cos(cph*0.7)*0.01*chh*chh;`,
    }, tU);
    this.clover = new Pool(cloverGeo(), cloverMat, 1000, { aSeed: 1 });

    const lanternMat = patchStandard(new THREE.MeshStandardMaterial({ roughness: 0.5, vertexColors: true, side: THREE.DoubleSide }), 'lantern', {
      vertPars: 'attribute float aGlow; attribute float aSeed; uniform float uTime; varying vec2 vGl;',
      vert: `float lh = clamp(position.y/0.6, 0.0, 1.0), lph = uTime*1.1 + aSeed*6.28;
        transformed.x += sin(lph)*0.035*lh*lh; transformed.z += cos(lph*0.83)*0.03*lh*lh;
        vGl = vec2(aGlow, aSeed);`,
      fragPars: 'varying vec2 vGl; uniform float uTime, uNight;',
      emissive: `totalEmissiveRadiance += vec3(0.22,0.95,0.82)*vGl.x*(0.7+0.3*sin(uTime*1.6+vGl.y*6.28))*mix(0.5,2.4,uNight);`,
    }, tU);
    this.lanterns = new Pool(lanternGeo(), lanternMat, 44, { aSeed: 1 });

    const mAttr = { aOpen: 1, aSeed: 1 };
    this.species = [
      { name: 'russet', cost: 2.2, blue: false, scale: [0.17, 0.3], dur: 18, life: [220, 380], gap: 0.17,
        pool: new Pool(mushroomGeo({ stemH: 1, stemR: 0.11, capR: 0.44, capH: 0.3, pr: 0.7, py: 2.2, bend: 0.1, seed: 3 }),
          mushroomMaterial('m-russet', U, { capA: [0.42, 0.07, 0.025], capB: [0.72, 0.3, 0.07], stem: [0.74, 0.67, 0.5], gill: [0.8, 0.7, 0.5], spots: 1, gillN: 56, capRough: 0.38 }), 40, mAttr),
        spore: new THREE.Color(1.0, 0.85, 0.55) },
      { name: 'bell', cost: 2.0, blue: true, scale: [0.15, 0.25], dur: 22, life: [260, 420], gap: 0.14,
        pool: new Pool(mushroomGeo({ stemH: 1.5, stemR: 0.045, capR: 0.27, capH: 0.44, pr: 0.5, py: 3.2, bend: 0.28, seed: 9, lip: 0.5, under: 0.6 }),
          mushroomMaterial('m-bell', U, { capA: [0.05, 0.2, 0.3], capB: [0.1, 0.42, 0.5], stem: [0.42, 0.58, 0.6], gill: [0.2, 0.8, 0.8], glow: [0.12, 0.85, 1.0], glowAmt: 1.7, gillN: 40, capRough: 0.3 }), 40, mAttr),
        spore: new THREE.Color(0.3, 0.9, 1.0) },
      { name: 'pin', cost: 0.3, blue: false, scale: [0.05, 0.095], dur: 9, life: [150, 300], gap: 0.045,
        pool: new Pool(mushroomGeo({ stemH: 1, stemR: 0.05, capR: 0.23, capH: 0.3, pr: 0.6, py: 2.7, bend: 0.2, seed: 17 }),
          mushroomMaterial('m-pin', U, { capA: [0.5, 0.36, 0.2], capB: [0.76, 0.66, 0.46], stem: [0.72, 0.67, 0.56], gill: [0.7, 0.62, 0.48], gillN: 30, capRough: 0.6 }), 190, mAttr),
        spore: new THREE.Color(0.9, 0.85, 0.7) },
    ];
    for (const p of [this.ferns, this.clover, this.lanterns, ...this.species.map((s) => s.pool)]) this.group.add(p.mesh);

    this.growing = [];      // things still animating in
    this.mushrooms = [];    // { sp, i, x, z, y, die, ... }
    this.spots = { fern: [], clover: [], lantern: [] };
    this.glowSpots = [];    // positions of light-emitting growth, newest last
  }

  /** Use fewer moss layers, respaced so they still span the full height of the moss. */
  setShells(n) {
    n = Math.min(n, this.shells.count);
    const a = this.shellAttr.array;
    for (let i = 0; i < n; i++) a[i] = 1 - i / n; // top first for early-z
    this.shellAttr.needsUpdate = true;
    this.shells.count = this.shellsPre.count = n;
  }

  // --------------------------------------------------------------- fields --

  _idx(x, z) {
    const i = clamp(((x / (2 * RG) + 0.5) * G) | 0, 0, G - 1), j = clamp(((z / (2 * RG) + 0.5) * G) | 0, 0, G - 1);
    return j * G + i;
  }
  deposit(x, z, w) { const k = this._idx(x, z); this.presence[k] = Math.max(0, this.presence[k] + w); }
  fertilize(x, z, type, amt) {
    const f = type ? this.lum : this.fert, ci = ((x / (2 * RG) + 0.5) * G) | 0, cj = ((z / (2 * RG) + 0.5) * G) | 0, rad = 8;
    for (let dj = -rad; dj <= rad; dj++) for (let di = -rad; di <= rad; di++) {
      const i = ci + di, j = cj + dj;
      if (i < 0 || j < 0 || i >= G || j >= G) continue;
      const k = j * G + i;
      f[k] = Math.min(1.2, f[k] + amt * 0.2 * Math.exp(-(di * di + dj * dj) / 22));
      if (type) this.fert[k] = Math.min(1.2, this.fert[k] + amt * 0.07 * Math.exp(-(di * di + dj * dj) / 22));
    }
  }
  sample(x, z) { const k = this._idx(x, z); return [this.vital[k], this.lumV[k]]; }

  _upload() {
    const blur = (src, ch) => {
      for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
        let s = 0, n = 0;
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          const a = i + di, b = j + dj;
          if (a < 0 || b < 0 || a >= G || b >= G) continue;
          const w = di === 0 && dj === 0 ? 2 : 1; s += src[b * G + a] * w; n += w;
        }
        this.texData[(j * G + i) * 4 + ch] = clamp((s / n) * 255, 0, 255);
      }
    };
    blur(this.vital, 0); blur(this.lumV, 1);
    this.tex.needsUpdate = true;
  }

  // ----------------------------------------------------------------- tick --

  tick(dt, t) {
    this.fieldTimer += dt;
    if (this.fieldTimer >= 0.25) {
      const d = this.fieldTimer; this.fieldTimer = 0;
      for (let k = 0; k < G * G; k++) {
        const target = Math.min(1, this.base[k] + 0.36 * (1 - Math.exp(-this.presence[k] * 0.22)) + 0.62 * this.fert[k]);
        const v = this.vital[k];
        this.vital[k] = v + (target - v) * (target > v ? 0.09 : 0.012) * d;
        this.lumV[k] += (Math.min(1, this.lum[k]) - this.lumV[k]) * 0.12 * d;
        this.fert[k] *= 1 - 0.004 * d; this.lum[k] *= 1 - 0.0025 * d;
      }
      this._upload();
    }

    const rnd = this.rnd;
    this.spawnTimer += dt;
    if (this.spawnTimer > 0.4) {
      this.spawnTimer = 0;
      for (let k = 0; k < 5; k++) {
        const [x, z] = randomSurfacePoint(rnd, 0.93);
        if (blocked(this.obstacles, x, z, 0.02)) continue;
        const [v, l] = this.sample(x, z);
        if (l > 0.3 && rnd() < 0.16 * l && this._clear('lantern', x, z, 0.26)) this.spawnLantern(x, z, t);
        else if (v > 0.52 && rnd() < 0.1 * v && this._clear('fern', x, z, 0.5)) this.spawnFern(x, z, t, v);
        else if (v > 0.4 && rnd() < 0.14 * v && this._clear('clover', x, z, 0.24)) this.spawnClover(x, z, t);
      }
    }

    // fruiting: mushrooms come up on the richest ground, paid for out of what has been eaten
    this.fruitTimer += dt;
    if (this.fruitTimer > 1.1) {
      this.fruitTimer = 0;
      let x = 0, z = 0, best = -1;
      for (let c = 0; c < 6; c++) {
        const [cx, cz] = randomSurfacePoint(rnd, 0.92), sv = this.sample(cx, cz), score = sv[0] + sv[1] + rnd() * 0.25;
        if (score > best) { best = score; x = cx; z = cz; }
      }
      if (!blocked(this.obstacles, x, z, 0)) {
        const [v, l] = this.sample(x, z), sp0 = this.species[0], sp1 = this.species[1];
        let sp = null;
        if (l > 0.25 && this.bankDew > sp1.cost && rnd() < 0.7) sp = sp1;
        else if (v > 0.5 && this.bankSap > sp0.cost && rnd() < 0.6) sp = sp0;
        else if (v > 0.4 && this.bankSap > 1.2 && rnd() < 0.3) sp = this.species[2];
        if (sp && this._mushClear(x, z, sp.gap)) {
          const n = sp.name === 'pin' ? 3 + ((rnd() * 5) | 0) : 1;
          let made = 0;
          for (let c = 0; c < n; c++) {
            const mx = c ? x + (rnd() - 0.5) * 0.2 : x, mz = c ? z + (rnd() - 0.5) * 0.2 : z;
            if (c && (!this._mushClear(mx, mz, sp.gap) || blocked(this.obstacles, mx, mz, 0))) continue;
            if (this.spawnMushroom(sp, mx, mz, t + c * 1.5)) made++;
          }
          if (sp.blue) this.bankDew = Math.max(0, this.bankDew - sp.cost * made); else this.bankSap = Math.max(0, this.bankSap - sp.cost * made);
        }
      }
    }

    // old mushrooms shed spores and wither
    for (let k = this.mushrooms.length - 1; k >= 0; k--) {
      const m = this.mushrooms[k];
      if (!m.puffed && t > m.t0 + m.dur + 2) { m.puffed = true; this.fx.puff(_v.set(m.x, m.y + m.h, m.z), m.sp.spore, m.sp.name === 'pin' ? 3 : 14); }
      if (m.puffed && m.sp.name !== 'pin' && rnd() < 0.004) this.fx.puff(_v.set(m.x, m.y + m.h, m.z), m.sp.spore, 4);
      if (t > m.die && !m.withering) { m.withering = true; this.growing.push({ kind: 'wither', m, t0: t, dur: 7 }); }
    }
  }

  _clear(kind, x, z, gap) {
    for (const s of this.spots[kind]) if (Math.hypot(s[0] - x, s[1] - z) < gap) return false;
    return true;
  }
  _mushClear(x, z, gap) {
    for (const m of this.mushrooms) if (Math.hypot(m.x - x, m.z - z) < gap + m.gap) return false;
    return true;
  }

  // --------------------------------------------------------------- spawns --

  spawnFern(x, z, t, v = 0.7) {
    const rnd = this.rnd, n = 5 + ((rnd() * 4) | 0), size = 0.3 + 0.32 * rnd() * v, y = topH(x, z) - 0.01, a0 = rnd() * TAU;
    let made = false;
    for (let k = 0; k < n; k++) {
      const i = this.ferns.alloc(); if (i < 0) break;
      made = true;
      _e.set(0.3 + rnd() * 0.6, a0 + (k / n) * TAU + (rnd() - 0.5) * 0.5, 0, 'YXZ');
      const s = size * (0.7 + rnd() * 0.5);
      this.ferns.setAttr('aSeed', i, rnd()); this.ferns.setAttr('aGrow', i, 0);
      this.growing.push({ kind: 'fern', pool: this.ferns, i, pos: new THREE.Vector3(x, y, z), quat: new THREE.Quaternion().setFromEuler(_e), s, t0: t + k * 0.8 + rnd(), dur: 16 + rnd() * 10 });
      this.ferns.set(i, ZERO);
    }
    if (made) this.spots.fern.push([x, z]);
  }

  spawnClover(x, z, t) {
    const rnd = this.rnd, n = 3 + ((rnd() * 5) | 0);
    let made = false;
    for (let k = 0; k < n; k++) {
      const i = this.clover.alloc(); if (i < 0) break;
      made = true;
      const px = x + (rnd() - 0.5) * 0.16, pz = z + (rnd() - 0.5) * 0.16;
      _e.set((rnd() - 0.5) * 0.5, rnd() * TAU, (rnd() - 0.5) * 0.5, 'YXZ');
      this.clover.setAttr('aSeed', i, rnd());
      this.growing.push({ kind: 'plain', pool: this.clover, i, pos: new THREE.Vector3(px, topH(px, pz) - 0.004, pz), quat: new THREE.Quaternion().setFromEuler(_e), s: 0.4 + rnd() * 0.55, t0: t + rnd() * 3, dur: 7 + rnd() * 5 });
      this.clover.set(i, ZERO);
    }
    if (made) this.spots.clover.push([x, z]);
  }

  spawnLantern(x, z, t) {
    const rnd = this.rnd, i = this.lanterns.alloc(); if (i < 0) return;
    _e.set((rnd() - 0.5) * 0.2, rnd() * TAU, (rnd() - 0.5) * 0.2, 'YXZ');
    const s = 0.5 + rnd() * 0.4, y = topH(x, z) - 0.01;
    this.lanterns.setAttr('aSeed', i, rnd());
    const pos = new THREE.Vector3(x, y, z), quat = new THREE.Quaternion().setFromEuler(_e);
    this.growing.push({ kind: 'plain', pool: this.lanterns, i, pos, quat, s, t0: t, dur: 20 });
    this.lanterns.set(i, ZERO);
    this.spots.lantern.push([x, z]);
    this.glowSpots.push(new THREE.Vector3(0.345 * s, 0.42 * s, 0).applyQuaternion(quat).add(pos));
  }

  spawnMushroom(sp, x, z, t, grown = false) {
    const rnd = this.rnd, i = sp.pool.alloc(); if (i < 0) return false;
    _e.set((rnd() - 0.5) * 0.35, rnd() * TAU, (rnd() - 0.5) * 0.35, 'YXZ');
    const s = sp.scale[0] + rnd() * (sp.scale[1] - sp.scale[0]), y = topH(x, z) - 0.015;
    sp.pool.setAttr('aSeed', i, rnd()); sp.pool.setAttr('aOpen', i, 0);
    sp.pool.set(i, ZERO);
    const m = { sp, i, x, y, z, s, h: s * 1.2, gap: sp.gap, t0: grown ? t - 100 : t, dur: sp.dur, die: t + sp.life[0] + rnd() * (sp.life[1] - sp.life[0]),
      pos: new THREE.Vector3(x, y, z), quat: new THREE.Quaternion().setFromEuler(_e), puffed: grown };
    this.mushrooms.push(m);
    this.growing.push({ kind: 'mush', pool: sp.pool, i, pos: m.pos, quat: m.quat, s, t0: m.t0, dur: sp.dur });
    if (sp.blue) this.glowSpots.push(new THREE.Vector3(x, y + s * 1.5, z));
    return true;
  }

  /** A little life to start with, so the first frame is not bare. */
  seedInitial(t) {
    const rnd = this.rnd;
    let ferns = 0, clovers = 0;
    for (let k = 0; k < 400 && (ferns < 3 || clovers < 14); k++) {
      const [x, z] = randomSurfacePoint(rnd, 0.9);
      if (blocked(this.obstacles, x, z, 0.03)) continue;
      const [v] = this.sample(x, z);
      if (v > 0.33 && ferns < 3 && this._clear('fern', x, z, 0.8)) { this.spawnFern(x, z, t - 200, 0.5); ferns++; }
      else if (v > 0.25 && clovers < 14 && this._clear('clover', x, z, 0.2)) { this.spawnClover(x, z, t - 200); clovers++; }
    }
    for (const [x, z] of [[0.2, 0.62], [0.95, -0.18]]) for (let c = 0; c < 4; c++) this.spawnMushroom(this.species[2], x + (rnd() - 0.5) * 0.14, z + (rnd() - 0.5) * 0.14, t, true);
  }

  // ---------------------------------------------------------------- frame --

  frame(t) {
    const G2 = this.growing;
    for (let k = G2.length - 1; k >= 0; k--) {
      const g = G2[k];
      let u = clamp((t - g.t0) / g.dur, 0, 1);
      if (g.kind === 'wither') {
        const m = g.m, e = 1 - u * u;
        _m.compose(m.pos, m.quat, _s.set(m.s * e, m.s * e * e, m.s * e));
        m.sp.pool.set(m.i, _m);
        if (u >= 1) { m.sp.pool.release(m.i); this.mushrooms.splice(this.mushrooms.indexOf(m), 1); G2.splice(k, 1); }
        continue;
      }
      const e = 1 - Math.pow(1 - u, 3);
      if (g.kind === 'mush') {
        // stem pushes up first, then the cap opens
        const sy = g.s * (0.12 + 0.88 * e), sx = g.s * (0.3 + 0.7 * smooth(0.0, 0.8, u));
        _m.compose(g.pos, g.quat, _s.set(sx, sy, sx));
        if (u <= 0) _m.copy(ZERO);
        g.pool.setAttr('aOpen', g.i, smooth(0.45, 1.0, u));
      } else {
        const s = Math.max(1e-4, g.s * (g.kind === 'fern' ? 0.25 + 0.75 * e : e));
        _m.compose(g.pos, g.quat, _s.set(s, s, s));
        if (u <= 0) _m.copy(ZERO);
        if (g.kind === 'fern') g.pool.setAttr('aGrow', g.i, u * u * (3 - 2 * u));
      }
      g.pool.set(g.i, _m);
      if (u >= 1) G2.splice(k, 1);
    }
  }

  get mushroomCount() { return this.mushrooms.length; }
}
