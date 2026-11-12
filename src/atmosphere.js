// Light, backdrop and air: a soft out-of-focus forest behind the diorama,
// drifting dust, fireflies after dark, spore puffs and small interaction effects.
import * as THREE from 'three';
import { NOISE } from './glsl.js';

const lerp = (a, b, t) => a + (b - a) * t;
const C = (r, g, b) => new THREE.Color(r, g, b);

const DAY = {
  sun: C(1.0, 0.92, 0.78), sunI: 3.3, sunDir: new THREE.Vector3(-4.2, 6.5, 3.4),
  sky: C(0.72, 0.9, 0.84), gnd: C(0.3, 0.22, 0.15), hemiI: 1.0, fill: C(0.5, 0.75, 0.9), fillI: 0.5,
  top: C(0.40, 0.55, 0.40), mid: C(0.10, 0.22, 0.18), bot: C(0.015, 0.04, 0.04),
  bokA: C(1.0, 0.86, 0.5), bokB: C(0.62, 0.95, 0.66), dust: C(1.0, 0.95, 0.8), exposure: 1.0, bloom: 0.42,
};
const NIGHT = {
  sun: C(0.5, 0.65, 1.0), sunI: 0.95, sunDir: new THREE.Vector3(3.6, 6.0, -2.8),
  sky: C(0.1, 0.16, 0.34), gnd: C(0.03, 0.035, 0.07), hemiI: 0.75, fill: C(0.2, 0.3, 0.6), fillI: 0.3,
  top: C(0.035, 0.06, 0.16), mid: C(0.02, 0.03, 0.09), bot: C(0.004, 0.006, 0.018),
  bokA: C(0.35, 0.55, 1.0), bokB: C(0.25, 0.95, 0.8), dust: C(0.5, 0.7, 1.0), exposure: 1.18, bloom: 0.85,
};

export class Atmosphere {
  constructor(scene, island, U) {
    this.U = U; this.night = 0; this.nightTarget = 0; this.dim = 0; this.dimTarget = 0;

    this.sun = new THREE.DirectionalLight(0xffffff, 3);
    this.sun.castShadow = true;
    const s = this.sun.shadow;
    s.mapSize.set(2048, 2048); s.camera.left = s.camera.bottom = -3.6; s.camera.right = s.camera.top = 3.6;
    s.camera.near = 1; s.camera.far = 22; s.bias = -0.0006; s.normalBias = 0.025; s.radius = 5;
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x222222, 1);
    this.fill = new THREE.DirectionalLight(0xffffff, 0.4);
    this.fill.position.set(4, 1.5, -5);
    scene.add(this.sun, this.sun.target, this.hemi, this.fill);

    // a few point lights that follow the brightest glowing growth
    this.glow = [];
    for (let i = 0; i < 2; i++) {
      const l = new THREE.PointLight(0x40e8ff, 0, 1.7, 1.8);
      island.add(l); this.glow.push(l);
    }

