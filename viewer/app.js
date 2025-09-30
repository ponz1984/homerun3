// viewer/app.js — 互換モード：配列オブジェクト軌道 & ID指定修正
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {Line2} from 'three/addons/lines/Line2.js';
import {LineGeometry} from 'three/addons/lines/LineGeometry.js';
import {LineMaterial} from 'three/addons/lines/LineMaterial.js';
import {loadPlaysFromCsv} from './physics-lite.js';

const DEFAULT_TRAJECTORY_COLOR = '#2563EB';
const DEFAULT_BALL_COLOR = '#2563EB';
const DEFAULT_APPROACH_CONFIG = {
  nearBehavior: 'stop',
  stopDistance: 14,
  fadeStart: 120,
  fadeEnd: 16,
  dollyRetreat: 24,
};
const YAW_STEP_DEG = 5;
const YAW_SPEED_DEG = 45;
const PAN_STEP = 0.5;
const PAN_SPEED = 6;

const tmpVecA = new THREE.Vector3();
const tmpVecB = new THREE.Vector3();
const tmpVecC = new THREE.Vector3();

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
  trajectoryGuideLine: null,
  trajectoryGuideMaterial: null,
  duration: 0,
  time: 0,
  currentPointIndex: 0,
  progress: null,
  cameraMode: 'infield',
  lastPresetByMode: {infield: 'catcher', outfield: 'cf_stand'},
  lastPreset: 'catcher',
  statusTimer: null,
  showTrajectory: false,
  approachConfig: {...DEFAULT_APPROACH_CONFIG},
  viewAdjust: {
    yawDir: 0,
    panDir: 0,
    yawSpeed: YAW_SPEED_DEG,
    panSpeed: PAN_SPEED,
  },
};

let renderer, scene, camera, controls, ball, theme, cameraPresets, clock;
let adjustLastTime = null;
const activeKeyAdjust = new Set();
let ballparkBounds = null;
const KEY_ADJUST_BINDINGS = {
  a: {type: 'yaw', dir: -1},
  d: {type: 'yaw', dir: 1},
  j: {type: 'pan', dir: -1},
  l: {type: 'pan', dir: 1},
};

const BASE_INFIELD_PRESETS = {
  catcher: {pos: [-5, -20, 6], lookAt: [0, 60, 6]},
  if_high: {pos: [0, -120, 55], lookAt: [0, 140, 10]},
  lf_stand: {pos: [-260, 180, 50], lookAt: [0, 200, 10]},
  cf_stand: {pos: [0, 420, 70], lookAt: [0, 200, 10]},
  rf_stand: {pos: [260, 180, 50], lookAt: [0, 200, 10]},
};

const BASE_OUTFIELD_PRESETS = {
  catcher: {pos: [0, 360, 90], lookAt: [0, 0, 6]},
  if_high: {pos: [0, 460, 140], lookAt: [0, 0, 6]},
  lf_stand: {pos: [-260, 520, 140], lookAt: [0, 0, 6]},
  cf_stand: {pos: [0, 600, 180], lookAt: [0, 0, 6]},
  rf_stand: {pos: [260, 520, 140], lookAt: [0, 0, 6]},
};

const ORIGIN_LOOK_AT = [0, 0, 6];
const OUTFIELD_FRAMING_PRESETS = new Set(['lf_stand', 'cf_stand', 'rf_stand']);

function shouldFrameOutfieldPreset(mode, preset) {
  if (mode !== 'outfield') return false;
  if (!preset) return false;
  return OUTFIELD_FRAMING_PRESETS.has(preset);
}

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

