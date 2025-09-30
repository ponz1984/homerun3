// viewer/app.js — 互換モード：配列オブジェクト軌道 & ID指定修正
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {Line2} from 'three/addons/lines/Line2.js';
import {LineGeometry} from 'three/addons/lines/LineGeometry.js';
import {LineMaterial} from 'three/addons/lines/LineMaterial.js';
import {loadPlaysFromCsv} from './physics-lite.js';

const $ = (id) => document.getElementById(id);

const state = {
  plays: [],
  currentIndex: 0,
  playing: false,
  autoAdvance: false,
  followBall: false,
  speed: 1,
  trajectory: null,          // [{t,x,y,z}, ...]
  trajectoryMaterial: null,
  trajectoryLine: null,
  duration: 0,
  time: 0,
  segmentIndex: 0,
  progress: null,
  cameraMode: 'infield',
  lastPresetByMode: {infield: 'catcher', outfield: 'cf_stand'},
  lastPreset: 'catcher',
  statusTimer: null,
};

let renderer, scene, camera, controls, ball, theme, cameraPresets, clock;

const DEFAULT_INFIELD_PRESETS = {
  catcher: {pos: [-5, -20, 6], lookAt: [0, 60, 6]},
  if_high: {pos: [0, -120, 55], lookAt: [0, 140, 10]},
  lf_stand: {pos: [-260, 180, 50], lookAt: [0, 200, 10]},
  cf_stand: {pos: [0, 420, 70], lookAt: [0, 200, 10]},
  rf_stand: {pos: [260, 180, 50], lookAt: [0, 200, 10]},
};

const DEFAULT_OUTFIELD_PRESETS = {
  catcher: {pos: [0, 360, 90], lookAt: [0, 0, 6]},
  if_high: {pos: [0, 460, 140], lookAt: [0, 0, 6]},
  lf_stand: {pos: [-260, 380, 90], lookAt: [0, 0, 6]},
  cf_stand: {pos: [0, 460, 130], lookAt: [0, 0, 6]},
  rf_stand: {pos: [260, 380, 90], lookAt: [0, 0, 6]},
};

const ORIGIN_LOOK_AT = [0, 0, 6];

function toVec3(arr, fallback) {
  if (!Array.isArray(arr) || arr.length < 3) return [...fallback];
  return arr.slice(0, 3).map((v, idx) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback[idx] ?? 0;
  });
}

function clonePreset(preset, fallback) {
  const base = fallback ? {pos: [...fallback.pos], lookAt: [...fallback.lookAt]} : {pos: [0, 0, 0], lookAt: [0, 0, 0]};
  if (!preset) return base;
  return {
    pos: toVec3(preset.pos, base.pos),
    lookAt: toVec3(preset.lookAt, base.lookAt),
  };
}

function mergePresetGroup(baseGroup, overrideGroup) {
  const merged = {};
  for (const [name, preset] of Object.entries(baseGroup)) {
    merged[name] = clonePreset(preset);
  }
  if (overrideGroup) {
    for (const [name, preset] of Object.entries(overrideGroup)) {
      const base = merged[name] || clonePreset(baseGroup[name] || null);
      merged[name] = clonePreset(preset, base);
    }
  }
  return merged;
}

function buildCameraPresets(raw) {
  if (raw && (raw.infield || raw.outfield)) {
    return {
      infield: mergePresetGroup(DEFAULT_INFIELD_PRESETS, raw.infield),
      outfield: mergePresetGroup(DEFAULT_OUTFIELD_PRESETS, raw.outfield),
    };
  }
  return {
    infield: mergePresetGroup(DEFAULT_INFIELD_PRESETS, raw),
    outfield: mergePresetGroup(DEFAULT_OUTFIELD_PRESETS, {}),
  };
}

