import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { mulberry32, seedNoise } from './noise.js';
import { buildIsland, bakeWall, bakeGround, topH } from './island.js';
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
// Three's stock filter reads the shadow map 17 times per pixel; 9 well-placed reads look the same here.
{
  const before = THREE.ShaderChunk.shadowmap_pars_fragment;
  THREE.ShaderChunk.shadowmap_pars_fragment = before.replace(
    /shadow = \(\s*texture2DCompare\( shadowMap, shadowCoord\.xy \+ vec2\( dx0, dy0 \)[\s\S]*?\) \* \( 1\.0 \/ 17\.0 \);/,
    `shadow = (
      texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx0, dy0 ), shadowCoord.z ) +
      texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx1, dy0 ), shadowCoord.z ) +
      texture2DCompare( shadowMap, shadowCoord.xy + vec2( 0.0, dy2 ), shadowCoord.z ) +
      texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx2, 0.0 ), shadowCoord.z ) +
      texture2DCompare( shadowMap, shadowCoord.xy, shadowCoord.z ) +
      texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx3, 0.0 ), shadowCoord.z ) +
      texture2DCompare( shadowMap, shadowCoord.xy + vec2( 0.0, dy3 ), shadowCoord.z ) +
      texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx0, dy1 ), shadowCoord.z ) +
      texture2DCompare( shadowMap, shadowCoord.xy + vec2( dx1, dy1 ), shadowCoord.z )
    ) * ( 1.0 / 9.0 );`);
  if (THREE.ShaderChunk.shadowmap_pars_fragment === before) console.warn('shadow filter patch did not apply');
}
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
  uBake: { value: null }, uGroundBake: { value: null }, uMossBake: { value: null }, uNoiseTex: { value: null },
};

// ---------------------------------------------------------------- world ----

const island = buildIsland(U, rnd);
scene.add(island.group);
U.uBake.value = bakeWall(renderer, island.wall);
U.uGroundBake.value = bakeGround(renderer, island.ground);
{ const m = bakeMoss(renderer); U.uMossBake.value = m.bake; U.uNoiseTex.value = m.noise; }
const eco = new Ecosystem(island, U, rnd, { shells: LOW ? 7 : 10, tufts: LOW ? 2000 : 3600 });
island.group.add(eco.group);
const atm = new Atmosphere(scene, island.group, U);
eco.fx = atm;
atm.bakeBackdrop(renderer);

const snail = new Snail(eco, atm, U, rnd);
island.group.add(snail.group, snail.foodGroup);

// ------------------------------------------------------- post-processing ----

// The scene is drawn once into its own anti-aliased target. Only a sub-rectangle of
// that target is used: its size is the "render scale", which can change from frame
// to frame without reallocating anything (see the controller in the loop).
const sceneRT = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: LOW ? 0 : 4, depthTexture: new THREE.DepthTexture(4, 4) });
const dofRT = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false });
const view = {
  uSub: { value: new THREE.Vector2(1, 1) }, uMax: { value: new THREE.Vector2(1, 1) }, uStep: { value: new THREE.Vector2() },
  uNear: { value: camera.near }, uFar: { value: camera.far }, uFocus: { value: 9 }, uAmount: { value: LOW ? 0 : 1 },
};
const QUAD_VS = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }';
const COC = /* glsl */ `
  uniform sampler2D tDepth; uniform vec2 uSub, uMax; uniform float uNear, uFar, uFocus, uAmount;
  float cocD(float d){ float z = uNear*uFar/(uFar - d*(uFar - uNear)); return min(7.0, max(0.0, abs(z - uFocus) - 0.9)/uFocus*26.0); }
  float coc(vec2 suv){ float d = texture2D(tDepth, suv).x; return d > 0.99999 ? 5.0 : cocD(d); }`;