function parseApproachConfig(raw) {
  const config = {...DEFAULT_APPROACH_CONFIG};
  if (!raw || typeof raw !== 'object') return config;
  if (typeof raw.nearBehavior === 'string') {
    const normalized = raw.nearBehavior.toLowerCase();
    if (['stop', 'dolly', 'fade'].includes(normalized)) {
      config.nearBehavior = normalized;
    }
  }
  if (Number.isFinite(raw.stopDistance)) config.stopDistance = Number(raw.stopDistance);
  if (Number.isFinite(raw.fadeStart)) config.fadeStart = Number(raw.fadeStart);
  if (Number.isFinite(raw.fadeEnd)) config.fadeEnd = Number(raw.fadeEnd);
  if (Number.isFinite(raw.dollyRetreat)) config.dollyRetreat = Number(raw.dollyRetreat);
  return config;
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

function buildCameraPresets(raw, baseGroups = {}) {
  const baseInfield = baseGroups.infield || BASE_INFIELD_PRESETS;
  const baseOutfield = baseGroups.outfield || BASE_OUTFIELD_PRESETS;
  if (raw && (raw.infield || raw.outfield)) {
    return {
      infield: mergePresetGroup(baseInfield, raw.infield),
      outfield: mergePresetGroup(baseOutfield, raw.outfield),
      __base: {infield: baseInfield, outfield: baseOutfield},
    };
  }
  return {
    infield: mergePresetGroup(baseInfield, raw),
    outfield: mergePresetGroup(baseOutfield, {}),
    __base: {infield: baseInfield, outfield: baseOutfield},
  };
}

function deriveOutfieldApproachPresets(ballpark) {
  const presets = mergePresetGroup(BASE_OUTFIELD_PRESETS, null);
  const source = (ballpark && Array.isArray(ballpark.fence_top) && ballpark.fence_top.length)
    ? ballpark.fence_top
    : (ballpark && Array.isArray(ballpark.fence_base) && ballpark.fence_base.length)
      ? ballpark.fence_base
      : (ballpark && Array.isArray(ballpark.outline) && ballpark.outline.length ? ballpark.outline : null);
  if (!source) return presets;

  const points = source
    .map((pt) => {
      if (Array.isArray(pt)) {
        return {x: Number(pt[0]) || 0, y: Number(pt[1]) || 0, z: Number(pt[2]) || 0};
      }
      if (pt && typeof pt === 'object') {
        return {x: Number(pt.x) || 0, y: Number(pt.y) || 0, z: Number(pt.z) || 0};
      }
      return null;
    })
    .filter(Boolean);
  if (!points.length) return presets;

  const selectByRange = (minDeg, maxDeg) => {
    let best = null;
    let bestRadius = -Infinity;
    for (const pt of points) {
      const angle = THREE.MathUtils.radToDeg(Math.atan2(pt.x, pt.y));
      if (angle < minDeg || angle > maxDeg) continue;
      const radius = Math.hypot(pt.x, pt.y);
      if (radius > bestRadius) {
        best = pt;
        bestRadius = radius;
      }
    }
    return best;
  };

  const selectFallback = () => {
    let best = points[0];
    let bestRadius = Math.hypot(best.x, best.y);
    for (let i = 1; i < points.length; i++) {
      const radius = Math.hypot(points[i].x, points[i].y);
      if (radius > bestRadius) {
        bestRadius = radius;
        best = points[i];
      }
    }
    return best;
  };

  const ranges = {
    lf_stand: [[-80, -40], [-100, -30]],
    cf_stand: [[-8, 8], [-12, 12]],
    rf_stand: [[40, 80], [30, 100]],
  };
  const standConfigs = {
    lf_stand: {distance: 130, height: 150},
    cf_stand: {distance: 160, height: 180},
    rf_stand: {distance: 130, height: 150},
  };

  for (const [stand, searchRanges] of Object.entries(ranges)) {
    let candidate = null;
    for (const [minDeg, maxDeg] of searchRanges) {
      candidate = selectByRange(minDeg, maxDeg);
      if (candidate) break;
    }
    if (!candidate) candidate = selectFallback();
    if (!candidate) continue;
    const cfg = standConfigs[stand] || {distance: 130, height: 150};
    tmpVecA.set(candidate.x, candidate.y, 0);
    const radius = tmpVecA.length();
    if (radius === 0) continue;
    tmpVecA.normalize();
    tmpVecB.copy(tmpVecA).multiplyScalar(cfg.distance);
    const pos = [
      candidate.x + tmpVecB.x,
      candidate.y + tmpVecB.y,
      (candidate.z || 0) + cfg.height,
    ];
    presets[stand] = {pos, lookAt: [...ORIGIN_LOOK_AT]};
  }

  return presets;
}

function getCameraPreset(name, mode = state.cameraMode) {
  const selectedMode = mode || state.cameraMode;
  const modePresets = (cameraPresets && cameraPresets[selectedMode]) || {};
  const baseGroup = (cameraPresets && cameraPresets.__base && cameraPresets.__base[selectedMode])
    || (selectedMode === 'outfield' ? BASE_OUTFIELD_PRESETS : BASE_INFIELD_PRESETS);
  const fallbackGroup = baseGroup || (selectedMode === 'outfield' ? BASE_OUTFIELD_PRESETS : BASE_INFIELD_PRESETS);
  const fallbackPreset = fallbackGroup[name] || BASE_INFIELD_PRESETS[name] || BASE_INFIELD_PRESETS.catcher;
  const preset = modePresets[name] || fallbackPreset;
  if (!preset) return null;
  const posFallback = fallbackPreset.pos || BASE_INFIELD_PRESETS.catcher.pos;
  const lookFallback = fallbackPreset.lookAt || BASE_INFIELD_PRESETS.catcher.lookAt;
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
  let points = [];
  // {points: [{t,x,y,z}, ...]}
  if (Array.isArray(traj.points)) {
    points = traj.points.map((p, idx) => {
      const t = Number(p?.t);
      return {
        t: Number.isFinite(t) ? t : idx / 60,
        x: p?.x,
        y: p?.y,
        z: p?.z ?? 0,
      };
    });
    return ensureMonotonicTimes(points);
  }
  // {samples: [[t,x,y,z], ...]}
  if (Array.isArray(traj.samples)) {
    points = traj.samples.map(([t, x, y, z], idx) => ({
      t: Number.isFinite(t) ? Number(t) : idx / 60,
      x,
      y,
      z: z ?? 0,
    }));
    return ensureMonotonicTimes(points);
  }
  // {t:[], x:[], y:[], z:[]}
  if (Array.isArray(traj.t) && Array.isArray(traj.x) && Array.isArray(traj.y) && Array.isArray(traj.z)) {
    const n = Math.min(traj.t.length, traj.x.length, traj.y.length, traj.z.length);
    points = [];
    for (let i = 0; i < n; i++) {
      const t = Number(traj.t[i]);
      points.push({
        t: Number.isFinite(t) ? t : i / 60,
        x: traj.x[i],
        y: traj.y[i],
        z: traj.z[i] ?? 0,
      });
    }
    return ensureMonotonicTimes(points);
  }
  // [[x,y,z]] or [[t,x,y,z]]
  if (Array.isArray(traj) && Array.isArray(traj[0])) {
    points = traj.map((a, idx) => (a.length === 4
      ? ({t: Number.isFinite(a[0]) ? Number(a[0]) : idx / 60, x: a[1], y: a[2], z: a[3] ?? 0})
      : ({t: idx / 60, x: a[0], y: a[1], z: a[2] ?? 0})));
    return ensureMonotonicTimes(points);
  }
  // ★ 配列の中がオブジェクト [{x:..,y:..,z:..,t?}, ...] に対応
  if (Array.isArray(traj) && typeof traj[0] === 'object' && traj[0] !== null && 'x' in traj[0] && 'y' in traj[0]) {
    points = traj.map((p, idx) => {
      const t = 't' in p ? Number(p.t) : idx / 60;
      return {
        t: Number.isFinite(t) ? t : idx / 60,
        x: p.x,
        y: p.y,
        z: ('z' in p ? p.z : 0),
      };
    });
    return ensureMonotonicTimes(points);
  }
  console.warn('Unknown trajectory shape:', traj);
  return [];
}

function ensureMonotonicTimes(points) {
  if (!Array.isArray(points) || points.length === 0) return [];
  const fallbackStep = 1 / 60;
  let last = Number(points[0].t);
  if (!Number.isFinite(last)) {
    last = 0;
  }
  points[0].t = last;
  for (let i = 1; i < points.length; i++) {
    let t = Number(points[i].t);
    if (!Number.isFinite(t)) t = last + fallbackStep;
    if (t <= last) t = last + fallbackStep;
    points[i].t = t;
    last = t;
  }
  return points;
}

// ---------- data load ----------
async function loadData() {
  const [config, playlist] = await Promise.all([
    fetchJSON('config.json'),
    fetchJSON('playlist.json'),
  ]);
  theme = config.theme || {};
  state.approachConfig = parseApproachConfig(theme.approach || {});
  const outfieldDefaults = deriveOutfieldApproachPresets(config.ballpark || {});
  cameraPresets = buildCameraPresets(config.camera_presets || {}, {outfield: outfieldDefaults});
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

function resetBallparkBounds() {
  if (!ballparkBounds) ballparkBounds = new THREE.Box3();
  ballparkBounds.makeEmpty();
}

function expandBallparkBounds(point) {
  if (!point) return;
  if (!ballparkBounds) resetBallparkBounds();
  ballparkBounds.expandByPoint(point);
}

function getBallparkBounds() {
  if (!ballparkBounds || ballparkBounds.isEmpty()) return null;
  return ballparkBounds;
}

// ---------- scene ----------
function setupScene(ballpark) {
  const canvas = $('glcanvas');
  renderer = new THREE.WebGLRenderer({canvas, antialias: true});
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setClearColor(theme.background || '#f5f7fb');

  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 10000);
  camera.up.set(0, 0, 1);
  scene = new THREE.Scene();

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 180, 6);
  controls.minPolarAngle = THREE.MathUtils.degToRad(10);
  controls.maxPolarAngle = THREE.MathUtils.degToRad(88);
  controls.minDistance = 60;
  controls.maxDistance = 2500;
  controls.update();

  const ballColor = theme.trajectory?.ball_color || theme.trajectory?.color || DEFAULT_BALL_COLOR;
  const ballRadius = theme.trajectory?.ball_radius ?? 1.5;
  const ballMaterial = new THREE.MeshBasicMaterial({color: ballColor});
  if (state.approachConfig.nearBehavior === 'fade') {
    ballMaterial.transparent = true;
    ballMaterial.opacity = 1;
  }
  ball = new THREE.Mesh(new THREE.SphereGeometry(ballRadius, 32, 32), ballMaterial);
  ball.visible = false;
  ball.userData.baseOpacity = ballMaterial.opacity;
  scene.add(ball);
  resetBallAppearance();

  resetBallparkBounds();
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
  const toVec = (p) => {
    if (!p) return null;
    if (Array.isArray(p)) {
      const x = Number(p[0]) || 0;
      const y = Number(p[1]) || 0;
      const z = Number(p[2]) || 0;
      return new THREE.Vector3(x, y, z);
    }
    if (typeof p === 'object') {
      const x = Number(p.x) || 0;
      const y = Number(p.y) || 0;
      const z = Number(p.z) || 0;
      return new THREE.Vector3(x, y, z);
    }
    return null;
  };
  const mapPoints = (arr) => {
    if (!Array.isArray(arr)) return [];
    return arr.map(toVec).filter((pt) => {
      if (!pt) return false;
      expandBallparkBounds(pt);
      return true;
    });
  };

  if (ballpark && Array.isArray(ballpark.fence_base) && Array.isArray(ballpark.fence_top)) {
    const basePts = mapPoints(ballpark.fence_base);
    if (basePts.length) {
      const baseGeom = new THREE.BufferGeometry().setFromPoints(basePts);
      scene.add(new THREE.LineLoop(baseGeom, material));
    }
    const topPts = mapPoints(ballpark.fence_top);
    if (topPts.length) {
      const topGeom  = new THREE.BufferGeometry().setFromPoints(topPts);
      scene.add(new THREE.LineLoop(topGeom, material));
    }
    if (Array.isArray(ballpark.wall_segments)) {
      const wallPts = [];
      ballpark.wall_segments.forEach((seg) => {
        if (!Array.isArray(seg) || seg.length < 2) return;
        const a = toVec(seg[0]);
        const b = toVec(seg[1]);
        if (a) {
          wallPts.push(a.x, a.y, a.z);
          expandBallparkBounds(a);
        }
        if (b) {
          wallPts.push(b.x, b.y, b.z);
          expandBallparkBounds(b);
        }
      });
      if (wallPts.length) {
        const wallGeom = new THREE.BufferGeometry();
        wallGeom.setAttribute('position', new THREE.Float32BufferAttribute(wallPts, 3));
        scene.add(new THREE.LineSegments(wallGeom, material));
      }
    }
    if (Array.isArray(ballpark.foul_lines)) {
      ballpark.foul_lines.forEach((line) => {
        const pts = mapPoints(line);
        if (!pts.length) return;
        const geom = new THREE.BufferGeometry().setFromPoints(pts);
        scene.add(new THREE.Line(geom, material));
      });
    }
    if (Array.isArray(ballpark.outline)) {
      const outlinePts = mapPoints(ballpark.outline);
      if (outlinePts.length) {
        const outlineGeom = new THREE.BufferGeometry().setFromPoints(outlinePts);
        scene.add(new THREE.LineLoop(outlineGeom, material));
      }
    }
    return;
  }

  // fallback（簡易外野弧＋ファウルライン）
  const pts = [];
  for (let a = -90; a <= 90; a += 2) {
    const r = 400;
    const rad = a * Math.PI / 180;
    const pt = new THREE.Vector3(r * Math.sin(rad), r * Math.cos(rad), 0);
    pts.push(pt);
    expandBallparkBounds(pt);
  }
  scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), material));
  const h = 8;
  const top = pts.map((p) => {
    const t = new THREE.Vector3(p.x, p.y, h);
    expandBallparkBounds(t);
    return t;
  });
  scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(top), material));
  for (let i = 0; i < pts.length; i += 10) {
    const bottom = pts[i];
    const upper = top[i];
    if (bottom) expandBallparkBounds(bottom);
    if (upper) expandBallparkBounds(upper);
    scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([bottom, upper]), material));
  }
  const foulLeft = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(-330, 0, 0)];
  const foulRight = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(330, 0, 0)];
  foulLeft.forEach(expandBallparkBounds);
  foulRight.forEach(expandBallparkBounds);
  scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(foulLeft), material));
  scene.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(foulRight), material));
}

