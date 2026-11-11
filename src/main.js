import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { mulberry32, seedNoise } from './noise.js';
import { buildIsland, topH, inside } from './island.js';
import { Mycelium, FOOD } from './mycelium.js';
import { Ecosystem } from './flora.js';
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
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
let dpr = Math.min(window.devicePixelRatio || 1, LOW ? 1 : 1.75);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(30, 1, 0.5, 200);
camera.position.set(6.1, 2.0, 7.6);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, -1.1, 0);
controls.enableDamping = true; controls.dampingFactor = 0.06;
controls.enablePan = false;
controls.minDistance = 4.2; controls.maxDistance = 17;
controls.minPolarAngle = 0.25; controls.maxPolarAngle = 2.05;
controls.rotateSpeed = 0.6; controls.zoomSpeed = 0.7;
controls.autoRotateSpeed = 0.3;

const U = { uTime: { value: 0 }, uNight: { value: 0 }, uVital: { value: null }, uScale: { value: 600 } };

// ---------------------------------------------------------------- world ----

const island = buildIsland(U, rnd);
scene.add(island.group);
const eco = new Ecosystem(island, U, rnd, { shells: LOW ? 8 : 14, tufts: LOW ? 2000 : 4200 });
island.group.add(eco.group);
const atm = new Atmosphere(scene, island.group, U);
eco.fx = atm;

const _v = new THREE.Vector3();
const myc = new Mycelium(rnd, {
  deposit: (x, z, w) => eco.deposit(x, z, w),
  fertilize: (x, z, type, amt) => eco.fertilize(x, z, type, amt),
  onLanded: (s, p) => atm.ripple(p, s.type ? FOOD.dew.color : FOOD.sap.color),
  onAbsorbed: (s) => atm.puff(_v.set(s.x, topH(s.x, s.z) + 0.06, s.z), s.type ? FOOD.dew.color : FOOD.sap.color, 22),
});
island.group.add(myc.mesh, myc.points);

// ------------------------------------------------------- post-processing ----

const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: LOW ? 0 : 4, depthTexture: new THREE.DepthTexture(4, 4) });
const composer = new EffectComposer(renderer, rt);
// the composer clones the target, and a cloned depth texture shares its GPU texture: give the second its own
composer.renderTarget2.depthTexture = new THREE.DepthTexture(4, 4);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.45, 0.75, 1.0);
composer.addPass(bloom);
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
      float c = coc(vUv)*uAmount;
      vec3 acc = texture2D(tDiffuse, vUv).rgb; float wsum = 1.0;
      if (c > 0.4) {
        for (int i = 1; i <= 22; i++) {
          float fi = float(i), r = sqrt(fi/22.0)*c, a = fi*2.39996;
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
});
composer.addPass(lens);
composer.addPass(new OutputPass());

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setPixelRatio(dpr); renderer.setSize(w, h, false);
  composer.setSize(Math.round(w * dpr), Math.round(h * dpr));
  camera.aspect = w / h;
  camera.fov = camera.aspect < 1.25 ? Math.min(62, 30 * Math.pow(1.25 / camera.aspect, 0.85)) : 30;
  camera.updateProjectionMatrix();
  lens.uniforms.uRes.value.set(w * dpr, h * dpr);
  const k = 2 * Math.tan((camera.fov * Math.PI) / 360);
  U.uScale.value = (h * dpr) / k; myc.pUniforms.uScale.value = U.uScale.value;
  myc.uniforms.uPx.value = k / (h * dpr);
}
window.addEventListener('resize', resize);
resize();

// ------------------------------------------------------------ simulation ----

const TICK = 1 / 16;
let simT = 0, acc = 0, speed = 1, paused = false, real = 0;
function step() { myc.tick(TICK, simT); eco.tick(TICK, simT, myc); simT += TICK; }

// let the colony settle in before the first frame, so there is something to look at
for (let i = 0; i < 16 * 70; i++) step();
eco.seedInitial(simT);

// ----------------------------------------------------------- interaction ----

let tool = 'sap', soilView = false, placed = 0;
const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
let hover = null, hoverDirty = false, down = null, lastInput = performance.now();
const targets = [island.ground, island.wall];

function pick(ev) {
  const r = canvas.getBoundingClientRect();
  ptr.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ptr, camera);
  return ray.intersectObjects(targets, false)[0] || null;
}

