import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { Pass } from 'three/addons/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { mulberry32, seedNoise } from './noise.js';
import { buildIsland, bakeWall, topH } from './island.js';
import { Snail, FOOD } from './snail.js';
import { Ecosystem, bakeMoss } from './flora.js';
import { Atmosphere } from './atmosphere.js';

const params = new URLSearchParams(location.search);
const LOW = params.get('q') === 'low';
const seed = parseInt(params.get('seed') || '20261111', 10);
seedNoise(seed % 9973);
const rnd = mulberry32(seed);

// ------------------------------------------------------------- renderer ----

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.shadowMap.autoUpdate = false; // refreshed every other frame in the loop
// never shade more than ~2.2 megapixels, whatever the screen: the soft lens look hides the difference
const MAX_PIXELS = LOW ? 1.2e6 : 2.2e6;
let dprCap = LOW ? 1 : 1.5, dpr = 1;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.5, 200);
camera.position.set(5.6, 3.1, 7.0);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, -0.75, 0);
controls.enableDamping = true; controls.dampingFactor = 0.06;
controls.enablePan = false;
controls.minDistance = 2.6; controls.maxDistance = 17;
controls.minPolarAngle = 0.25; controls.maxPolarAngle = 2.05;
controls.rotateSpeed = 0.6; controls.zoomSpeed = 0.7;
controls.autoRotateSpeed = 0.3;

const U = {
  uTime: { value: 0 }, uNight: { value: 0 }, uVital: { value: null }, uScale: { value: 600 },
  uBake: { value: null }, uMossBake: { value: null }, uNoiseTex: { value: null },
};

// ---------------------------------------------------------------- world ----

const island = buildIsland(U, rnd);
scene.add(island.group);
U.uBake.value = bakeWall(renderer, island.wall);
{ const m = bakeMoss(renderer); U.uMossBake.value = m.bake; U.uNoiseTex.value = m.noise; }
const eco = new Ecosystem(island, U, rnd, { shells: LOW ? 7 : 10, tufts: LOW ? 2000 : 3600 });
island.group.add(eco.group);
const atm = new Atmosphere(scene, island.group, U);
eco.fx = atm;
atm.bakeBackdrop(renderer);

const snail = new Snail(eco, atm, U, rnd);
island.group.add(snail.group, snail.foodGroup);

// ------------------------------------------------------- post-processing ----