function frameBallpark(options = {}) {
  if (!camera || !controls) return;
  const bounds = getBallparkBounds();
  if (!bounds) return;
  const center = bounds.getCenter(tmpVecA);
  const size = bounds.getSize(tmpVecB);
  const radius = 0.5 * Math.max(size.x, size.y);
  if (!Number.isFinite(radius) || radius <= 0) return;
  const marginRaw = Number(options.margin);
  const margin = Number.isFinite(marginRaw) ? Math.max(1, marginRaw) : 1.2;
  const vFov = THREE.MathUtils.degToRad(camera.fov);
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const minFov = Math.min(vFov, hFov);
  if (!(minFov > 0)) return;
  const need = radius / Math.tan(minFov / 2) * margin;
  const dir = tmpVecC.copy(camera.position).sub(center);
  if (dir.lengthSq() < 1e-6) {
    dir.set(0, -1, 0);
  } else {
    dir.normalize();
  }
  camera.position.copy(center).addScaledVector(dir, need);
  const target = (state.followBall && ball) ? ball.position : center;
  controls.target.copy(target);
  camera.updateProjectionMatrix();
  controls.update();
}

function handleResize() {
  const canvas = renderer.domElement;
  const w = canvas.clientWidth, h = canvas.clientHeight || 1;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (state.trajectoryMaterial) state.trajectoryMaterial.resolution.set(w, h);
  if (state.trajectoryGuideMaterial) state.trajectoryGuideMaterial.resolution.set(w, h);
}

