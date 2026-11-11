// The underground network. Hyphae are grown tip by tip: each tip wanders,
// follows the scent of nearby food, branches, fuses with older threads and
// eventually tires. Threads that carry food thicken into cords; dead ends
// are slowly reabsorbed. Nothing here is keyframed.
import * as THREE from 'three';
import { noise3, clamp } from './noise.js';
import { R, DEPTH, topH, inside, outline } from './island.js';

const MAX = 20000;          // segment budget
const STEP = 0.036;         // length of one segment
const R_SIDE = 0.002, R_THIN = 0.0032, R_CORD = 0.0062;
const CELL = 0.14;
const GX = Math.ceil((R * 2.5) / CELL), GY = Math.ceil((DEPTH * 1.3 + 0.6) / CELL);
const OX = -R * 1.25, OY = -DEPTH * 1.3;
const MAX_TIPS = 220;

const ALIVE = 1, TIP = 2, HELD = 4, DYING = 8;

export const FOOD = {
  sap: { type: 0, color: new THREE.Color(1.0, 0.62, 0.18) },
  dew: { type: 1, color: new THREE.Color(0.25, 0.85, 1.0) },
};

export class Mycelium {
  constructor(rnd, hooks) {
    this.rnd = rnd;
    this.hooks = hooks; // { deposit(x,z,w), fertilize(x,z,type,amt), onAbsorbed(src), onLanded(src) }
    this.px = new Float32Array(MAX); this.py = new Float32Array(MAX); this.pz = new Float32Array(MAX);
    this.parent = new Int32Array(MAX).fill(-1);
    this.kids = new Uint8Array(MAX);
    this.rad = new Float32Array(MAX);
    this.birth = new Float32Array(MAX);
    this.lastAct = new Float32Array(MAX).fill(-1e6);
    this.pathD = new Float32Array(MAX);
    this.flags = new Uint8Array(MAX);
    this.gNext = new Int32Array(MAX).fill(-1);
    this.gHead = new Int32Array(GX * GY * GX).fill(-1);
    this.free = [];
    this.hw = 0;         // high-water mark
    this.alive = 0;
    this.tips = [];
    this.dying = [];
    this.sources = [];
    this.energy = 1.2;   // amber reserve
    this.lumen = 0;      // blue reserve
    this.bankSap = 0.6; this.bankDew = 0; // set aside for fruiting
    this.totalLength = 0;
    this.moteTimer = 0;

    // instanced ribbons
    this.aStart = new Float32Array(MAX * 3); this.aEnd = new Float32Array(MAX * 3);
    this.aRad = new Float32Array(MAX * 2);
    this.aInfo = new Float32Array(MAX * 4);  // birth, path distance, active-until, tint
    this.aLife = new Float32Array(MAX * 2);  // death time, flow direction
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([0, -1, 0, 1, -1, 0, 0, 1, 0, 1, 1, 0], 3));
    g.setIndex([0, 1, 2, 2, 1, 3]);
    const ia = (arr, n) => { const a = new THREE.InstancedBufferAttribute(arr, n); a.setUsage(THREE.DynamicDrawUsage); return a; };
    g.setAttribute('aStart', this.attrStart = ia(this.aStart, 3));
    g.setAttribute('aEnd', this.attrEnd = ia(this.aEnd, 3));
    g.setAttribute('aRad', this.attrRad = ia(this.aRad, 2));
    g.setAttribute('aInfo', this.attrInfo = ia(this.aInfo, 4));
    g.setAttribute('aLife', this.attrLife = ia(this.aLife, 2));
    g.instanceCount = 0;
    this.uniforms = {
      uTime: { value: 0 }, uWave: { value: 0 }, uPx: { value: 0.001 }, uCam: { value: new THREE.Vector3() },
      uCenterDist: { value: 8 }, uTopVis: { value: 0.3 }, uOut: { value: Array.from({ length: 32 }, (_, i) => outline((i / 32) * Math.PI * 2)) }, uIntensity: { value: 1 }, uLumenMix: { value: 0 },
    };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: /* glsl */ `
        attribute vec3 aStart, aEnd; attribute vec2 aRad; attribute vec4 aInfo; attribute vec2 aLife;
        uniform float uPx, uCenterDist, uTopVis; uniform vec3 uCam; uniform float uOut[32];
        varying float vV, vFade, vThick, vAlpha; varying vec4 vInfo; varying vec2 vLife;
        void main(){
          vec3 p = mix(aStart, aEnd, position.x);
          float r = mix(aRad.x, aRad.y, position.x);
          vec4 m0 = modelViewMatrix*vec4(aStart,1.0), m1 = modelViewMatrix*vec4(aEnd,1.0);
          vec4 mv = mix(m0, m1, position.x);
          vec3 d = m1.xyz - m0.xyz;
          vec3 side = normalize(cross(d, mv.xyz) + vec3(1e-6));
          float minR = uPx * -mv.z * 0.7;
          float rr = max(r, minR);
          vAlpha = clamp(r/rr, 0.18, 1.0);
          mv.xyz += normalize(d + vec3(1e-6))*(position.x*2.0-1.0)*rr*0.35;
          mv.xyz += side*position.y*rr*1.9;
          vV = position.y; vInfo = aInfo; vLife = aLife;
          vThick = clamp((r-${R_THIN})/${(R_CORD - R_THIN).toFixed(4)}, 0.0, 1.0);
          // dimmer on the far side of the island, and when seen through the mossy top
          float zrel = (-mv.z - uCenterDist)/${R.toFixed(2)};
          vFade = mix(1.0, 0.12, smoothstep(-0.9, 0.9, zrel));
          if (uCam.y > -0.05 && p.y < -0.1) {
            float t = (uCam.y + 0.1)/(uCam.y - p.y);
            vec3 q = uCam + t*(p - uCam);
            float oa = (atan(q.z, q.x)/6.2831853 + 1.0)*32.0; int o0 = int(mod(floor(oa), 32.0)), o1 = int(mod(floor(oa)+1.0, 32.0));
            float orad = mix(uOut[o0], uOut[o1], fract(oa));
            vFade *= mix(1.0, uTopVis, 1.0 - smoothstep(orad*0.97, orad*1.03, length(q.xz)));
          }
          gl_Position = projectionMatrix*mv;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime, uWave, uIntensity, uLumenMix;
        varying float vV, vFade, vThick, vAlpha; varying vec4 vInfo; varying vec2 vLife;
        void main(){
          float prof = exp(-vV*vV*4.5);
          float age = uTime - vInfo.x;
          float born = smoothstep(0.0, 0.45, age);
          float dying = 1.0 - smoothstep(0.0, 1.6, uTime - vLife.x);
          float act = clamp((vInfo.z - uTime)/1.2, 0.0, 1.0);
          float wave = pow(0.5 + 0.5*sin(vInfo.y*8.0 + vLife.y*uWave*6.0), 7.0);
          vec3 base = mix(vec3(0.95,0.82,0.58), vec3(0.55,0.9,1.0), uLumenMix);
          vec3 pc = mix(vec3(1.0,0.55,0.12), vec3(0.2,0.8,1.0), vInfo.w);
          vec3 col = base*(0.2 + 0.4*vThick);
          col += base*1.1*(1.0 - smoothstep(0.0, 3.0, age));       // fresh growth glows
          col += pc*act*(0.22 + 2.6*wave);                           // food in transit
          gl_FragColor = vec4(col*prof*born*dying*vFade*vAlpha*uIntensity, 1.0);
        }`,
      blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: false, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.geo = g;