// The scene is drawn once into its own anti-aliased target; the lens pass reads it
// (colour + depth) and everything after that runs on plain, cheaper buffers.
const sceneRT = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: LOW ? 0 : 4, depthTexture: new THREE.DepthTexture(4, 4) });
const composer = new EffectComposer(renderer);
class ScenePass extends Pass {
  constructor() { super(); this.needsSwap = false; }
  render(r) { r.setRenderTarget(sceneRT); r.render(scene, camera); }
}
composer.addPass(new ScenePass());
const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.45, 0.75, 1.0);
const lens = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null }, tDepth: { value: null }, uNear: { value: camera.near }, uFar: { value: camera.far },
    uFocus: { value: 9 }, uRes: { value: new THREE.Vector2(1, 1) }, uAmount: { value: LOW ? 0 : 1 }, uTime: { value: 0 },
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse, tDepth; uniform float uNear, uFar, uFocus, uAmount, uTime; uniform vec2 uRes; varying vec2 vUv;
    float coc(vec2 uv){
      float d = texture2D(tDepth, uv).x;
      if (d > 0.99999) return 5.0;
      float z = uNear*uFar/(uFar - d*(uFar - uNear));
      return min(7.0, max(0.0, abs(z - uFocus) - 0.9)/uFocus*26.0);
    }
    float hash(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
    void main(){
      float px = uRes.y/1080.0;
      // the backdrop is already soft, so only the island itself is blurred
      float c = texture2D(tDepth, vUv).x > 0.99999 ? 0.0 : coc(vUv)*uAmount;
      vec3 acc = texture2D(tDiffuse, vUv).rgb; float wsum = 1.0;
      if (c > 0.4) {
        for (int i = 1; i <= 12; i++) {
          float fi = float(i), r = sqrt(fi/12.0)*c, a = fi*2.39996;
          vec2 uv = vUv + vec2(cos(a), sin(a))*r*px/uRes;
          float w = clamp(coc(uv)*uAmount/max(r, 0.5), 0.12, 1.0);
          acc += texture2D(tDiffuse, uv).rgb*w; wsum += w;
        }
      }
      vec3 col = acc/wsum;
      vec2 q = vUv - 0.5; q.x *= min(1.0, uRes.x/uRes.y*0.75);
      col *= 1.0 - 0.55*smoothstep(0.25, 0.95, length(q)*1.35);
      col *= 1.0 + (hash(gl_FragCoord.xy + fract(uTime)*91.7) - 0.5)*0.055;
      gl_FragColor = vec4(col, 1.0);
    }`,
}, 'tNone');
lens.uniforms.tDiffuse.value = sceneRT.texture;
lens.uniforms.tDepth.value = sceneRT.depthTexture;
composer.addPass(lens);
composer.addPass(bloom);
composer.addPass(new OutputPass());

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  dpr = Math.min(window.devicePixelRatio || 1, dprCap, Math.sqrt(MAX_PIXELS / (w * h)));
  renderer.setPixelRatio(dpr); renderer.setSize(w, h, false);
  composer.setSize(Math.round(w * dpr), Math.round(h * dpr));
  sceneRT.setSize(Math.round(w * dpr), Math.round(h * dpr));
  camera.aspect = w / h;
  camera.fov = camera.aspect < 1.25 ? Math.min(62, 30 * Math.pow(1.25 / camera.aspect, 0.85)) : 30;
  camera.updateProjectionMatrix();
  lens.uniforms.uRes.value.set(w * dpr, h * dpr);
  const k = 2 * Math.tan((camera.fov * Math.PI) / 360);
  U.uScale.value = (h * dpr) / k;
}
window.addEventListener('resize', resize);
resize();

// ------------------------------------------------------------ simulation ----

const TICK = 1 / 16;
let simT = 0, acc = 0, speed = 1, paused = false, real = 0;
function step() { snail.tick(TICK, simT); eco.tick(TICK, simT); simT += TICK; }

// let the snail wander for a while before the first frame, so there is already a trail
for (let i = 0; i < 16 * 70; i++) step();
eco.seedInitial(simT);

// ----------------------------------------------------------- interaction ----

let tool = 'sap', placed = 0;
const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
let hover = null, hoverDirty = false, down = null, lastInput = performance.now();
const targets = [island.pickGround];

function pick(ev) {
  const r = canvas.getBoundingClientRect();
  ptr.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  return ray.intersectObjects(targets, false)[0] || null;
}

function feed(hit, type = tool) {
  const p = island.group.worldToLocal(hit.point.clone());
  if (snail.near(p.x, p.z)) { snail.startle(); return false; } // poke the snail and it ducks into its shell
  snail.addFood(FOOD[type].type, p.x, p.z, simT);
  placed++;
  if (placed === 1) document.body.classList.add('fed');
  return true;
}

canvas.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; lastInput = performance.now(); });
canvas.addEventListener('pointermove', (e) => { hover = e; hoverDirty = true; if (e.buttons) lastInput = performance.now(); });
canvas.addEventListener('pointerleave', () => { hover = null; atm.setReticle(false); });
canvas.addEventListener('pointerup', (e) => {
  if (!down) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y), dt = performance.now() - down.t;
  down = null;
  if (moved > 6 || dt > 500 || e.button !== 0) return;
  const hit = pick(e);
  if (hit) feed(hit);
});
canvas.addEventListener('wheel', () => { lastInput = performance.now(); }, { passive: true });

const $ = (id) => document.getElementById(id);
const toolBtns = { sap: $('tool-sap'), dew: $('tool-dew') };
function setTool(t) { tool = t; for (const k in toolBtns) toolBtns[k].setAttribute('aria-pressed', String(k === t)); }
toolBtns.sap.addEventListener('click', () => setTool('sap'));
toolBtns.dew.addEventListener('click', () => setTool('dew'));
function setNight(on) { atm.nightTarget = on ? 1 : 0; $('btn-night').textContent = on ? 'Day' : 'Night'; }
$('btn-night').addEventListener('click', () => setNight(atm.nightTarget < 0.5));
const speeds = [1, 3, 8];
function setSpeed(s) { speed = s; paused = false; $('btn-speed').textContent = `${s}× speed`; }
$('btn-speed').addEventListener('click', () => setSpeed(speeds[(speeds.indexOf(speed) + 1) % speeds.length]));
window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === '1') setTool('sap'); else if (k === '2') setTool('dew');
  else if (k === 'n') setNight(atm.nightTarget < 0.5);
  else if (k === ' ') { paused = !paused; $('btn-speed').textContent = paused ? 'Paused' : `${speed}× speed`; e.preventDefault(); }
});

// test / demo hooks: ?night=1  ?t=<seconds to fast-forward>  ?feed=<n random feeds first>
if (params.get('night') === '1') { atm.night = atm.nightTarget = 1; atm.apply(1); $('btn-night').textContent = 'Day'; }
function feedAt(x, z, type) {
  const p = new THREE.Vector3(x, topH(x, z), z);
  return feed({ point: island.group.localToWorld(p.clone()), face: { normal: new THREE.Vector3(0, 1, 0) }, object: island.pickGround }, type);
}
{
  const n = parseInt(params.get('feed') || '0', 10), ff = parseFloat(params.get('t') || '0');
  for (let i = 0; i < n; i++) { const a = rnd() * 6.283, r = 0.4 + rnd() * 1.4; feedAt(Math.cos(a) * r, Math.sin(a) * r, i % 2 ? 'dew' : 'sap'); }
  for (let i = 0; i < ff * 16; i++) step();
}
window.microcosm = { scene, island, renderer, lens, bloom, degrade, get quality() { return { dpr, level: perf.level }; }, snail, eco, atm, camera, controls, feedAt, setNight, step, get simT() { return simT; } };

// ----------------------------------------------------------------- loop ----

const clock = new THREE.Clock();
let frameN = 0, fpsT = 0, fpsN = 0, lastNow = performance.now();
const fpsEl = $('fps');
// Quality steps down whenever a one-second window averages under ~45 fps (two notches if under ~22).
const perf = { t: 0, n: 0, level: 0, grace: 2 };
function degrade() {
  if (perf.level >= 5) return;
  const l = ++perf.level;
  if (l === 1) dprCap = dpr * 0.85;
  else if (l === 2) { sceneRT.samples = 0; sceneRT.dispose(); lens.uniforms.uAmount.value = 0; }
  else if (l === 3) { dprCap = dpr * 0.85; eco.setShells(7); }
  else if (l === 4) dprCap = dpr * 0.8;
  else { dprCap = dpr * 0.8; eco.setShells(6); }
  dprCap = Math.max(0.6, dprCap);
  resize();
}
const readout = $('readout'), ringSap = $('ring-sap'), ringDew = $('ring-dew');

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.1);
  real += dt;

  if (!paused) {
    acc += dt * speed;
    let n = 0;
    while (acc >= TICK && n < 12) { step(); acc -= TICK; n++; }
    if (n === 12) acc = 0;
  }

  island.group.position.y = Math.sin(real * 0.45) * 0.035;
  island.group.rotation.z = Math.sin(real * 0.31) * 0.006;
  controls.autoRotate = performance.now() - lastInput > 7000;
  controls.update();

  if (hoverDirty && hover) {
    hoverDirty = false;
    const hit = hover.buttons ? null : pick(hover);
    if (hit) atm.setReticle(true, island.group.worldToLocal(hit.point.clone()), hit.face.normal, FOOD[tool].color);
    else atm.setReticle(false);
    canvas.style.cursor = hit ? 'crosshair' : 'grab';
  }

  U.uTime.value = real;
  eco.frame(simT + acc);
  atm.update(dt, real, eco.glowSpots);
  snail.frame(dt, real);

  renderer.toneMappingExposure = atm.exposure;
  bloom.strength = atm.bloom;
  lens.uniforms.uFocus.value = camera.position.distanceTo(controls.target);
  lens.uniforms.uTime.value = real;
  if ((frameN++ & 1) === 0) renderer.shadowMap.needsUpdate = true;
  composer.render(dt);

  // fps is measured on the real clock, not the clamped simulation step
  const now = performance.now(), rawDt = (now - lastNow) / 1000; lastNow = now;
  fpsT += rawDt; fpsN++;
  if (fpsT >= 0.5) {
    fpsEl.textContent = `${Math.round(fpsN / fpsT)} fps`;
    fpsT = 0; fpsN = 0;
    const m = eco.mushroomCount;
    readout.textContent = `${m} mushroom${m === 1 ? '' : 's'}, ${snail.eaten} meal${snail.eaten === 1 ? '' : 's'} eaten`;
    ringSap.style.setProperty('--fill', Math.min(1, eco.bankSap / 12).toFixed(3));
    ringDew.style.setProperty('--fill', Math.min(1, eco.bankDew / 12).toFixed(3));
  }

  // ease off if the machine is struggling
  if (!document.hidden && rawDt < 1) {
    perf.t += rawDt; perf.n++;
    if (perf.t >= 1) {
      const avg = perf.t / perf.n; perf.t = 0; perf.n = 0;
      if (perf.grace > 0) perf.grace--;
      else if (avg > 0.022 && !params.has('lock')) { degrade(); if (avg > 0.045) degrade(); perf.grace = 1; }
    }
  }
}
frame();
document.body.classList.add('ready');