function handleWindowResize() {
  refreshCanvasOffset();
  handleResize();
  if (shouldFrameOutfieldPreset(state.cameraMode, state.lastPreset)) {
    frameBallpark();
  }
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
  if (state.followBall && ball) {
    controls.target.copy(ball.position);
  } else {
    controls.target.set(...preset.lookAt);
  }
  controls.update();
  resetViewAdjust();
  if (shouldFrameOutfieldPreset(state.cameraMode, name)) {
    frameBallpark();
  }
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
  const color = new THREE.Color(theme.trajectory?.color || DEFAULT_TRAJECTORY_COLOR);
  const geometry = new LineGeometry();
  const positions = [];
  play.points.forEach((p) => {
    const x = Number(p.x) || 0;
    const y = Number(p.y) || 0;
    const z = Number(p.z) || 0;
    positions.push(x, y, z);
  });
  geometry.setPositions(positions);
  geometry.setDrawRange(0, 0);
  const material = new LineMaterial({ color, linewidth: lineWidth, transparent: true, worldUnits: false });
  material.opacity = theme.trajectory?.base_opacity ?? 0.95;
  material.resolution.set(renderer.domElement.clientWidth, renderer.domElement.clientHeight);
  const line = new Line2(geometry, material);
  line.computeLineDistances();
  line.visible = state.showTrajectory;
  scene.add(line);

  let guideLine = null;
  let guideMaterial = null;
  const fullPathOpacity = Number(theme.trajectory?.full_path_opacity ?? 0);
  if (fullPathOpacity > 0) {
    const guideGeometry = new LineGeometry();
    guideGeometry.setPositions(positions);
    const gm = new LineMaterial({color, linewidth: lineWidth, transparent: true, worldUnits: false});
    gm.opacity = fullPathOpacity;
    gm.resolution.set(renderer.domElement.clientWidth, renderer.domElement.clientHeight);
    guideMaterial = gm;
    guideLine = new Line2(guideGeometry, gm);
    guideLine.computeLineDistances();
    guideLine.visible = true;
    scene.add(guideLine);
  }

  state.trajectoryLine = line;
  state.trajectoryMaterial = material;
  state.trajectoryGuideLine = guideLine;
  state.trajectoryGuideMaterial = guideMaterial;
  state.trajectory = play.points;
  const lastPoint = play.points.at(-1);
  const lastTime = lastPoint != null ? Number(lastPoint.t) : null;
  state.duration = Number.isFinite(lastTime) ? lastTime : (play.points.length / 60);
  state.time = 0;
  state.showTrajectory = false;
  if (ball) ball.visible = false;
  if (state.trajectoryLine) state.trajectoryLine.visible = false;
  state.progress = {
    geometry,
    pointCount: play.points.length,
    lastDrawCount: -1,
    lastIndex: -1,
  };

  state.currentPointIndex = 0;
  updateBallPosition(0);
  updateTrajectoryProgress(0);
  clock?.stop();
}

