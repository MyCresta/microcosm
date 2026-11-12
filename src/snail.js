// A moss-backed snail that wanders the surface. It steers around rocks, the log
// and mushrooms, heads for any food it is given, and leaves richer ground behind
// it. Whatever it last ate is carried in its trail for a while.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { noise3, clamp, smooth } from './noise.js';
import { patchStandard } from './glsl.js';
import { topH, outline, blocked } from './island.js';

export const FOOD = {
  sap: { type: 0, color: new THREE.Color(1.0, 0.62, 0.18) },
  dew: { type: 1, color: new THREE.Color(0.25, 0.85, 1.0) },
};
const COLORS = [FOOD.sap.color, FOOD.dew.color];
const SIZE = 0.46, TAU = Math.PI * 2;
const SPEED_WANDER = 0.05, SPEED_SEEK = 0.085, EAT_DIST = 0.15;

// ------------------------------------------------------------ geometry ----

function shellGeo() {
  const N = 120, S = 14, T = TAU * 2.8, b = 0.17, RMAX = 0.125, C = 0.62, PHI_END = -0.9;
  const pos = [], sh = [], idx = [];
  for (let i = 0; i <= N + 1; i++) {
    const s = Math.min(1, i / N), th = s * T, R = RMAX * Math.exp(-b * (T - th));
    const rho = i > N ? 0 : C * R, phi = PHI_END - (T - th);
    const cx = R * Math.cos(phi), cy = R * Math.sin(phi), cz = 0.6 * (RMAX - R);
    for (let j = 0; j <= S; j++) {
      const a = (j / S) * TAU;
      pos.push(cx + rho * Math.cos(a) * Math.cos(phi), cy + rho * Math.cos(a) * Math.sin(phi), cz + rho * Math.sin(a) * 1.05);
      sh.push(s, j / S);
    }
  }
  for (let i = 0; i <= N; i++) for (let j = 0; j < S; j++) {
    const a = i * (S + 1) + j, c = a + S + 1;
    idx.push(a, c, a + 1, a + 1, c, c + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aSh', new THREE.Float32BufferAttribute(sh, 2));
  g.setIndex(idx); g.computeVertexNormals();
  return g;
}

function bodyGeo() {
  const parts = [];
  const finish = (g, tent, base) => { // tent: fn(i) -> [isTentacle, t]
    const n = g.attributes.position.count, at = new Float32Array(n * 2), ab = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const tt = tent(i); at[i * 2] = tt[0]; at[i * 2 + 1] = tt[1];
      ab[i * 3] = base ? base.x : 0; ab[i * 3 + 1] = base ? base.y : 0; ab[i * 3 + 2] = base ? base.z : 0;
    }
    g.setAttribute('aTent', new THREE.BufferAttribute(at, 2));
    g.setAttribute('aBase', new THREE.BufferAttribute(ab, 3));
    parts.push(g);
  };
  const grid = (pos, rows, S) => {
    const idx = [];
    for (let i = 0; i < rows - 1; i++) for (let j = 0; j < S; j++) {
      const a = i * (S + 1) + j, c = a + S + 1;
      idx.push(a, c, a + 1, a + 1, c, c + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    return g;
  };

  { // the foot: a flattened, tapering body with a hump under the shell and a raised head
    const N = 30, S = 14, pos = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N, x = -0.42 + 0.92 * t;
      const w = 0.01 + 0.095 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.85)), 0.55) * (0.72 + 0.28 * t);
      const h = 0.01 + 0.06 * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.9)), 0.5) + 0.15 * Math.exp(-Math.pow((x + 0.04) / 0.15, 2));
      const lift = 0.065 * smooth(0.72, 1, t);
      for (let j = 0; j <= S; j++) {
        const a = (j / S) * TAU, sn = Math.sin(a), cs = Math.cos(a);
        pos.push(x, lift + (sn > 0 ? h * sn : 0.012 * sn), w * cs * (1 + 0.24 * (1 - Math.max(0, sn))));
      }
    }
    finish(grid(pos, N + 1, S), () => [0, 0], null);
  }

  const tentacle = (base, dir, len, r0, bulb) => {
    const K = 6, S = 6, pos = [];
    const d = dir.clone().normalize(), u = new THREE.Vector3().crossVectors(d, new THREE.Vector3(0, 0, 1)).normalize(), v = new THREE.Vector3().crossVectors(d, u);
    const at = (t) => base.clone().addScaledVector(d, len * t).add(new THREE.Vector3(0, 0.02 * t * t * (len / 0.17), 0));
    for (let i = 0; i <= K; i++) {
      const t = i / K, c = at(t), r = r0 * (1 - 0.5 * t);
      for (let j = 0; j <= S; j++) {
        const a = (j / S) * TAU;
        pos.push(c.x + (u.x * Math.cos(a) + v.x * Math.sin(a)) * r, c.y + (u.y * Math.cos(a) + v.y * Math.sin(a)) * r, c.z + (u.z * Math.cos(a) + v.z * Math.sin(a)) * r);
      }
    }
    finish(grid(pos, K + 1, S), (i) => [1, Math.floor(i / (S + 1)) / K], base);
    const tip = at(1), sg = new THREE.SphereGeometry(bulb, 8, 6);
    sg.deleteAttribute('uv'); sg.deleteAttribute('normal'); sg.translate(tip.x, tip.y, tip.z);
    finish(sg, () => [1, 1], base);
  };
  for (const s of [-1, 1]) {
    tentacle(new THREE.Vector3(0.44, 0.092, s * 0.03), new THREE.Vector3(0.5, 0.8, s * 0.28), 0.17, 0.011, 0.0145);
    tentacle(new THREE.Vector3(0.475, 0.075, s * 0.024), new THREE.Vector3(0.9, -0.15, s * 0.4), 0.05, 0.008, 0.0085);
  }
  const g = mergeGeometries(parts);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------- snail ----