function getCameraPreset(name, mode = state.cameraMode) {
  const selectedMode = mode || state.cameraMode;
  const modePresets = (cameraPresets && cameraPresets[selectedMode]) || {};
  const fallbackGroup = selectedMode === 'outfield' ? DEFAULT_OUTFIELD_PRESETS : DEFAULT_INFIELD_PRESETS;
  const fallbackPreset = fallbackGroup[name] || DEFAULT_INFIELD_PRESETS[name] || DEFAULT_INFIELD_PRESETS.catcher;
  const preset = modePresets[name] || fallbackPreset;
  if (!preset) return null;
  const posFallback = fallbackPreset.pos || DEFAULT_INFIELD_PRESETS.catcher.pos;
  const lookFallback = fallbackPreset.lookAt || DEFAULT_INFIELD_PRESETS.catcher.lookAt;
  const pos = toVec3(preset.pos, posFallback);
  let lookAt = toVec3(preset.lookAt, lookFallback);
  if (selectedMode === 'outfield' && /_stand$/.test(name)) {
    lookAt = [...ORIGIN_LOOK_AT];
  }
  return {pos, lookAt};
}

function refreshCanvasOffset() {
  const ui = document.querySelector('.ui');
  if (!ui) return;
  const rect = ui.getBoundingClientRect();
  const offset = Math.round(rect.height + 12);
  document.documentElement.style.setProperty('--ui-offset', `${offset}px`);
}

function setStatus(message, type = 'info', timeout = 6000) {
  const statusEl = $('csvStatus');
  if (!statusEl) return;
  if (state.statusTimer) {
    clearTimeout(state.statusTimer);
    state.statusTimer = null;
  }
  statusEl.textContent = message || '';
  const baseClass = 'status-message';
  statusEl.className = message ? `${baseClass} ${type}` : baseClass;
  refreshCanvasOffset();
  if (message && timeout > 0) {
    state.statusTimer = setTimeout(() => {
      if (statusEl.textContent === message) {
        statusEl.textContent = '';
        statusEl.className = baseClass;
        refreshCanvasOffset();
      }
      state.statusTimer = null;
    }, timeout);
  }
}

// ---------- helpers ----------
async function fetchJSON(path) {
  const res = await fetch(path, {cache: 'no-cache'});
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return await res.json();
}
function toTopBot(v) {
  const s = String(v || 'Top').toLowerCase();
  return s.startsWith('top') ? 'Top' : 'Bot';
}
function normalizePlay(p) {
  const rawHalf = p.inning_half ?? p.topbot;
  const half = rawHalf ? toTopBot(rawHalf) : '';
  return {
    ...p,
    batter:       p.batter ?? p.player_name ?? '',
    event:        p.event  ?? p.events      ?? '',
    topbot:       p.topbot ?? half,
    inning_half:  p.inning_half ?? half,
    outs_when_up: p.outs_when_up ?? p.outs ?? 0,
    bat_team:     p.bat_team ?? '',
    opp_team:     p.opp_team ?? '',
    game_date:    p.game_date ?? '',
    trajectory_path: p.trajectory ?? p.trajectory_file ?? '',
  };
}
// 軌道JSONを [{t,x,y,z}, …] に正規化
function normalizeTrajectory(traj) {
  if (!traj) return [];
  // {points: [{t,x,y,z}, ...]}
  if (Array.isArray(traj.points)) {
    return traj.points.map(p => ({t:p.t??0, x:p.x, y:p.y, z:p.z??0}));
  }
  // {samples: [[t,x,y,z], ...]}
  if (Array.isArray(traj.samples)) {
    return traj.samples.map(([t,x,y,z]) => ({t:t??0, x, y, z:z??0}));
  }
  // {t:[], x:[], y:[], z:[]}
  if (Array.isArray(traj.t) && Array.isArray(traj.x) && Array.isArray(traj.y) && Array.isArray(traj.z)) {
    const n = Math.min(traj.t.length, traj.x.length, traj.y.length, traj.z.length);
    const out = [];
    for (let i=0;i<n;i++) out.push({t:traj.t[i]??0, x:traj.x[i], y:traj.y[i], z:traj.z[i]??0});
    return out;
  }
  // [[x,y,z]] or [[t,x,y,z]]
  if (Array.isArray(traj) && Array.isArray(traj[0])) {
    return traj.map(a => (a.length===4 ? ({t:a[0]??0, x:a[1], y:a[2], z:a[3]??0})
                                     : ({t:0, x:a[0], y:a[1], z:a[2]??0})));
  }
  // ★ 配列の中がオブジェクト [{x:..,y:..,z:..,t?}, ...] に対応
  if (Array.isArray(traj) && typeof traj[0] === 'object' && traj[0] !== null && 'x' in traj[0] && 'y' in traj[0]) {
    return traj.map(p => ({t:('t' in p ? p.t : 0), x:p.x, y:p.y, z:('z' in p ? p.z : 0)}));
  }
  console.warn('Unknown trajectory shape:', traj);
  return [];
}