function timeToIndex(points, time) {
  if (!Array.isArray(points) || points.length === 0) return 0;
  const n = points.length;
  if (!Number.isFinite(time) || time <= (points[0].t ?? 0)) return 0;
  const lastTime = points[n - 1].t ?? 0;
  if (time >= lastTime) return n - 1;
  let lo = 0;
  let hi = n - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    const mt = points[mid].t ?? 0;
    if (time >= mt) lo = mid;
    else hi = mid;
  }
  return lo;
}

function updateBallPosition(time) {
  if (!state.trajectory || !ball) return;
  const points = state.trajectory;
  const idx = timeToIndex(points, time);
  const p = points[idx] || points[0];
  state.currentPointIndex = idx;
  const px = Number(p.x);
  const py = Number(p.y);
  const pz = Number(p.z);
  tmpVecB.set(Number.isFinite(px) ? px : 0, Number.isFinite(py) ? py : 0, Number.isFinite(pz) ? pz : 0);
  applyApproachAdjustments(tmpVecB);
  ball.position.copy(tmpVecB);
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
  if (state.trajectoryGuideLine) {
    scene.remove(state.trajectoryGuideLine);
    state.trajectoryGuideLine.geometry?.dispose?.();
    state.trajectoryGuideMaterial?.dispose?.();
    state.trajectoryGuideLine = null;
    state.trajectoryGuideMaterial = null;
  }
  state.progress = null;
  state.trajectory = null;
  state.showTrajectory = false;
  state.currentPointIndex = 0;
  if (ball) ball.visible = false;
}