const _n = new THREE.Vector3(), _f = new THREE.Vector3(), _r = new THREE.Vector3(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3();

export class Snail {
  constructor(eco, atm, U, rnd) {
    this.eco = eco; this.atm = atm; this.rnd = rnd;
    this.u = { uTime: U.uTime, uNight: U.uNight, uMove: { value: 0 }, uHide: { value: 0 }, uGlow: { value: 0 } };

    const bodyMat = patchStandard(new THREE.MeshStandardMaterial({ roughness: 0.3, side: THREE.DoubleSide }), 'snail-body', {
      vertPars: 'attribute vec2 aTent; attribute vec3 aBase; uniform float uTime, uMove, uHide; varying vec2 vTent;',
      vert: /* glsl */ `
        if (aTent.x > 0.5) {
          transformed = mix(transformed, aBase, uHide*0.94);
          float sw = aTent.y*aTent.y*(1.0 - uHide);
          transformed.z += sin(uTime*1.7 + aBase.z*40.0)*0.014*sw;
          transformed.y += sin(uTime*1.3 + aBase.z*31.0)*0.009*sw;
        } else {
          transformed.y *= 1.0 + 0.06*sin(position.x*15.0 - uTime*5.0)*uMove;   // the foot ripples as it glides
        }
        vTent = aTent;`,
      fragPars: 'varying vec2 vTent;',
      color: /* glsl */ `
        vec4 svo = voro3(vPos*vec3(24.0, 30.0, 30.0));
        float sn = fbm(vPos*7.0);
        vec3 scol = mix(vec3(0.15,0.11,0.08), vec3(0.33,0.26,0.19), sn);
        scol *= 0.86 + 0.22*smoothstep(0.1, 0.5, svo.x);
        scol = mix(scol, vec3(0.56,0.49,0.38), (1.0 - smoothstep(0.0, 0.035, vPos.y))*0.65*(1.0 - vTent.x));
        scol = mix(scol, vec3(0.025), vTent.x*smoothstep(0.9, 1.0, vTent.y));
        diffuseColor.rgb = scol;`,
      normal: 'normal = bumpN(normal, smoothstep(0.1, 0.5, svo.x), 0.004);',
    }, this.u);

    const shellMat = patchStandard(new THREE.MeshStandardMaterial({ roughness: 0.32, side: THREE.DoubleSide }), 'snail-shell', {
      vertPars: 'attribute vec2 aSh; varying vec2 vSh;',
      vert: 'vSh = aSh;',
      fragPars: 'varying vec2 vSh; uniform float uGlow, uNight, uTime;',
      color: /* glsl */ `
        float ss = vSh.x, sa = vSh.y;
        float rfade = clamp(1.0 - fwidth(ss*520.0)/2.5, 0.0, 1.0);
        float ridges = sin(ss*520.0)*rfade;
        float band = (1.0 - smoothstep(0.0, 0.055, abs(sa - 0.2))) + 0.7*(1.0 - smoothstep(0.0, 0.035, abs(sa - 0.36))) + 0.8*(1.0 - smoothstep(0.0, 0.05, abs(sa - 0.8)));
        float shn = fbm(vPos*9.0);
        vec3 shc = mix(vec3(0.60,0.44,0.24), vec3(0.83,0.70,0.46), shn);
        shc = mix(shc, vec3(0.20,0.105,0.05), clamp(band, 0.0, 1.0)*0.85);
        shc *= 0.88 + 0.12*ridges;
        shc = mix(vec3(0.27,0.17,0.10), shc, smoothstep(0.0, 0.4, ss));
        float shMoss = smoothstep(0.5, 0.85, vWN.y + (fbm(vPos*16.0) - 0.5)*1.1)*0.85;
        shc = mix(shc, mix(vec3(0.05,0.11,0.03), vec3(0.2,0.33,0.07), dnoise(vPos, 70.0)), shMoss);
        diffuseColor.rgb = shc;`,
      rough: 'roughnessFactor = mix(0.3, 0.95, shMoss);',
      normal: 'normal = bumpN(normal, ridges*0.4 + band*0.6 + shMoss, 0.004);',
      emissive: 'totalEmissiveRadiance += vec3(0.12,0.85,1.0)*uGlow*(clamp(band,0.0,1.0)*1.6 + 0.06)*(1.0 - shMoss)*(0.8 + 0.2*sin(uTime*2.0))*mix(0.5, 1.7, uNight);',
    }, this.u);

    this.group = new THREE.Group();
    this.group.scale.setScalar(SIZE);
    this.body = new THREE.Mesh(bodyGeo(), bodyMat);
    this.shellPivot = new THREE.Group();
    this.shellPivot.position.set(-0.08, 0.33, 0);
    this.shellPivot.scale.setScalar(1.45);
    this.shell = new THREE.Mesh(shellGeo(), shellMat);
    this.shell.rotation.x = 0.32;
    this.shellPivot.add(this.shell);
    this.group.add(this.body, this.shellPivot);
    for (const m of [this.body, this.shell]) { m.castShadow = m.receiveShadow = true; m.renderOrder = 2; }

    // food beads
    this.foods = [];
    this.beads = [];
    const sg = new THREE.SphereGeometry(1, 18, 12);
    this.foodGroup = new THREE.Group();
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(sg, new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.15, emissive: 0xffffff, emissiveIntensity: 2 }));
      m.visible = false; m.renderOrder = 2; this.foodGroup.add(m); this.beads.push(m);
    }

    // start somewhere open
    this.x = -0.35; this.z = -0.7; this.heading = 0.6;
    for (let k = 0; k < 60 && blocked(eco.obstacles, this.x, this.z, 0.2); k++) { this.x = (rnd() - 0.5) * 2.4; this.z = (rnd() - 0.5) * 2.4; }
    this.seed = rnd() * 100; this.wanderA = this.heading;
    this.moving = 0; this.hideT = 0; this.hide = 0; this.carry = [0, 0];
    this.goal = null; this.bestD = 1e9; this.stuckT = 0; this.eaten = 0;
    this.group.position.set(this.x, topH(this.x, this.z), this.z);
  }

  near(x, z) { return Math.hypot(x - this.x, z - this.z) < 0.22; }
  startle() { this.hideT = 3.5; }

  addFood(type, x, z, t) {
    for (const o of this.eco.obstacles) { // never inside a rock or the log
      const d = Math.hypot(x - o.x, z - o.z) || 1e-3;
      if (d < o.r + 0.1) { x = o.x + ((x - o.x) / d) * (o.r + 0.12); z = o.z + ((z - o.z) / d) * (o.r + 0.12); }
    }
    const r = Math.hypot(x, z), lim = outline(Math.atan2(z, x)) * 0.9;
    if (r > lim) { x *= lim / r; z *= lim / r; }
    if (this.foods.length >= this.beads.length) this._remove(this.foods[0]);
    const mesh = this.beads.find((b) => !b.visible);
    mesh.visible = true; mesh.material.emissive.copy(COLORS[type]);
    this.foods.push({ type, x, z, y: topH(x, z) + 0.04, amt: 10, amt0: 10, fall: 0, landed: false, skipUntil: 0, mesh, born: t });
  }

  _remove(f) { f.mesh.visible = false; this.foods.splice(this.foods.indexOf(f), 1); if (this.goal === f) this.goal = null; }

  tick(dt, t) {
    const eco = this.eco, obs = eco.obstacles;
    for (const f of this.foods) {
      if (f.landed) continue;
      f.fall += dt;
      if (f.fall >= 0.5) { f.landed = true; this.atm.ripple(_p.set(f.x, f.y - 0.04, f.z), COLORS[f.type]); }
    }
    eco.bankSap += 0.02 * dt;
    if (this.hideT > 0) { this.hideT -= dt; this.moving = 0; return; }

    // nearest food it has not given up on
    let goal = null, gd = 1e9;
    for (const f of this.foods) {
      if (!f.landed || t < f.skipUntil) continue;
      const d = Math.hypot(f.x - this.x, f.z - this.z);
      if (d < gd) { gd = d; goal = f; }
    }
    if (goal !== this.goal) { this.goal = goal; this.bestD = 1e9; this.stuckT = 0; }

    let dx, dz;
    if (goal) { dx = (goal.x - this.x) / gd; dz = (goal.z - this.z) / gd; }
    else { this.wanderA += noise3(t * 0.11, this.seed, 1.7) * 0.5 * dt; dx = Math.cos(this.wanderA); dz = Math.sin(this.wanderA); }

    if (goal && gd < EAT_DIST) { // eat
      const take = Math.min(goal.amt, 1.6 * dt);
      goal.amt -= take;
      eco.fertilize(goal.x, goal.z, goal.type, take);
      if (goal.type) eco.bankDew += take * 0.62; else eco.bankSap += take * 0.62;
      this.carry[goal.type] = Math.min(70, this.carry[goal.type] + take * 7);
      this._turn(Math.atan2(dz, dx), 1.2 * dt);
      this.moving = 0;
      if (goal.amt <= 1e-4) { this.atm.puff(_p.set(goal.x, goal.y + 0.03, goal.z), COLORS[goal.type], 22); this._remove(goal); this.eaten++; }
      return;
    }

    // steer around things: pushed away, and slid sideways toward where it wants to go
    let px = 0, pz = 0;
    const repel = (ox, oz, r, margin, strength) => {
      const ex = this.x - ox, ez = this.z - oz, d = Math.hypot(ex, ez) || 1e-3;
      if (d > r + margin) return;
      const k = Math.min(1.5, (r + margin - d) / margin), nx = ex / d, nz = ez / d;
      px += nx * k * strength; pz += nz * k * strength;
      const side = -nz * dx + nx * dz >= 0 ? 1 : -1;
      px += -nz * side * k * strength * 0.8; pz += nx * side * k * strength * 0.8;
    };
    for (const o of obs) repel(o.x, o.z, o.r, 0.2, 1.7);
    for (const m of eco.mushrooms) if (m.sp.name !== 'pin') repel(m.x, m.z, 0.05, 0.12, 1.2);
    for (const f of eco.spots.fern) repel(f[0], f[1], 0.07, 0.13, 1.2);
    for (const l of eco.spots.lantern) repel(l[0], l[1], 0.03, 0.1, 1.0);
    const r = Math.hypot(this.x, this.z) || 1e-3, q = r / outline(Math.atan2(this.z, this.x));
    if (q > 0.76) { const k = (q - 0.76) / 0.1; px -= (this.x / r) * k * 2.2; pz -= (this.z / r) * k * 2.2; }

    const diff = this._turn(Math.atan2(dz + pz, dx + px), 1.1 * dt);
    if (!goal && px * px + pz * pz > 0.08) this.wanderA = this.heading; // carry on the way it was turned
    const speed = (goal ? SPEED_SEEK : SPEED_WANDER) * clamp(Math.cos(diff), 0.12, 1);
    const nx = this.x + Math.cos(this.heading) * speed * dt, nz = this.z + Math.sin(this.heading) * speed * dt;
    const nq = Math.hypot(nx, nz) / outline(Math.atan2(nz, nx));
    if (blocked(obs, nx, nz, 0.06) || nq > 0.9) { this.heading += 0.9 * dt; this.wanderA = this.heading; this.moving = 0.15; }
    else {
      this.x = nx; this.z = nz; this.moving = speed / SPEED_SEEK;
      // the trail: a little fertility, plus whatever it last ate
      eco.fertilize(this.x, this.z, 0, 0.13 * dt);
      if (this.carry[0] > 0) { this.carry[0] -= dt; eco.fertilize(this.x, this.z, 0, 0.3 * dt); }
      if (this.carry[1] > 0) { this.carry[1] -= dt; eco.fertilize(this.x, this.z, 1, 0.35 * dt); }
    }

    if (goal) { // give up on food it cannot get closer to, and come back to it later
      if (gd < this.bestD - 0.02) { this.bestD = gd; this.stuckT = 0; }
      else if ((this.stuckT += dt) > 10) { goal.skipUntil = t + 15; this.goal = null; }
    }
  }

  _turn(target, maxStep) {
    let diff = target - this.heading;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    this.heading += clamp(diff, -maxStep, maxStep);
    return diff;
  }

  frame(dt, real) {
    const k = Math.min(1, dt * 5), u = this.u;
    this.hide += ((this.hideT > 0 ? 1 : 0) - this.hide) * k;
    u.uHide.value = this.hide;
    u.uMove.value += (this.moving - u.uMove.value) * k;
    u.uGlow.value += (clamp(this.carry[1] / 20, 0, 1) - u.uGlow.value) * Math.min(1, dt * 1.5);

    // sit on the ground, tilted to the slope
    const e = 0.07, x = this.x, z = this.z;
    _n.set(topH(x - e, z) - topH(x + e, z), 2 * e, topH(x, z - e) - topH(x, z + e)).normalize();
    _f.set(Math.cos(this.heading), 0, Math.sin(this.heading)); _f.addScaledVector(_n, -_f.dot(_n)).normalize();
    _r.crossVectors(_f, _n);
    _q.setFromRotationMatrix(_m.makeBasis(_f, _n, _r));
    this.group.quaternion.slerp(_q, Math.min(1, dt * 6));
    this.group.position.set(x, topH(x, z) + 0.022, z);

    const mv = u.uMove.value;
    this.body.scale.set(1 - 0.42 * this.hide, 1 - 0.15 * this.hide, 1);
    this.body.position.x = -0.07 * this.hide;
    this.shellPivot.rotation.z = Math.sin(real * 2.1) * 0.035 * mv - 0.12 * this.hide;
    this.shellPivot.position.y = 0.33 - 0.05 * this.hide + Math.sin(real * 4.2) * 0.004 * mv;

    for (const f of this.foods) {
      const fk = Math.min(1, f.fall / 0.5), s = (0.022 + 0.034 * Math.sqrt(f.amt / f.amt0)) * (1 + 0.06 * Math.sin(real * 4 + f.born));
      f.mesh.position.set(f.x, f.y + 1.5 * (1 - fk * fk), f.z);
      f.mesh.scale.set(s, s * (f.landed ? 0.85 : 1.15), s);
    }
  }
}