    // food + heart as soft glowing points
    const NP = 128;
    this.pPos = new Float32Array(NP * 3); this.pCol = new Float32Array(NP * 3); this.pSize = new Float32Array(NP);
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.BufferAttribute(this.pPos, 3).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute('aColor', new THREE.BufferAttribute(this.pCol, 3).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute('aSize', new THREE.BufferAttribute(this.pSize, 1).setUsage(THREE.DynamicDrawUsage));
    this.pUniforms = { uScale: { value: 600 } };
    this.points = new THREE.Points(pg, new THREE.ShaderMaterial({
      uniforms: this.pUniforms,
      vertexShader: /* glsl */ `
        attribute vec3 aColor; attribute float aSize; uniform float uScale; varying vec3 vC;
        void main(){ vC = aColor; vec4 mv = modelViewMatrix*vec4(position,1.0);
          gl_PointSize = max(1.0, aSize*uScale/-mv.z); gl_Position = projectionMatrix*mv; }`,
      fragmentShader: /* glsl */ `
        varying vec3 vC;
        void main(){ float d = length(gl_PointCoord-0.5)*2.0; if(d>1.0) discard;
          float core = smoothstep(0.32, 0.05, d), halo = pow(1.0-d, 2.6);
          gl_FragColor = vec4(vC*(core*1.5 + halo*0.5), 1.0); }`,
      blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, transparent: false,
    }));
    this.points.frustumCulled = false;
    this.points.renderOrder = 1;

    // inoculate: a heart node with a handful of tips
    this.heart = new THREE.Vector3(0.15, -0.85, -0.1);
    const root = this._add(-1, this.heart.x, this.heart.y, this.heart.z, 0);
    this.flags[root] |= HELD;
    for (let i = 0; i < 8; i++) this._spawnTip(root, this._randDir(), 160 + rnd() * 120);
    for (let i = 0; i < 44; i++) this._addMote();
  }