function getLineDelaySegments() {
  const raw = theme?.animation?.line_delay_segments;
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.floor(raw));
}

function updateTrajectoryProgress(time) {
  const progress = state.progress;
  const points = state.trajectory;
  if (!progress || !points) return;
  const pointCount = progress.pointCount || points.length;
  if (!Number.isFinite(pointCount) || pointCount < 2) {
    progress.geometry.setDrawRange(0, 0);
    progress.lastDrawCount = 0;
    if (state.trajectoryLine) state.trajectoryLine.visible = false;
    return;
  }
  if (!state.showTrajectory) {
    progress.geometry.setDrawRange(0, 0);
    progress.lastDrawCount = 0;
    if (state.trajectoryLine) state.trajectoryLine.visible = false;
    return;
  }
  let idx = timeToIndex(points, time);
  if (!Number.isFinite(idx)) idx = 0;
  if (idx < 0) idx = 0;
  if (idx >= points.length) idx = points.length - 1;
  state.currentPointIndex = idx;
  const delay = getLineDelaySegments();
  const rawVisible = Math.min(pointCount, idx + 1 - delay);
  let drawCount;
  if (rawVisible <= 0) {
    drawCount = Math.min(pointCount, pointCount >= 2 ? 2 : 0);
  } else {
    drawCount = Math.max(2, rawVisible);
  }
  drawCount = Math.min(pointCount, Math.max(0, Math.floor(drawCount)));
  if (progress.lastDrawCount === drawCount && progress.lastIndex === idx) {
    if (state.trajectoryLine) state.trajectoryLine.visible = state.showTrajectory && drawCount >= 2;
    return;
  }
  progress.geometry.setDrawRange(0, drawCount);
  progress.lastDrawCount = drawCount;
  progress.lastIndex = idx;
  if (state.trajectoryLine) state.trajectoryLine.visible = state.showTrajectory && drawCount >= 2;
}