    // backdrop
    this.bgU = {
      uTop: { value: C(0, 0, 0) }, uMid: { value: C(0, 0, 0) }, uBot: { value: C(0, 0, 0) },
      uBokA: { value: C(0, 0, 0) }, uBokB: { value: C(0, 0, 0) }, uBokeh: { value: null }, uSun: { value: new THREE.Vector3() }, uSunC: { value: C(0, 0, 0) },
    };
    const bg = new THREE.Mesh(new THREE.SphereGeometry(70, 48, 32), new THREE.ShaderMaterial({
      uniforms: this.bgU, side: THREE.BackSide, depthWrite: false, depthTest: false,
      vertexShader: 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: /* glsl */ `
        varying vec3 vDir; uniform vec3 uTop,uMid,uBot,uBokA,uBokB,uSun,uSunC; uniform sampler2D uBokeh;
        void main(){
          vec3 d = normalize(vDir);
          vec3 col = mix(uBot, uMid, smoothstep(-0.85, 0.0, d.y));
          col = mix(col, uTop, smoothstep(-0.05, 0.85, d.y));
          float sunAmt = pow(max(dot(d, uSun), 0.0), 2.0);
          col += uSunC*sunAmt*0.3;
          vec4 bok = texture2D(uBokeh, vec2(atan(d.z, d.x)/6.2831853 + 0.5, d.y*0.5 + 0.5));
          float mask = (1.0 - smoothstep(0.55, 0.95, abs(d.y)))*(0.38 + 1.1*sunAmt)*2.0;
          col *= 0.9 + 0.2*bok.b;
          col += (uBokA*bok.r + uBokB*bok.g)*mask;
          gl_FragColor = vec4(col, 1.0);
        }`,
    }));
    // the out-of-focus discs are painted once into a panorama instead of being recomputed every frame
    this.bakeBackdrop = (renderer) => {
      const rt = new THREE.WebGLRenderTarget(2048, 1024, { depthBuffer: false, wrapS: THREE.RepeatWrapping });
      const mat = new THREE.ShaderMaterial({
        depthTest: false,
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: `varying vec2 vUv;\n${NOISE}\nfloat layer(vec2 uv, vec2 cells, float seed){
          vec2 g = uv*cells; vec2 id = floor(g); float acc = 0.0;
          for(int x=-1;x<=1;x++) for(int y=-1;y<=1;y++){
            vec2 c = id + vec2(float(x),float(y)); vec2 cw = vec2(mod(c.x, cells.x), c.y);
            vec2 h = hash22(cw + seed);
            float show = step(0.5, hash21(cw*1.7 + seed));
            vec2 ctr = c + 0.5 + (h-0.5)*0.8;
            float rad = 0.22 + 0.3*hash21(cw + seed*3.0);
            float d = length(g - ctr);
            float disc = smoothstep(rad, rad*0.8, d)*(0.7 + 0.3*smoothstep(rad*0.5, rad*0.85, d));
            acc += disc*show*(0.3 + 0.7*h.y)*(0.6 + 0.4*h.x);
          }
          return acc;
        }\nvoid main(){
          float a = layer(vUv, vec2(16.0, 8.0), 1.0)*0.15 + layer(vUv, vec2(9.0, 5.0), 9.0)*0.06;
          float b = layer(vUv, vec2(26.0, 13.0), 5.0)*0.12;
          gl_FragColor = vec4(a*0.5, b*0.5, vnoise(vec3(vUv*vec2(12.0, 6.0), 3.0)), 1.0); }`,
      });
      const sc = new THREE.Scene(), quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
      quad.frustumCulled = false; sc.add(quad);
      renderer.setRenderTarget(rt); renderer.render(sc, new THREE.Camera()); renderer.setRenderTarget(null);
      mat.dispose(); quad.geometry.dispose();
      this.bgU.uBokeh.value = rt.texture;
    };
    bg.renderOrder = -10; bg.frustumCulled = false;
    scene.add(bg);