  // ---------------------------------------------------------- bookkeeping --

  _cell(x, y, z) {
    const ix = clamp(((x - OX) / CELL) | 0, 0, GX - 1), iy = clamp(((y - OY) / CELL) | 0, 0, GY - 1), iz = clamp(((z - OX) / CELL) | 0, 0, GX - 1);
    return (iy * GX + iz) * GX + ix;
  }

  _add(par, x, y, z, t) {
    const id = this.free.length ? this.free.pop() : (this.hw < MAX ? this.hw++ : -1);
    if (id < 0) return -1;
    this.px[id] = x; this.py[id] = y; this.pz[id] = z;
    this.parent[id] = par; this.kids[id] = 0; this.rad[id] = R_THIN;
    this.birth[id] = t; this.lastAct[id] = -1e6; this.flags[id] = ALIVE;
    const c = this._cell(x, y, z); this.gNext[id] = this.gHead[c]; this.gHead[c] = id;
    const i3 = id * 3, i2 = id * 2, i4 = id * 4;
    if (par >= 0) {
      this.kids[par]++;
      this.pathD[id] = this.pathD[par] + STEP;
      this.aStart[i3] = this.px[par]; this.aStart[i3 + 1] = this.py[par]; this.aStart[i3 + 2] = this.pz[par];
      this.aRad[i2] = Math.min(this.rad[par], R_THIN * 1.6); this.aRad[i2 + 1] = R_THIN;
      this.totalLength += STEP;
    } else {
      this.pathD[id] = 0;
      this.aStart[i3] = x; this.aStart[i3 + 1] = y; this.aStart[i3 + 2] = z;
      this.aRad[i2] = 0; this.aRad[i2 + 1] = 0;
    }
    this.aEnd[i3] = x; this.aEnd[i3 + 1] = y; this.aEnd[i3 + 2] = z;
    this.aInfo[i4] = t; this.aInfo[i4 + 1] = this.pathD[id]; this.aInfo[i4 + 2] = -1e6; this.aInfo[i4 + 3] = 0;
    this.aLife[i2] = 1e9; this.aLife[i2 + 1] = 1;
    this.alive++;
    this.dirty = true;
    const dep = topH(x, z) - y;
    if (dep < 0.9) this.hooks.deposit(x, z, 1 - dep / 0.9);
    return id;
  }