// ---------- data load ----------
async function loadData() {
  const [config, playlist] = await Promise.all([
    fetchJSON('config.json'),
    fetchJSON('playlist.json'),
  ]);
  theme = config.theme || {};
  cameraPresets = buildCameraPresets(config.camera_presets || {});
  state.cameraMode = 'infield';
  state.lastPresetByMode = {infield: 'catcher', outfield: 'cf_stand'};
  state.lastPreset = 'catcher';

  const raw = (playlist && playlist.plays) ? playlist.plays : [];
  const plays = [];
  for (const rp of raw) {
    const p = normalizePlay(rp);
    if (!p.trajectory_path) continue;
    const trajRaw = await fetchJSON(p.trajectory_path);
    const points  = normalizeTrajectory(trajRaw);
    plays.push({...p, points});
  }
  state.plays = plays;
  return config.ballpark; // なくても fallback で描く
}

// ---------- scene ----------
function setupScene(ballpark) {
  const canvas = $('glcanvas');
  renderer = new THREE.WebGLRenderer({canvas, antialias: true});
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setClearColor(theme.background || '#f5f7fb');

  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 5000);
  scene = new THREE.Scene();

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 180, 6);

  const ballColor = theme.trajectory?.ball_color || theme.trajectory?.color || '#E03C31';
  const ballRadius = theme.trajectory?.ball_radius ?? 1.5;
  ball = new THREE.Mesh(new THREE.SphereGeometry(ballRadius, 32, 32),
                        new THREE.MeshBasicMaterial({color: ballColor}));
  scene.add(ball);

  addBallparkWireframe(ballpark);   // ワイヤーフレーム
  addGroundGrid();
  applyCameraPreset('catcher', {mode: state.cameraMode});

  window.addEventListener('resize', handleWindowResize);
  refreshCanvasOffset();
  handleResize();
  clock = new THREE.Clock();
  clock.stop();
}

function addGroundGrid() {
  if (!theme.ground_grid || theme.ground_grid.enabled === false) return;
  const size = 600, divisions = 24;
  const color = new THREE.Color(theme.ground_grid.line_color || '#E5E9F2');
  const grid = new THREE.GridHelper(size, divisions, color, color);
  grid.material.opacity = 0.35; grid.material.transparent = true; grid.rotation.x = Math.PI / 2;
  scene.add(grid);
}

function addBallparkWireframe(ballpark) {
  const lineColor = new THREE.Color(theme.ballpark?.line_color || '#8892a6');
  const lineWidth = theme.ballpark?.line_width || 1;
  const material = new THREE.LineBasicMaterial({color: lineColor, linewidth: lineWidth});
  const v = (p) => new THREE.Vector3(p[0], p[1], p[2]);

  if (ballpark && Array.isArray(ballpark.fence_base) && Array.isArray(ballpark.fence_top)) {
    const baseGeom = new THREE.BufferGeometry().setFromPoints(ballpark.fence_base.map(v));
    scene.add(new THREE.LineLoop(baseGeom, material));
    const topGeom  = new THREE.BufferGeometry().setFromPoints(ballpark.fence_top.map(v));
    scene.add(new THREE.LineLoop(topGeom, material));
    if (Array.isArray(ballpark.wall_segments)) {
      const wallPts = [];
      ballpark.wall_segments.forEach(seg => { wallPts.push(...seg[0], ...seg[1]); });
      if (wallPts.length) {
        const wallGeom = new THREE.BufferGeometry();
        wallGeom.setAttribute('position', new THREE.Float32BufferAttribute(wallPts, 3));
        scene.add(new THREE.LineSegments(wallGeom, material));
      }
    }
    if (Array.isArray(ballpark.foul_lines)) {
      ballpark.foul_lines.forEach(line => {
        const geom = new THREE.BufferGeometry().setFromPoints(line.map(v));
        scene.add(new THREE.Line(geom, material));
      });
    }
    return;
  }

  // fallback（簡易外野弧＋ファウルライン）
  const pts = [];
  for (let a=-90;a<=90;a+=2){ const r=400, rad=a*Math.PI/180; pts.push(new THREE.Vector3(r*Math.sin(rad), r*Math.cos(rad), 0)); }
  scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), material));
  const h = 8, top = pts.map(p=>new THREE.Vector3(p.x,p.y,h));
  scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(top), material));
  for (let i=0;i<pts.length;i+=10){
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([pts[i], top[i]]), material));
  }
  scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0), new THREE.Vector3(-330,0,0)]), material));
  scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0,0,0), new THREE.Vector3(330,0,0)]), material));
}