function resetBallAppearance() {
  if (!ball) return;
  const mat = ball.material;
  if (!mat) return;
  const baseOpacity = ball.userData?.baseOpacity ?? 1;
  let needsUpdate = false;
  if (state.approachConfig.nearBehavior === 'fade') {
    if (!mat.transparent) { mat.transparent = true; needsUpdate = true; }
  } else if (mat.transparent) {
    mat.transparent = false;
    needsUpdate = true;
  }
  if (Math.abs((mat.opacity ?? 1) - baseOpacity) > 0.01) {
    mat.opacity = baseOpacity;
    needsUpdate = true;
  }
  if (needsUpdate) mat.needsUpdate = true;
  ball.scale.set(1, 1, 1);
}

function applyApproachAdjustments(position) {
  if (!camera || !controls) return position;
  const config = state.approachConfig || DEFAULT_APPROACH_CONFIG;
  if (state.cameraMode !== 'outfield') {
    resetBallAppearance();
    return position;
  }

  const behavior = config.nearBehavior || 'stop';
  const camPos = camera.position;
  const dist = position.distanceTo(camPos);

  if (behavior === 'fade') {
    const fadeStart = Math.max(Number(config.fadeStart) || DEFAULT_APPROACH_CONFIG.fadeStart, 1);
    const fadeEndRaw = Number(config.fadeEnd) || DEFAULT_APPROACH_CONFIG.fadeEnd;
    const fadeEnd = Math.max(0.5, Math.min(fadeStart - 0.5, fadeEndRaw));
    let opacity = 1;
    if (dist <= fadeEnd) {
      opacity = 0.12;
    } else if (dist < fadeStart) {
      const t = (dist - fadeEnd) / Math.max(fadeStart - fadeEnd, 1);
      opacity = 0.12 + Math.max(0, Math.min(1, t)) * 0.88;
    }
    const mat = ball.material;
    if (mat) {
      if (!mat.transparent) { mat.transparent = true; mat.needsUpdate = true; }
      const clamped = Math.max(0.12, Math.min(1, opacity));
      if (Math.abs((mat.opacity ?? 1) - clamped) > 0.01) {
        mat.opacity = clamped;
        mat.needsUpdate = true;
      }
    }
  } else {
    resetBallAppearance();
  }

  if (behavior === 'stop') {
    const minDist = Math.max(2, Number(config.stopDistance) || DEFAULT_APPROACH_CONFIG.stopDistance);
    if (dist < minDist) {
      tmpVecC.copy(position).sub(camPos);
      if (tmpVecC.lengthSq() > 1e-6) {
        tmpVecC.setLength(minDist);
        position.copy(camPos).add(tmpVecC);
      }
    }
  } else if (behavior === 'dolly') {
    const minDist = Math.max(4, Number(config.stopDistance) || DEFAULT_APPROACH_CONFIG.stopDistance);
    if (dist < minDist) {
      tmpVecC.copy(camera.position).sub(controls.target);
      if (tmpVecC.lengthSq() > 1e-6) {
        const retreatBase = Number(config.dollyRetreat) || DEFAULT_APPROACH_CONFIG.dollyRetreat;
        const retreat = Math.max(minDist - dist, 0) + Math.max(retreatBase, 0) * 0.02;
        const newLength = tmpVecC.length() + retreat;
        tmpVecC.setLength(newLength);
        camera.position.copy(controls.target).add(tmpVecC);
      }
    }
  }

  return position;
}

function resetViewAdjust() {
  state.viewAdjust.yawDir = 0;
  state.viewAdjust.panDir = 0;
  adjustLastTime = null;
  activeKeyAdjust.clear();
}

function applyYawStep(amountDeg) {
  if (!camera || !controls || !Number.isFinite(amountDeg) || amountDeg === 0) return;
  tmpVecA.copy(camera.position).sub(controls.target);
  const angle = THREE.MathUtils.degToRad(amountDeg);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const x = tmpVecA.x;
  const y = tmpVecA.y;
  tmpVecA.x = cos * x - sin * y;
  tmpVecA.y = sin * x + cos * y;
  camera.position.copy(tmpVecB.copy(controls.target).add(tmpVecA));
}

function applyPanStep(amount) {
  if (!controls || !Number.isFinite(amount) || amount === 0) return;
  controls.pan(amount, 0);
}

function startAdjust(type, dir) {
  const prop = type === 'yaw' ? 'yawDir' : 'panDir';
  if (state.viewAdjust[prop] === dir) return;
  state.viewAdjust[prop] = dir;
  adjustLastTime = null;
}