  _kill(id, t) {
    this.flags[id] = DYING;
    this.aLife[id * 2] = t;
    this.dying.push(id, t + 1.8);
    const par = this.parent[id];
    if (par >= 0 && this.kids[par] > 0) this.kids[par]--;
    const c = this._cell(this.px[id], this.py[id], this.pz[id]);
    let j = this.gHead[c], prev = -1;
    while (j >= 0) {
      if (j === id) { if (prev < 0) this.gHead[c] = this.gNext[j]; else this.gNext[prev] = this.gNext[j]; break; }
      prev = j; j = this.gNext[j];
    }
    const dep = topH(this.px[id], this.pz[id]) - this.py[id];
    if (dep < 0.9) this.hooks.deposit(this.px[id], this.pz[id], -(1 - dep / 0.9));
    this.alive--; this.totalLength -= STEP;
    this.dirty = true;
  }

  _randDir() {
    const r = this.rnd, u = r() * 2 - 1, a = r() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    return [s * Math.cos(a), u * 0.6, s * Math.sin(a)];
  }

  _spawnTip(node, d, stamina, lead = true) {
    if (this.tips.length >= MAX_TIPS) return;
    const l = Math.hypot(d[0], d[1], d[2]) || 1;
    this.flags[node] |= TIP;
    this.tips.push({ n: node, dx: d[0] / l, dy: d[1] / l, dz: d[2] / l, stamina, lead, seed: this.rnd() * 100 });
  }

  _addMote() {
    const r = this.rnd;
    for (let k = 0; k < 20; k++) {
      const a = r() * Math.PI * 2, rr = R * Math.sqrt(r()) * 0.95;
      const x = rr * Math.cos(a), z = rr * Math.sin(a), y = topH(x, z) - (0.14 + r() * r() * 1.25);
      if (!inside(x, y, z, 0.12)) continue;
      this.sources.push({ x, y, z, amt: 0.15 + r() * 0.22, amt0: 0.37, type: 0, mote: true, active: true, node: -1, sense: 0.5, pull: 0.5, born: -1 });
      return;
    }
  }

  /** Drop food. `from` is where it appears; it then travels to `to` before the network can smell it. */
  addFood(type, from, surface, to, t) {
    this.sources.push({
      x: from.x, y: from.y, z: from.z, amt: 10, amt0: 10, type, mote: false, active: false, node: -1,
      sense: 1.9, pull: 2.2, born: t, anim: { t: 0, from: from.clone(), surface: surface.clone(), to: to.clone(), landed: false },
    });
  }

  _markPath(node, t, tint, dir, amount) {
    let n = node, child = -1, guard = 0;
    const until = t + 1.6;
    while (n >= 0 && guard++ < 4000) {
      this.lastAct[n] = t;
      const r = this.rad[n] = Math.min(R_CORD, this.rad[n] + amount * 0.00035);
      this.aRad[n * 2 + 1] = r;
      if (child >= 0) this.aRad[child * 2] = r;
      const i4 = n * 4;
      this.aInfo[i4 + 2] = until;
      this.aInfo[i4 + 3] += (tint - this.aInfo[i4 + 3]) * 0.25;
      this.aLife[n * 2 + 1] = dir;
      child = n; n = this.parent[n];
    }
    this.dirty = true;
  }

  /** A living node close to the surface, for fruiting. */
  pickShallowNode(maxDepth = 0.4) {
    for (let k = 0; k < 40; k++) {
      const id = (this.rnd() * this.hw) | 0;
      if ((this.flags[id] & ALIVE) === 0) continue;
      if (topH(this.px[id], this.pz[id]) - this.py[id] < maxDepth) return id;
    }
    return -1;
  }
  nodePos(id, out) { return out.set(this.px[id], this.py[id], this.pz[id]); }
  /** Send a pulse of food from the heart out to a node (used when something fruits). */
  feedNode(id, t, tint) { this._markPath(id, t, tint, -1, 1.2); }

  // ----------------------------------------------------------------- tick --