    // dust motes and fireflies
    const ND = 260, NF = 42;
    const dp = new Float32Array(ND * 3), dr = new Float32Array(ND * 3);
    for (let i = 0; i < ND; i++) {
      dp[i * 3] = (Math.random() - 0.5) * 9; dp[i * 3 + 1] = (Math.random() - 0.35) * 6; dp[i * 3 + 2] = (Math.random() - 0.5) * 9;
      dr[i * 3] = Math.random(); dr[i * 3 + 1] = Math.random(); dr[i * 3 + 2] = Math.random();
    }
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(dp, 3)); dg.setAttribute('aRnd', new THREE.BufferAttribute(dr, 3));
    this.dustU = { uTime: U.uTime, uScale: U.uScale, uColor: { value: C(1, 1, 1) } };
    this.dust = new THREE.Points(dg, new THREE.ShaderMaterial({
      uniforms: this.dustU, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute vec3 aRnd; uniform float uTime, uScale; varying float vA;
        void main(){
          vec3 p = position;
          p.x += sin(uTime*0.11*(0.5+aRnd.x) + aRnd.y*6.28)*0.6;
          p.z += cos(uTime*0.09*(0.5+aRnd.z) + aRnd.x*6.28)*0.6;
          p.y = mod(p.y + uTime*0.035*(0.3+aRnd.y) + 2.1, 6.0) - 2.1;
          vec4 mv = modelViewMatrix*vec4(p,1.0);
          vA = (0.25 + 0.75*aRnd.z)*(0.6 + 0.4*sin(uTime*(0.5+aRnd.x) + aRnd.y*20.0));
          gl_PointSize = (0.012 + 0.03*aRnd.x*aRnd.x)*uScale/-mv.z;
          gl_Position = projectionMatrix*mv;
        }`,
      fragmentShader: `uniform vec3 uColor; varying float vA;
        void main(){ float d = length(gl_PointCoord-0.5)*2.0; if(d>1.0) discard; gl_FragColor = vec4(uColor*pow(1.0-d,1.6)*vA*0.5, 1.0); }`,
    }));
    this.dust.frustumCulled = false; this.dust.renderOrder = 6;
    scene.add(this.dust);

    const fp = new Float32Array(NF * 3), fr = new Float32Array(NF * 3);
    for (let i = 0; i < NF; i++) {
      const a = Math.random() * 6.283, r = Math.sqrt(Math.random()) * 2.3;
      fp[i * 3] = Math.cos(a) * r; fp[i * 3 + 1] = 0.25 + Math.random() * 0.9; fp[i * 3 + 2] = Math.sin(a) * r;
      fr[i * 3] = Math.random(); fr[i * 3 + 1] = Math.random(); fr[i * 3 + 2] = Math.random();
    }
    const fg = new THREE.BufferGeometry();
    fg.setAttribute('position', new THREE.BufferAttribute(fp, 3)); fg.setAttribute('aRnd', new THREE.BufferAttribute(fr, 3));
    this.flies = new THREE.Points(fg, new THREE.ShaderMaterial({
      uniforms: { uTime: U.uTime, uScale: U.uScale, uNight: U.uNight }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */ `
        attribute vec3 aRnd; uniform float uTime, uScale, uNight; varying float vA;
        void main(){
          float t = uTime*(0.25+0.3*aRnd.x) + aRnd.y*40.0;
          vec3 p = position + vec3(sin(t)*0.45 + sin(t*2.3)*0.12, sin(t*1.7+aRnd.z*6.0)*0.16, cos(t*0.9)*0.45 + cos(t*2.1)*0.12);
          vec4 mv = modelViewMatrix*vec4(p,1.0);
          vA = smoothstep(0.1, 0.9, sin(uTime*(1.2+aRnd.z) + aRnd.x*30.0))*uNight;
          gl_PointSize = 0.075*uScale/-mv.z;
          gl_Position = projectionMatrix*mv;
        }`,
      fragmentShader: `varying float vA;
        void main(){ float d = length(gl_PointCoord-0.5)*2.0; if(d>1.0) discard;
          gl_FragColor = vec4(vec3(0.85,1.0,0.35)*(smoothstep(0.3,0.0,d)*4.0 + pow(1.0-d,2.5)*0.9)*vA, 1.0); }`,
    }));
    this.flies.frustumCulled = false; this.flies.renderOrder = 6;
    island.add(this.flies);

    // spores (CPU particles, a few hundred at most)
    const NS = 420;
    this.sp = { n: NS, pos: new Float32Array(NS * 3), vel: new Float32Array(NS * 3), col: new Float32Array(NS * 3), life: new Float32Array(NS), cur: 0, live: 0 };
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(this.sp.pos, 3).setUsage(THREE.DynamicDrawUsage));
    sg.setAttribute('aColor', new THREE.BufferAttribute(this.sp.col, 3).setUsage(THREE.DynamicDrawUsage));
    sg.setAttribute('aLife', new THREE.BufferAttribute(this.sp.life, 1).setUsage(THREE.DynamicDrawUsage));
    this.spores = new THREE.Points(sg, new THREE.ShaderMaterial({
      uniforms: { uScale: U.uScale }, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: `attribute vec3 aColor; attribute float aLife; uniform float uScale; varying vec3 vC;
        void main(){ vec4 mv = modelViewMatrix*vec4(position,1.0); float a = smoothstep(0.0,0.15,aLife)*smoothstep(1.0,0.7,aLife);
          vC = aColor*a; gl_PointSize = (aLife > 0.0 ? 0.03 : 0.0)*uScale/-mv.z; gl_Position = projectionMatrix*mv; }`,
      fragmentShader: `varying vec3 vC; void main(){ float d = length(gl_PointCoord-0.5)*2.0; if(d>1.0) discard; gl_FragColor = vec4(vC*(smoothstep(0.4,0.0,d)*1.6 + pow(1.0-d,2.0)*0.5), 1.0); }`,
    }));
    this.spores.frustumCulled = false; this.spores.renderOrder = 6;
    island.add(this.spores);

    // ripple rings and the hover reticle
    this.rings = [];
    const rg = new THREE.RingGeometry(0.92, 1.0, 64); rg.rotateX(-Math.PI / 2);
    for (let i = 0; i < 6; i++) {
      const m = new THREE.Mesh(rg, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      m.visible = false; m.renderOrder = 7; island.add(m); this.rings.push({ m, t: 9 });
    }
    const hg = new THREE.RingGeometry(0.8, 1.0, 48); hg.rotateX(-Math.PI / 2);
    this.reticle = new THREE.Mesh(hg, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, side: THREE.DoubleSide }));
    this.reticle.renderOrder = 8; this.reticleA = 0; this.reticleOn = false;
    island.add(this.reticle);

    this.apply(0);
  }

  puff(pos, color, n) {
    const s = this.sp;
    for (let k = 0; k < n; k++) {
      const i = s.cur; s.cur = (s.cur + 1) % s.n;
      s.pos[i * 3] = pos.x + (Math.random() - 0.5) * 0.06; s.pos[i * 3 + 1] = pos.y + Math.random() * 0.04; s.pos[i * 3 + 2] = pos.z + (Math.random() - 0.5) * 0.06;
      s.vel[i * 3] = (Math.random() - 0.5) * 0.12; s.vel[i * 3 + 1] = 0.05 + Math.random() * 0.12; s.vel[i * 3 + 2] = (Math.random() - 0.5) * 0.12;
      const b = 0.8 + Math.random() * 1.6;
      s.col[i * 3] = color.r * b; s.col[i * 3 + 1] = color.g * b; s.col[i * 3 + 2] = color.b * b;
      s.life[i] = 0.999;
    }
    s.live = 9;
  }

  ripple(pos, color) {
    let r = this.rings[0];
    for (const x of this.rings) if (x.t > r.t) r = x;
    r.t = 0; r.m.position.copy(pos); r.m.position.y += 0.09; r.m.material.color.copy(color); r.m.visible = true;
  }

  setReticle(on, pos, normal, color) {
    this.reticleOn = on;
    if (!on) return;
    this.reticle.position.copy(pos).addScaledVector(normal, 0.05);
    this.reticle.quaternion.setFromUnitVectors(UP, normal);
    this.reticle.material.color.copy(color);
  }

  apply(n) {
    const a = DAY, b = NIGHT, U = this.U;
    this.sun.color.copy(a.sun).lerp(b.sun, n); this._sunI = lerp(a.sunI, b.sunI, n);
    // swing the key light through a low arc so the hand-over reads as dusk
    this.sun.position.copy(a.sunDir).lerp(b.sunDir, n).normalize().multiplyScalar(11);
    this._sunI *= 1 - 0.55 * Math.sin(n * Math.PI);
    this.hemi.color.copy(a.sky).lerp(b.sky, n); this.hemi.groundColor.copy(a.gnd).lerp(b.gnd, n); this._hemiI = lerp(a.hemiI, b.hemiI, n);
    this.fill.color.copy(a.fill).lerp(b.fill, n); this._fillI = lerp(a.fillI, b.fillI, n);
    const g = this.bgU, dusk = Math.sin(n * Math.PI);
    g.uTop.value.copy(a.top).lerp(b.top, n); g.uMid.value.copy(a.mid).lerp(b.mid, n); g.uBot.value.copy(a.bot).lerp(b.bot, n);
    g.uTop.value.r += 0.18 * dusk; g.uTop.value.g += 0.04 * dusk; g.uMid.value.r += 0.1 * dusk;
    g.uBokA.value.copy(a.bokA).lerp(b.bokA, n); g.uBokB.value.copy(a.bokB).lerp(b.bokB, n);
    g.uSun.value.copy(this.sun.position).normalize(); g.uSunC.value.copy(this.sun.color).multiplyScalar(lerp(1, 0.5, n));
    this.dustU.uColor.value.copy(a.dust).lerp(b.dust, n);
    U.uNight.value = n;
    this.exposure = lerp(a.exposure, b.exposure, n); this.bloom = lerp(a.bloom, b.bloom, n);
  }

  update(dt, real, glowSpots) {
    if (Math.abs(this.nightTarget - this.night) > 1e-4) {
      this.night += Math.sign(this.nightTarget - this.night) * Math.min(Math.abs(this.nightTarget - this.night), dt / 3.5);
      const n = this.night; this.apply(n * n * (3 - 2 * n));
    }
    // optional overall dimming (unused by default)
    this.dim += (this.dimTarget - this.dim) * Math.min(1, dt * 3);
    const k = 1 - 0.7 * this.dim * (1 - 0.45 * this.night);
    this.sun.intensity = this._sunI * k; this.hemi.intensity = this._hemiI * k; this.fill.intensity = this._fillI * k;
    // spores
    const s = this.sp;
    if (s.live > 0) {
      s.live -= dt;
      for (let i = 0; i < s.n; i++) {
        if (s.life[i] <= 0) continue;
        s.life[i] -= dt / 8;
        const i3 = i * 3;
        s.vel[i3] += (Math.sin(real * 0.7 + i) * 0.03 - s.vel[i3] * 0.4) * dt; s.vel[i3 + 2] += (Math.cos(real * 0.6 + i * 1.3) * 0.03 - s.vel[i3 + 2] * 0.4) * dt;
        s.vel[i3 + 1] += (0.035 - s.vel[i3 + 1]) * 0.5 * dt;
        s.pos[i3] += s.vel[i3] * dt; s.pos[i3 + 1] += s.vel[i3 + 1] * dt; s.pos[i3 + 2] += s.vel[i3 + 2] * dt;
      }
      const g = this.spores.geometry.attributes;
      g.position.needsUpdate = g.aColor.needsUpdate = g.aLife.needsUpdate = true;
    }
    for (const r of this.rings) {
      if (!r.m.visible) continue;
      r.t += dt; const k = r.t / 1.3;
      if (k >= 1) { r.m.visible = false; r.t = 9; continue; }
      const sc = 0.05 + 0.42 * (1 - Math.pow(1 - k, 3)); r.m.scale.setScalar(sc); r.m.material.opacity = (1 - k) * (1 - k) * 1.4;
    }
    this.reticleA += ((this.reticleOn ? 1 : 0) - this.reticleA) * Math.min(1, dt * 10);
    this.reticle.material.opacity = this.reticleA * (0.5 + 0.2 * Math.sin(real * 4));
    this.reticle.scale.setScalar(0.085 + 0.008 * Math.sin(real * 4));
    // glow lights sit on the most recent luminous growth
    const N = glowSpots.length, base = lerp(0.5, 2.6, this.U.uNight.value);
    for (let i = 0; i < this.glow.length; i++) {
      const l = this.glow[i], sp = glowSpots[N - 1 - i];
      if (sp) { l.position.copy(sp); l.intensity += (base * (0.85 + 0.15 * Math.sin(real * 1.5 + i * 2)) - l.intensity) * Math.min(1, dt * 0.5); }
      else l.intensity = 0;
    }
  }
}
const UP = new THREE.Vector3(0, 1, 0);