function stopAdjust(type, dir) {
  const prop = type === 'yaw' ? 'yawDir' : 'panDir';
  if (state.viewAdjust[prop] === dir) {
    state.viewAdjust[prop] = 0;
    adjustLastTime = null;
  }
}

function applyAdjustStep(type, dir) {
  if (type === 'yaw') applyYawStep(dir * YAW_STEP_DEG);
  else applyPanStep(dir * PAN_STEP);
}

function updateViewAdjust() {
  const {yawDir, panDir, yawSpeed, panSpeed} = state.viewAdjust;
  if (!yawDir && !panDir) {
    adjustLastTime = null;
    return;
  }
  const now = performance.now();
  if (adjustLastTime == null) {
    adjustLastTime = now;
    return;
  }
  const deltaSec = Math.min((now - adjustLastTime) / 1000, 0.2);
  adjustLastTime = now;
  if (yawDir) applyYawStep(yawDir * yawSpeed * deltaSec);
  if (panDir) applyPanStep(panDir * panSpeed * deltaSec);
}

function isInteractiveElement(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (!tag) return false;
  return ['INPUT', 'SELECT', 'TEXTAREA'].includes(tag) || el.isContentEditable;
}

function bindAdjustButton(id, type, dir) {
  const el = $(id);
  if (!el) return;
  let pointerActive = false;
  const pointerDown = (e) => {
    if (typeof e.button === 'number' && e.button !== 0) return;
    pointerActive = true;
    e.preventDefault();
    applyAdjustStep(type, dir);
    startAdjust(type, dir);
  };
  const pointerEnd = () => {
    if (!pointerActive) return;
    pointerActive = false;
    stopAdjust(type, dir);
  };
  const pointerCancel = () => {
    if (!pointerActive) return;
    pointerActive = false;
    stopAdjust(type, dir);
  };
  el.addEventListener('pointerdown', pointerDown);
  el.addEventListener('pointerup', pointerEnd);
  el.addEventListener('pointerleave', pointerCancel);
  el.addEventListener('pointercancel', pointerCancel);
  el.addEventListener('click', (e) => {
    if (e.detail !== 0) {
      e.preventDefault();
      return;
    }
    e.preventDefault();
    applyAdjustStep(type, dir);
  });
}

function handleKeyDownAdjust(e) {
  const key = typeof e.key === 'string' ? e.key.toLowerCase() : '';
  const binding = KEY_ADJUST_BINDINGS[key];
  if (!binding) return;
  if (isInteractiveElement(e.target)) return;
  const token = `${binding.type}:${binding.dir}`;
  if (activeKeyAdjust.has(token)) return;
  activeKeyAdjust.add(token);
  applyAdjustStep(binding.type, binding.dir);
  startAdjust(binding.type, binding.dir);
  e.preventDefault();
}

function handleKeyUpAdjust(e) {
  const key = typeof e.key === 'string' ? e.key.toLowerCase() : '';
  const binding = KEY_ADJUST_BINDINGS[key];
  if (!binding) return;
  const token = `${binding.type}:${binding.dir}`;
  if (activeKeyAdjust.has(token)) {
    activeKeyAdjust.delete(token);
    stopAdjust(binding.type, binding.dir);
    e.preventDefault();
  }
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
  [
    ['btnYawLeft', 'yaw', -1],
    ['btnYawRight', 'yaw', 1],
    ['btnPanLeft', 'pan', -1],
    ['btnPanRight', 'pan', 1],
  ].forEach(([id, type, dir]) => bindAdjustButton(id, type, dir));
  window.addEventListener('keydown', handleKeyDownAdjust);
  window.addEventListener('keyup', handleKeyUpAdjust);
  window.addEventListener('blur', () => resetViewAdjust());
  $('chkFollow').addEventListener('change', (e) => {
    state.followBall = e.target.checked;
    if (state.followBall) controls.target.copy(ball.position);
    else {
      const presetName = state.lastPresetByMode[state.cameraMode] || 'catcher';
      const preset = getCameraPreset(presetName);
      if (preset) controls.target.set(...preset.lookAt);
    }
    resetViewAdjust();
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
    state.currentPointIndex = 0;
    updateBallPosition(0);
    updateTrajectoryProgress(0);
  }
  if (desired && state.trajectory) {
    if (!state.showTrajectory) {
      state.showTrajectory = true;
      updateTrajectoryProgress(state.time);
    }
    if (ball) ball.visible = true;
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
  updateViewAdjust();
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