function handleResize() {
  const canvas = renderer.domElement;
  const w = canvas.clientWidth, h = canvas.clientHeight || 1;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (state.trajectoryMaterial) state.trajectoryMaterial.resolution.set(w, h);
}

function handleWindowResize() {
  refreshCanvasOffset();
  handleResize();
}

function applyCameraPreset(name, options = {}) {
  const mode = options.mode || state.cameraMode;
  const preset = getCameraPreset(name, mode);
  if (!preset) return;
  if (options.mode) {
    state.cameraMode = mode;
  }
  state.lastPresetByMode[mode] = name;
  state.lastPreset = name;
  camera.position.set(...preset.pos);
  controls.target.set(...preset.lookAt);
  controls.update();
  const select = $('selCameraMode');
  if (select && select.value !== state.cameraMode) {
    select.value = state.cameraMode;
  }
}

function setCameraMode(mode) {
  if (!mode || !cameraPresets || !cameraPresets[mode]) return;
  if (mode === state.cameraMode) return;
  const presetName = state.lastPresetByMode[mode] || 'catcher';
  applyCameraPreset(presetName, {mode});
}

function updateOverlay(play) {
  $('ovInning').textContent = `Inning: ${play.inning ?? '-'} ${play.topbot ?? '-'}`;
  $('ovOuts'  ).textContent = `Outs: ${play.outs_when_up ?? '-'}`;
  $('ovBatter').textContent = `Batter: ${play.batter ?? '-'}`;
  $('ovEvent' ).textContent = `Event: ${play.event ?? '-'}`;
  $('ovDate'  ).textContent = `Date: ${play.game_date ?? '-'}`;
  $('ovBatTeam').textContent = `Bat Team: ${play.bat_team ?? '-'}`;
  $('ovOppTeam').textContent = `Opp Team: ${play.opp_team ?? '-'}`;
  refreshCanvasOffset();
}

function setupTrajectory(play) {
  clearTrajectory();
  const lineWidth = theme.trajectory?.line_width || 4;
  const color = new THREE.Color(theme.trajectory?.color || '#E03C31');
  const geometry = new LineGeometry();
  const positions = [];
  play.points.forEach(p => { positions.push(p.x, p.y, p.z); });
  geometry.setPositions(positions);
  const material = new LineMaterial({ color, linewidth: lineWidth, transparent: true, worldUnits: false });
  material.opacity = theme.trajectory?.base_opacity ?? 0.35;
  material.resolution.set(renderer.domElement.clientWidth, renderer.domElement.clientHeight);
  const line = new Line2(geometry, material);
  line.computeLineDistances();
  scene.add(line);

  const sourcePositions = new Float32Array(positions);
  const progressGeometry = new THREE.BufferGeometry();
  const progressPositions = new Float32Array(sourcePositions.length);
  const progressAttribute = new THREE.BufferAttribute(progressPositions, 3);
  progressAttribute.setUsage(THREE.DynamicDrawUsage);
  progressGeometry.setAttribute('position', progressAttribute);
  progressGeometry.setDrawRange(0, 0);
  const progressMaterial = new THREE.LineBasicMaterial({color, transparent: true, opacity: 0.95});
  const progressLine = new THREE.Line(progressGeometry, progressMaterial);
  scene.add(progressLine);

  state.trajectoryLine = line;
  state.trajectoryMaterial = material;
  state.trajectory = play.points;
  state.duration = play.points.at(-1).t ?? (play.points.length / 60);
  state.time = 0;
  state.segmentIndex = 0;
  state.progress = {
    line: progressLine,
    geometry: progressGeometry,
    material: progressMaterial,
    sourcePositions,
    drawPositions: progressPositions,
    totalPoints: play.points.length,
    lastDrawn: 0,
  };

  updateBallPosition(0);
  updateTrajectoryProgress(0);
  clock?.stop();
}