  tick(dt, t) {
    const rnd = this.rnd, S = this.sources;
    let total = this.energy + this.lumen;

    // food in flight, and absorption of food the network has reached
    for (let i = S.length - 1; i >= 0; i--) {
      const s = S[i];
      if (s.anim) {
        const a = s.anim; a.t += dt;
        const fall = 0.55, sink = 1.5;
        if (a.t < fall) {
          const k = a.t / fall; s.x = a.from.x + (a.surface.x - a.from.x) * k; s.z = a.from.z + (a.surface.z - a.from.z) * k;
          s.y = a.from.y + (a.surface.y - a.from.y) * k * k;
        } else {
          if (!a.landed) { a.landed = true; this.hooks.onLanded(s, a.surface); }
          let k = Math.min(1, (a.t - fall) / sink); k = 1 - (1 - k) * (1 - k);
          s.x = a.surface.x + (a.to.x - a.surface.x) * k; s.y = a.surface.y + (a.to.y - a.surface.y) * k; s.z = a.surface.z + (a.to.z - a.surface.z) * k;
          if (a.t >= fall + sink) { s.anim = null; s.active = true; }
        }
        continue;
      }
      if (s.node >= 0) {
        if ((this.flags[s.node] & ALIVE) === 0) { s.node = -1; continue; }
        const take = Math.min(s.amt, (s.mote ? 0.12 : 0.85) * dt);
        s.amt -= take;
        if (s.type) { this.lumen += take; this.bankDew += take * 0.62; } else { this.energy += take; this.bankSap += take * 0.62; }
        this._markPath(s.node, t, s.type, 1, take);
        this.hooks.fertilize(s.x, s.z, s.type, take * (s.mote ? 0.6 : 1));
        if (s.amt <= 1e-4) {
          this.flags[s.node] &= ~HELD;
          if (!s.mote) this.hooks.onAbsorbed(s);
          S.splice(i, 1);
        }
      }
    }

    // Leaders are the long exploring hyphae; each sheds short side branches that
    // give the web its feathery look and are the first to be reabsorbed.
    const wantLead = Math.min(40, 5 + total * 3.2);
    const vigor = clamp(total / 6, 0, 1);
    const pGrow = 0.3 + 0.6 * vigor;
    let leaders = 0;
    for (const tp of this.tips) if (tp.lead) leaders++;

    for (let i = this.tips.length - 1; i >= 0; i--) {
      const tip = this.tips[i], lead = tip.lead;
      if (rnd() > pGrow) continue;
      const n = tip.n, x = this.px[n], y = this.py[n], z = this.pz[n];
      // wander: leaders hold their course, side branches jitter
      const f = 1.6, sd = tip.seed, wn = lead ? 0.13 : 0.05, wj = lead ? 0.2 : 0.36;
      let ax = tip.dx + wn * noise3(x * f + sd, y * f, z * f) + (rnd() - 0.5) * wj;
      let ay = tip.dy + wn * 0.8 * noise3(x * f, y * f + sd, z * f + 31) + (rnd() - 0.5) * wj * 0.8;
      let az = tip.dz + wn * noise3(x * f + 57, y * f, z * f + sd) + (rnd() - 0.5) * wj;
      // follow the scent of food
      let near = 0, hit = null;
      for (let k = 0; k < S.length; k++) {
        const s = S[k];
        if (!s.active || (s.mote && s.node >= 0)) continue;
        const dx = s.x - x, dy = s.y - y, dz = s.z - z, d = Math.hypot(dx, dy, dz);
        if (d > s.sense) continue;
        let w = s.pull * ((1 - d / s.sense) * 0.16 + 4.0 * Math.max(0, 1 - d / 0.36));
        if (s.node >= 0) w *= 0.4;
        if (!lead) w *= 0.5;
        ax += (dx / d) * w; ay += (dy / d) * w; az += (dz / d) * w;
        near = Math.max(near, 1 - d / s.sense);
        if (d < 0.075 && s.node < 0) hit = s;
      }
      // stay in the root zone
      const dep = topH(x, z) - y;
      if (dep < 0.14) ay -= 0.6; else if (dep > 1.3) ay += 0.5 * (dep - 1.3);
      let l = Math.hypot(ax, ay, az) || 1; ax /= l; ay /= l; az /= l;
      let nx = x + ax * STEP, ny = y + ay * STEP, nz = z + az * STEP, ok = inside(nx, ny, nz, 0.07);
      for (let tries = 0; !ok && lead && tries < 5; tries++) {
        const hr = Math.hypot(x, z) || 1;
        ax = ax * 0.3 - (x / hr) * 0.9 + (rnd() - 0.5) * 0.8;
        ay = ay * 0.3 + (dep < 0.2 ? -0.8 : dep > 1.2 ? 0.8 : 0) + (rnd() - 0.5) * 0.8;
        az = az * 0.3 - (z / hr) * 0.9 + (rnd() - 0.5) * 0.8;
        l = Math.hypot(ax, ay, az) || 1; ax /= l; ay /= l; az /= l;
        nx = x + ax * STEP; ny = y + ay * STEP; nz = z + az * STEP; ok = inside(nx, ny, nz, 0.07);
      }
      const drop = () => { this.flags[tip.n] &= ~TIP; this.tips.splice(i, 1); };
      if (!ok) { drop(); continue; }

      // fuse with an older thread (anastomosis)
      if (!hit && this._nearOther(nx, ny, nz, n) && rnd() < (lead ? 0.35 : 0.8)) { drop(); continue; }

      const id = this._add(n, nx, ny, nz, t);
      if (id < 0) continue; // budget full; wait for pruning
      this.flags[n] &= ~TIP; this.flags[id] |= TIP;
      tip.n = id; tip.dx = ax; tip.dy = ay; tip.dz = az;
      if (!lead) { this.rad[id] = R_SIDE; this.aRad[id * 2 + 1] = R_SIDE; this.aRad[id * 2] = Math.min(this.aRad[id * 2], R_THIN); }

      // metabolism
      tip.stamina -= 1;
      if (total > 0.02) {
        const cost = 0.0021, fe = this.energy / total;
        this.energy = Math.max(0, this.energy - cost * fe); this.lumen = Math.max(0, this.lumen - cost * (1 - fe));
        total = this.energy + this.lumen;
        if (lead) tip.stamina += 0.93;
      }
      if (hit) {
        hit.node = id; this.flags[id] |= HELD;
        tip.stamina += 60; tip.lead = true;
        if (!hit.mote) for (let b = 0; b < 4; b++) this._spawnTip(id, this._randDir(), 14 + rnd() * 22, false);
      }
      if (tip.stamina <= 0) { drop(); continue; }
      if (!lead) { if (near > 0.6 && rnd() < 0.04) { tip.lead = true; tip.stamina += 60; } continue; }
      // fork into a second leader
      if (leaders < wantLead && rnd() < 0.014 + 0.05 * near + 0.07 * vigor) {
        const d = this._randDir();
        this._spawnTip(id, [ax + d[0] * 0.6, ay + d[1] * 0.6, az + d[2] * 0.6], 60 + rnd() * 110, true);
        leaders++;
      }
      // shed a side branch
      if (rnd() < 0.1) {
        const d = this._randDir();
        this._spawnTip(id, [ax * 0.75 + d[0], ay * 0.75 + d[1], az * 0.75 + d[2]], 6 + rnd() * 16, false);
      }
    }

    // keep foraging even when hungry: sprout from somewhere in the web
    const floor = Math.max(6, wantLead * 0.6);
    for (let k = 0; leaders < floor && k < 6; k++) {
      const id = (rnd() * this.hw) | 0;
      if ((this.flags[id] & (ALIVE | TIP)) !== ALIVE) continue;
      this._spawnTip(id, this._randDir(), 80 + rnd() * 120, true);
      leaders++;
    }

    // reabsorb idle dead ends; faster when the soil is crowded
    const fill = this.alive / MAX, pKill = 0.035 + 0.965 * fill * fill;
    for (let k = 0; k < 90; k++) {
      const id = (rnd() * this.hw) | 0;
      if (this.flags[id] !== ALIVE || this.kids[id] !== 0) continue;
      if (t - this.birth[id] < 40 || t - this.lastAct[id] < 30 || this.rad[id] > 0.0045) continue;
      if (rnd() < pKill) this._kill(id, t);
    }
    while (this.dying.length && this.dying[1] <= t) {
      const id = this.dying.shift(); this.dying.shift();
      this.flags[id] = 0; this.aRad[id * 2] = 0; this.aRad[id * 2 + 1] = 0;
      this.free.push(id); this.dirty = true;
    }

    // organic debris keeps appearing in the soil
    this.moteTimer += dt;
    if (this.moteTimer > 5) { this.moteTimer = 0; let m = 0; for (const s of S) if (s.mote) m++; if (m < 44) this._addMote(); }

    // upkeep
    this.energy *= 1 - 0.006 * dt; this.lumen *= 1 - 0.004 * dt;
  }