function feed(hit, type = tool) {
  const p = island.group.worldToLocal(hit.point.clone()), n = hit.face.normal;
  const to = p.clone(), from = p.clone();
  if (hit.object === island.ground) {
    let d = 0.35 + rnd() * 0.65;
    to.y = p.y - d;
    for (let k = 0; k < 10 && !inside(to.x, to.y, to.z, 0.14); k++) { d *= 0.8; to.set(p.x * (1 - 0.06 * k), p.y - d, p.z * (1 - 0.06 * k)); }
    from.y += 1.5;
  } else {
    to.addScaledVector(n, -0.42);
    for (let k = 0; k < 12 && !inside(to.x, to.y, to.z, 0.14); k++) { to.x *= 0.88; to.z *= 0.88; to.y += 0.05; }
    from.addScaledVector(n, 0.9); from.y += 0.25;
  }
  if (!inside(to.x, to.y, to.z, 0.05)) return false;
  myc.addFood(FOOD[type].type, from, p, to, simT);
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
function setSoil(on) {
  soilView = on; $('btn-soil').setAttribute('aria-pressed', String(on));
  myc.mesh.renderOrder = myc.points.renderOrder = on ? 5 : 1; atm.dimTarget = on ? 1 : 0;
}
$('btn-soil').addEventListener('click', () => setSoil(!soilView));
window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === '1') setTool('sap'); else if (k === '2') setTool('dew');
  else if (k === 'n') setNight(atm.nightTarget < 0.5);
  else if (k === 'x') setSoil(!soilView);
  else if (k === ' ') { paused = !paused; $('btn-speed').textContent = paused ? 'Paused' : `${speed}× speed`; e.preventDefault(); }
});

// test / demo hooks: ?night=1  ?t=<seconds to fast-forward>  ?feed=<n random feeds first>
if (params.get('night') === '1') { atm.night = atm.nightTarget = 1; atm.apply(1); $('btn-night').textContent = 'Day'; }
function feedAt(x, z, type) {
  const p = new THREE.Vector3(x, topH(x, z), z);
  return feed({ point: island.group.localToWorld(p.clone()), face: { normal: new THREE.Vector3(0, 1, 0) }, object: island.ground }, type);
}
{
  const n = parseInt(params.get('feed') || '0', 10), ff = parseFloat(params.get('t') || '0');
  for (let i = 0; i < n; i++) { const a = rnd() * 6.283, r = 0.4 + rnd() * 1.4; feedAt(Math.cos(a) * r, Math.sin(a) * r, i % 2 ? 'dew' : 'sap'); }
  for (let i = 0; i < ff * 16; i++) step();
}
window.microcosm = { myc, eco, atm, camera, controls, feedAt, setSoil, setNight, step, get simT() { return simT; } };

// ----------------------------------------------------------------- loop ----

const clock = new THREE.Clock();
const center = new THREE.Vector3();
let slow = 0, readoutT = 0;
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
  myc.sync(simT + acc, real, U.uNight.value);
  const mu = myc.uniforms;
  mu.uCam.value.copy(camera.position).sub(island.group.position);
  mu.uCenterDist.value = camera.position.distanceTo(center.set(0, -0.8, 0));
  mu.uTopVis.value += ((soilView ? 1.0 : 0.16 + 0.3 * U.uNight.value) - mu.uTopVis.value) * 0.1;
  mu.uIntensity.value += ((soilView ? 1.6 : 1.0 - 0.45 * U.uNight.value) - mu.uIntensity.value) * 0.1;

  renderer.toneMappingExposure = atm.exposure;
  bloom.strength = atm.bloom + (soilView ? 0.25 : 0);
  lens.uniforms.tDepth.value = composer.readBuffer.depthTexture;
  lens.uniforms.uFocus.value = camera.position.distanceTo(controls.target);
  lens.uniforms.uTime.value = real;
  composer.render(dt);

  readoutT += dt;
  if (readoutT > 0.5) {
    readoutT = 0;
    const m = eco.mushroomCount;
    readout.textContent = `${(myc.totalLength * 0.1).toFixed(1)} m of hyphae, ${m} mushroom${m === 1 ? '' : 's'}`;
    ringSap.style.setProperty('--fill', Math.min(1, myc.energy / 14).toFixed(3));
    ringDew.style.setProperty('--fill', Math.min(1, myc.lumen / 14).toFixed(3));
  }

  // ease off the resolution if the machine is struggling
  slow = dt > 0.034 ? slow + dt : Math.max(0, slow - dt * 2);
  if (slow > 4 && dpr > 1) { dpr = Math.max(1, dpr - 0.25); slow = 0; resize(); }
}
frame();
document.body.classList.add('ready');