function sampleTrajectory(points, t) {
  if (!points.length) return {x:0,y:0,z:0};
  const t0 = points[0].t ?? 0, tn = points.at(-1).t ?? 0;
  if (t <= t0) return {x:points[0].x, y:points[0].y, z:points[0].z};
  if (t >= tn) { const p = points.at(-1); return {x:p.x, y:p.y, z:p.z}; }
  let idx = state.segmentIndex;
  while (idx < points.length - 2 && (points[idx + 1].t ?? 0) < t) idx++;
  while (idx > 0 && (points[idx].t ?? 0) > t) idx--;
  state.segmentIndex = idx;
  const p0 = points[idx], p1 = points[idx + 1];
  const span = (p1.t ?? 0) - (p0.t ?? 0) || 1e-6;
  const a = (t - (p0.t ?? 0)) / span;
  return { x: p0.x + (p1.x - p0.x) * a, y: p0.y + (p1.y - p0.y) * a, z: p0.z + (p1.z - p0.z) * a };
}

function updateBallPosition(time) {
  if (!state.trajectory) return;
  const p = sampleTrajectory(state.trajectory, time);
  ball.position.set(p.x, p.y, p.z);
  if (state.followBall) controls.target.copy(ball.position);
}

function clearTrajectory() {
  if (state.trajectoryLine) {
    scene.remove(state.trajectoryLine);
    state.trajectoryLine.geometry?.dispose?.();
    state.trajectoryMaterial?.dispose?.();
    state.trajectoryLine = null;
    state.trajectoryMaterial = null;
  }
  if (state.progress) {
    if (state.progress.line) scene.remove(state.progress.line);
    state.progress.geometry?.dispose?.();
    state.progress.material?.dispose?.();
    state.progress = null;
  }
  state.trajectory = null;
}

function updateTrajectoryProgress(time) {
  const progress = state.progress;
  if (!progress || !state.trajectory) return;
  if (progress.totalPoints < 2) return;
  const duration = state.duration || (state.trajectory.length / 60);
  const clamped = duration > 0 ? Math.min(Math.max(time, 0), duration) : time;
  const segments = progress.totalPoints - 1;
  let pointsToShow = segments > 0 && duration > 0 ? Math.floor((clamped / duration) * segments) + 1 : progress.totalPoints;
  pointsToShow = Math.min(progress.totalPoints, Math.max(2, pointsToShow));
  if (progress.lastDrawn === pointsToShow) return;
  const source = progress.sourcePositions;
  const target = progress.drawPositions;
  const drawLength = pointsToShow * 3;
  if (pointsToShow === 2 && clamped <= 0) {
    target.set(source.subarray(0, 3));
    target.set(source.subarray(0, 3), 3);
  } else {
    target.set(source.subarray(0, drawLength));
  }
  progress.geometry.setDrawRange(0, pointsToShow);
  progress.geometry.attributes.position.needsUpdate = true;
  progress.lastDrawn = pointsToShow;
}