  _nearOther(x, y, z, self) {
    const ix = ((x - OX) / CELL) | 0, iy = ((y - OY) / CELL) | 0, iz = ((z - OX) / CELL) | 0;
    const lim = 0.024 * 0.024;
    for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const cx = ix + dx, cy = iy + dy, cz = iz + dz;
      if (cx < 0 || cy < 0 || cz < 0 || cx >= GX || cy >= GY || cz >= GX) continue;
      let j = this.gHead[(cy * GX + cz) * GX + cx];
      while (j >= 0) {
        const ex = this.px[j] - x, ey = this.py[j] - y, ez = this.pz[j] - z;
        if (ex * ex + ey * ey + ez * ez < lim) {
          let a = self, rel = false;
          for (let g = 0; g < 14 && a >= 0; g++) { if (a === j) { rel = true; break; } a = this.parent[a]; }
          if (!rel) return true;
        }
        j = this.gNext[j];
      }
    }
    return false;
  }

  // --------------------------------------------------------------- render --

  sync(t, real, nightAmt) {
    if (this.dirty) {
      this.attrStart.needsUpdate = this.attrEnd.needsUpdate = this.attrRad.needsUpdate = true;
      this.attrInfo.needsUpdate = this.attrLife.needsUpdate = true;
      this.geo.instanceCount = this.hw;
      this.dirty = false;
    }
    const U = this.uniforms, total = this.energy + this.lumen;
    U.uTime.value = t; U.uWave.value = real;
    U.uLumenMix.value += (clamp(this.lumen / (total + 1.5), 0, 1) - U.uLumenMix.value) * 0.02;

    // heart first, then every piece of food
    const P = this.pPos, C = this.pCol, Z = this.pSize;
    const beat = 0.85 + 0.15 * Math.sin(real * 1.7) + 0.06 * Math.sin(real * 3.4);
    const hm = U.uLumenMix.value, hs = clamp(total / 12, 0, 1);
    P[0] = this.heart.x; P[1] = this.heart.y; P[2] = this.heart.z;
    C[0] = (1.0 - 0.6 * hm) * (0.5 + hs); C[1] = (0.72 + 0.15 * hm) * (0.5 + hs); C[2] = (0.4 + 0.6 * hm) * (0.5 + hs);
    Z[0] = (0.16 + 0.14 * hs) * beat;
    let n = 1;
    for (const s of this.sources) {
      if (n >= Z.length) break;
      const k = s.amt / s.amt0, i3 = n * 3;
      P[i3] = s.x; P[i3 + 1] = s.y; P[i3 + 2] = s.z;
      if (s.mote) {
        const tw = 0.6 + 0.4 * Math.sin(real * 1.3 + s.x * 9 + s.z * 7);
        C[i3] = 0.5 * tw; C[i3 + 1] = 0.36 * tw; C[i3 + 2] = 0.16 * tw; Z[n] = 0.035 + 0.03 * k;
      } else {
        const c = s.type ? FOOD.dew.color : FOOD.sap.color, p = 1.0 + 0.25 * Math.sin(real * 4 + s.born);
        C[i3] = c.r * p; C[i3 + 1] = c.g * p; C[i3 + 2] = c.b * p; Z[n] = 0.08 + 0.13 * Math.sqrt(k);
      }
      n++;
    }
    const pg = this.points.geometry;
    pg.attributes.position.needsUpdate = pg.attributes.aColor.needsUpdate = pg.attributes.aSize.needsUpdate = true;
    pg.setDrawRange(0, n);
  }
}