const composer = new EffectComposer(renderer);
class ScenePass extends Pass {
  constructor() { super(); this.needsSwap = false; }
  render(r) { r.setRenderTarget(sceneRT); r.render(scene, camera); }
}
// Depth of field is gathered at half resolution (a quarter of the work) and only
// blended in where the picture is actually out of focus.
class DofPass extends Pass {
  constructor() {
    super(); this.needsSwap = false;
    this.quad = new FullScreenQuad(new THREE.ShaderMaterial({
      uniforms: { tScene: { value: sceneRT.texture }, tDepth: { value: sceneRT.depthTexture }, ...view },
      vertexShader: QUAD_VS,
      fragmentShader: /* glsl */ `
        uniform sampler2D tScene; uniform vec2 uStep; varying vec2 vUv;
        ${COC}
        void main(){
          vec2 suv = min(vUv*uSub, uMax);
          vec3 acc = texture2D(tScene, suv).rgb; float wsum = 1.0;
          float d0 = texture2D(tDepth, suv).x;
          float c = d0 > 0.99999 ? 0.0 : cocD(d0)*uAmount;   // the backdrop is already soft
          if (c > 0.4) {
            for (int i = 1; i <= 12; i++) {
              float fi = float(i), r = sqrt(fi/12.0)*c, a = fi*2.39996;
              vec2 uv = min(suv + vec2(cos(a), sin(a))*r*uStep, uMax);
              float w = clamp(coc(uv)*uAmount/max(r, 0.5), 0.12, 1.0);
              acc += texture2D(tScene, uv).rgb*w; wsum += w;
            }
          }
          gl_FragColor = vec4(acc/wsum, 1.0);
        }`,
    }));
  }
  render(r) { if (view.uAmount.value <= 0) return; r.setRenderTarget(dofRT); this.quad.render(r); }
}
composer.addPass(new ScenePass());
composer.addPass(new DofPass());
const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.45, 0.75, 1.0);
// (a ready-made material, because ShaderPass would otherwise clone the uniforms and lose the shared ones)
const lens = new ShaderPass(new THREE.ShaderMaterial({
  uniforms: {
    tDiffuse: { value: sceneRT.texture }, tDepth: { value: sceneRT.depthTexture }, tBlur: { value: dofRT.texture },
    uRes: { value: new THREE.Vector2(1, 1) }, uTime: { value: 0 }, ...view,
  },
  vertexShader: QUAD_VS,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse, tBlur; uniform float uTime; uniform vec2 uRes; varying vec2 vUv;
    ${COC}
    float hash(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
    void main(){
      vec2 suv = min(vUv*uSub, uMax);
      vec3 col = texture2D(tDiffuse, suv).rgb;
      if (uAmount > 0.0) {
        float d = texture2D(tDepth, suv).x;
        if (d <= 0.99999) {
          float c = cocD(d)*uAmount;
          if (c > 0.4) col = mix(col, texture2D(tBlur, vUv).rgb, smoothstep(0.4, 1.5, c));
        }
      }
      vec2 q = vUv - 0.5; q.x *= min(1.0, uRes.x/uRes.y*0.75);
      col *= 1.0 - 0.55*smoothstep(0.25, 0.95, length(q)*1.35);
      col *= 1.0 + (hash(gl_FragCoord.xy + fract(uTime)*91.7) - 0.5)*0.055;
      gl_FragColor = vec4(col, 1.0);
    }`,
}), 'tNone');
composer.addPass(lens);
composer.addPass(bloom);
composer.addPass(new OutputPass());

let renderScale = 1, pointScale = 600;
function applyScale() {
  const W = sceneRT.width, H = sceneRT.height;
  const vw = Math.max(1, Math.round(W * renderScale)), vh = Math.max(1, Math.round(H * renderScale));
  sceneRT.viewport.set(0, 0, vw, vh); sceneRT.scissor.set(0, 0, vw, vh); sceneRT.scissorTest = true;
  view.uSub.value.set(vw / W, vh / H);
  view.uMax.value.set((vw - 0.5) / W, (vh - 0.5) / H);
  view.uStep.value.set((vw / W) * (H / W) / 1080, (vh / H) / 1080);
  U.uScale.value = pointScale * renderScale;
}
function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  dpr = Math.min(window.devicePixelRatio || 1, dprCap, Math.sqrt(MAX_PIXELS / (w * h)));
  const W = Math.round(w * dpr), H = Math.round(h * dpr);
  renderer.setPixelRatio(dpr); renderer.setSize(w, h, false);
  composer.setSize(W, H);
  sceneRT.setSize(W, H);
  dofRT.setSize(Math.ceil(W / 2), Math.ceil(H / 2));
  camera.aspect = w / h;
  camera.fov = camera.aspect < 1.25 ? Math.min(62, 30 * Math.pow(1.25 / camera.aspect, 0.85)) : 30;
  camera.updateProjectionMatrix();
  lens.uniforms.uRes.value.set(W, H);
  pointScale = H / (2 * Math.tan((camera.fov * Math.PI) / 360));
  applyScale();
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
window.microcosm = { scene, island, renderer, lens, bloom, degrade, get quality() { return { dpr, scale: renderScale, level: drs.level }; }, setScale, governor, snail, eco, atm, camera, controls, feedAt, setNight, step, get simT() { return simT; } };

// ----------------------------------------------------------------- loop ----

const clock = new THREE.Clock();
let frameN = 0, fpsT = 0, fpsN = 0, lastNow = performance.now();
const fpsEl = $('fps');
// Holding the frame rate. The render scale follows the load: when frames start
// arriving late it drops a notch at once (nothing is reallocated, so there is no
// hitch), and after a calm spell it creeps back up. If an increase is punished
// straight away, the next attempt waits twice as long. Only when the scale has hit
// its floor do features go: anti-aliasing, then depth of field, then moss layers.
const MIN_SCALE = 0.6;
const drs = { hist: [], iv: 1 / 60, ring: new Uint8Array(30), ri: 0, late: 0, cool: 90, calm: 0, wait: 4, lastUp: -1e9, level: 0 };
function degrade() {
  if (drs.level >= 3) return;
  const l = ++drs.level;
  if (l === 1) { sceneRT.samples = 0; sceneRT.dispose(); }
  else if (l === 2) view.uAmount.value = 0;
  else eco.setShells(7);
}
function setScale(v) { renderScale = v; applyScale(); drs.ring.fill(0); drs.late = 0; }
function governor(rawDt, now) {
  if (document.hidden || rawDt > 0.5) { drs.cool = 30; return; }
  const h = drs.hist; h.push(rawDt); if (h.length > 90) h.shift();
  if (frameN % 30 === 0 && h.length >= 30) { // the display's own frame interval: a low percentile of recent frames
    const sorted = h.slice().sort((a, b) => a - b);
    drs.iv = Math.min(1 / 30, Math.max(1 / 61, sorted[(sorted.length * 0.2) | 0])); // never chase more than 60 fps
  }
  if (drs.cool > 0) { drs.cool--; return; }
  const late = rawDt > drs.iv * 1.35 || drs.iv > 0.0205 ? 1 : 0;
  drs.late += late - drs.ring[drs.ri]; drs.ring[drs.ri] = late; drs.ri = (drs.ri + 1) % drs.ring.length;
  if (drs.late >= 4) {
    if (renderScale > MIN_SCALE + 1e-3) {
      if (now - drs.lastUp < 3000) drs.wait = Math.min(60, drs.wait * 2);
      setScale(Math.max(MIN_SCALE, renderScale * 0.88));
    } else { degrade(); drs.ring.fill(0); drs.late = 0; }
    drs.cool = 20; drs.calm = 0;
  } else if (late) drs.calm = Math.max(0, drs.calm - 1);
  else if ((drs.calm += rawDt) > drs.wait && renderScale < 1) {
    setScale(Math.min(1, renderScale * 1.06)); drs.lastUp = now; drs.calm = 0; drs.cool = 10;
  }
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
  view.uFocus.value = camera.position.distanceTo(controls.target);
  lens.uniforms.uTime.value = real;
  if ((frameN++ & 1) === 0) renderer.shadowMap.needsUpdate = true;
  composer.render(dt);

  // fps is measured on the real clock, not the clamped simulation step
  const now = performance.now(), rawDt = (now - lastNow) / 1000; lastNow = now;
  fpsT += rawDt; fpsN++;
  if (fpsT >= 0.5) {
    fpsEl.textContent = `${Math.round(fpsN / fpsT)} fps` + (renderScale < 0.995 ? ` · ${Math.round(renderScale * 100)}%` : '');
    fpsT = 0; fpsN = 0;
    const m = eco.mushroomCount;
    readout.textContent = `${m} mushroom${m === 1 ? '' : 's'}, ${snail.eaten} meal${snail.eaten === 1 ? '' : 's'} eaten`;
    ringSap.style.setProperty('--fill', Math.min(1, eco.bankSap / 12).toFixed(3));
    ringDew.style.setProperty('--fill', Math.min(1, eco.bankDew / 12).toFixed(3));
  }

  if (!params.has('lock')) governor(rawDt, now);
}

// Draw one frame with every kind of object switched on, so all shaders are compiled
// before the page is shown rather than the first time a mushroom or food bead appears.
{
  const restore = [];
  scene.traverse((o) => {
    if (o === island.pickGround || o === island.pickWall) return;
    if (o.isInstancedMesh && o.count === 0) { o.count = 1; restore.push(() => { o.count = 0; }); }
    if (!o.visible) { o.visible = true; restore.push(() => { o.visible = false; }); }
  });
  renderer.shadowMap.needsUpdate = true;
  composer.render(0);
  for (const r of restore) r();
}
frame();
document.body.classList.add('ready');