function attachUI() {
  $('btnStart').addEventListener('click', () => setPlay(0, {autoplay: true}));
  $('btnPrev').addEventListener('click', () => setPlay(Math.max(0, state.currentIndex - 1)));
  $('btnNext').addEventListener('click', () => setPlay(Math.min(state.plays.length - 1, state.currentIndex + 1)));
  $('btnPlayPause').addEventListener('click', () => togglePlay());
  $('chkAuto').addEventListener('change', (e) => (state.autoAdvance = e.target.checked));
  $('selSpeed').addEventListener('change', (e) => (state.speed = parseFloat(e.target.value)));
  document.querySelectorAll('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => applyCameraPreset(btn.dataset.view));
  });
  $('chkFollow').addEventListener('change', (e) => {
    state.followBall = e.target.checked;
    if (state.followBall) controls.target.copy(ball.position);
    else {
      const presetName = state.lastPresetByMode[state.cameraMode] || 'catcher';
      const preset = getCameraPreset(presetName);
      if (preset) controls.target.set(...preset.lookAt);
    }
    controls.update();
  });
  const modeSelect = $('selCameraMode');
  if (modeSelect) {
    modeSelect.addEventListener('change', (e) => setCameraMode(e.target.value));
  }
  const fileInput = $('csvFile');
  const csvButton = $('btnCsvSelect');
  const dropZone = $('csvDropZone');
  if (csvButton && fileInput) {
    csvButton.addEventListener('click', () => fileInput.click());
  }
  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      handleCsvFiles(e.target.files);
      e.target.value = '';
    });
  }
  if (dropZone) {
    const openPicker = () => fileInput?.click();
    dropZone.addEventListener('click', openPicker);
    dropZone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openPicker();
      }
    });
    const activate = (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    };
    const deactivate = (e) => {
      e.preventDefault();
      if (e.target === dropZone) dropZone.classList.remove('dragover');
    };
    dropZone.addEventListener('dragover', activate);
    dropZone.addEventListener('dragenter', activate);
    dropZone.addEventListener('dragleave', deactivate);
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      const files = e.dataTransfer?.files;
      if (files?.length) handleCsvFiles(files);
    });
  }
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    if (!dropZone || dropZone.contains(e.target)) return;
    e.preventDefault();
  });
  refreshCanvasOffset();
  setStatus('Drop or select a Statcast CSV to preview plays in-browser.', 'info', 6000);
}

function togglePlay(force) {
  const desired = typeof force === 'boolean' ? force : !state.playing;
  if (desired && state.trajectory && state.time >= state.duration) {
    state.time = 0;
    state.segmentIndex = 0;
    updateBallPosition(0);
    updateTrajectoryProgress(0);
  }
  state.playing = desired;
  if (state.playing) {
    clock?.start();
    clock?.getDelta();
  } else {
    clock?.stop();
  }
  $('btnPlayPause').textContent = state.playing ? 'Pause' : 'Play';
}

async function handleCsvFiles(fileList) {
  if (!fileList || !fileList.length) return;
  const file = fileList[0];
  try {
    setStatus(`Parsing "${file.name}"…`, 'info', 0);
    const plays = await loadPlaysFromCsv(file);
    if (!plays.length) {
      setStatus(`No playable rows found in ${file.name}`, 'error');
      return;
    }
    state.plays = plays.map(normalizePlay);
    state.currentIndex = 0;
    setPlay(0);
    setStatus(`Loaded ${plays.length} plays from CSV (${file.name})`, 'success');
  } catch (err) {
    console.error('Failed to load CSV', err);
    const message = err && err.message ? err.message : String(err || 'unknown error');
    setStatus(`Failed to load CSV: ${message}`, 'error', 8000);
  }
}

function setPlay(index, options = {}) {
  index = Math.max(0, Math.min(state.plays.length - 1, index));
  state.currentIndex = index;
  const play = state.plays[index];
  if (!play) return;
  updateOverlay(play);
  setupTrajectory(play);
  const autoplay = Boolean(options.autoplay);
  togglePlay(false);
  if (autoplay) togglePlay(true);
}

function animate() {
  requestAnimationFrame(animate);
  const delta = state.playing && clock ? clock.getDelta() : 0;
  if (state.playing && state.trajectory) {
    state.time += state.speed * delta;
    if (state.time >= state.duration) {
      state.time = state.duration;
      togglePlay(false);
      if (state.autoAdvance && state.currentIndex < state.plays.length - 1) {
        setTimeout(() => setPlay(state.currentIndex + 1, {autoplay: true}), 600);
      }
    }
    updateBallPosition(state.time);
  }
  updateTrajectoryProgress(state.time);
  controls.update();
  renderer.render(scene, camera);
}

// ---------- boot ----------
async function init() {
  const ballpark = await loadData();
  setupScene(ballpark);
  attachUI();
  if (state.plays.length) setPlay(0);
  animate();
}
init().catch(err => console.error('Failed to initialise viewer', err));

