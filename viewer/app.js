// viewer/app.js — 互換モード：配列オブジェクト軌道 & ID指定修正
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {Line2} from 'three/addons/lines/Line2.js';
import {LineGeometry} from 'three/addons/lines/LineGeometry.js';
import {LineMaterial} from 'three/addons/lines/LineMaterial.js';
import {loadPlaysFromCsv} from './physics-lite.js';

const DEFAULT_TRAJECTORY_COLOR = '#2563EB';
const DEFAULT_ANIMATION_SPEED_FT_PER_SEC = 150;
const EASING_FUNCTIONS = {
  linear: (t) => t,
  inoutcubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
};
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
const lineTip = new THREE.Vector3();

const $ = (id) => document.getElementById(id);

const state = {
  plays: [],
  currentIndex: 0,
  playing: false,
  autoAdvance: false,
  followBall: false,
  speedFactor: 1,
  trajectory: null,          // [{t,x,y,z}, ...]
  trajectoryMaterial: null,
  trajectoryLine: null,
  duration: 0,
  elapsed: 0,
  currentPointIndex: 0,
  visiblePoints: 0,
  ease: (t) => t,
  finished: false,
  cameraMode: 'infield',
  lastPresetByMode: {infield: 'catcher', outfield: 'cf_stand'},
  lastPreset: 'catcher',
  statusTimer: null,
  approachConfig: {...DEFAULT_APPROACH_CONFIG},
  viewAdjust: {
    yawDir: 0,
    panDir: 0,
    yawSpeed: YAW_SPEED_DEG,
    panSpeed: PAN_SPEED,
  },
};

let renderer, scene, camera, controls, theme, cameraPresets, clock;
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

function sortPlaysChrono(plays) {
  const halfRank = (tb) => (String(tb).toLowerCase().startsWith('top') ? 0 : 1);
  const parseSeq = (pid) => {
    const m = String(pid || '').match(/-(\d+)$/);
    return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
  };
  return [...plays].sort((a, b) => (
    (Number(a.inning) || 0) - (Number(b.inning) || 0)
    || (halfRank(a.topbot ?? a.inning_half) - halfRank(b.topbot ?? b.inning_half))
    || (parseSeq(a.play_id) - parseSeq(b.play_id))
  ));
}

function getAnimationSpeed() {
  const themeSpeed = Number(theme?.animation?.ft_per_sec);
  if (Number.isFinite(themeSpeed) && themeSpeed > 0) return themeSpeed;
  return DEFAULT_ANIMATION_SPEED_FT_PER_SEC;
}

function computeDistanceDuration(points, speed) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  let distance = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const ax = Number(a.x) || 0;
    const ay = Number(a.y) || 0;
    const az = Number(a.z) || 0;
    const bx = Number(b.x) || 0;
    const by = Number(b.y) || 0;
    const bz = Number(b.z) || 0;
    distance += Math.hypot(bx - ax, by - ay, bz - az);
  }
  if (!Number.isFinite(distance) || distance <= 0 || !Number.isFinite(speed) || speed <= 0) return 0;
  return distance / speed;
}

function computeTotalDuration(points) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  const last = points[points.length - 1];
  const lastTime = Number(last?.t);
  if (Number.isFinite(lastTime) && lastTime > 0) return lastTime;
  const distDuration = computeDistanceDuration(points, getAnimationSpeed());
  if (distDuration > 0) return distDuration;
  return Math.max((points.length - 1) / 60, 1);
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
  state.plays = sortPlaysChrono(plays);
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
  const target = (state.followBall && hasTrajectoryTip()) ? lineTip : center;
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
  if (state.followBall && hasTrajectoryTip()) {
    controls.target.copy(lineTip);
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

function updateOverlay(info) {
  $('ovInning').textContent = `Inning: ${info.inning ?? '-'} ${info.topbot ?? '-'}`;
  $('ovOuts'  ).textContent = `Outs: ${info.outs ?? '-'}`;
  $('ovBatter').textContent = `Batter: ${info.batter ?? '-'}`;
  $('ovEvent' ).textContent = `Event: ${info.event ?? '-'}`;
  $('ovDate'  ).textContent = `Date: ${info.date ?? '-'}`;
  $('ovBatTeam').textContent = `Bat Team: ${info.bat ?? '-'}`;
  $('ovOppTeam').textContent = `Opp Team: ${info.opp ?? '-'}`;
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
  const material = new LineMaterial({color, linewidth: lineWidth, transparent: true, worldUnits: false});
  material.opacity = theme.trajectory?.base_opacity ?? 0.95;
  material.resolution.set(renderer.domElement.clientWidth, renderer.domElement.clientHeight);
  const line = new Line2(geometry, material);
  line.computeLineDistances();
  line.visible = false;
  scene.add(line);

  state.trajectoryLine = line;
  state.trajectoryMaterial = material;
  state.trajectory = play.points;
  state.duration = computeTotalDuration(play.points);
  state.elapsed = 0;
  state.currentPointIndex = 0;
  state.visiblePoints = 0;
  state.finished = false;
  lineTip.set(0, 0, 0);
  const easeName = String(theme?.animation?.ease || 'linear').toLowerCase();
  state.ease = EASING_FUNCTIONS[easeName] || EASING_FUNCTIONS.linear;
  if (play.points.length) {
    const first = play.points[0];
    lineTip.set(Number(first.x) || 0, Number(first.y) || 0, Number(first.z) || 0);
  }
  updateFollowTarget(true);
  clock?.stop();
}

function clearTrajectory() {
  if (state.trajectoryLine) {
    scene.remove(state.trajectoryLine);
    state.trajectoryLine.geometry?.dispose?.();
    state.trajectoryMaterial?.dispose?.();
    state.trajectoryLine = null;
    state.trajectoryMaterial = null;
  }
  state.trajectory = null;
  state.duration = 0;
  state.elapsed = 0;
  state.currentPointIndex = 0;
  state.visiblePoints = 0;
  state.finished = false;
}

function hasTrajectoryTip() {
  return Array.isArray(state.trajectory) && state.trajectory.length > 0;
}

function updateLineTipFromIndex(index) {
  if (!hasTrajectoryTip()) return;
  const maxIndex = state.trajectory.length - 1;
  const clamped = Math.max(0, Math.min(index, maxIndex));
  const point = state.trajectory[clamped] || state.trajectory[0];
  const x = Number(point?.x) || 0;
  const y = Number(point?.y) || 0;
  const z = Number(point?.z) || 0;
  lineTip.set(x, y, z);
  state.currentPointIndex = clamped;
}

function setDrawCount(count) {
  if (!state.trajectoryLine) return;
  const total = hasTrajectoryTip() ? state.trajectory.length : 0;
  const clamped = Math.max(0, Math.min(count, total));
  state.visiblePoints = clamped;
  state.trajectoryLine.geometry?.setDrawRange(0, clamped);
  const shouldShow = clamped >= 2 || (total <= 1 && clamped > 0);
  state.trajectoryLine.visible = shouldShow;
  if (clamped > 0) updateLineTipFromIndex(clamped - 1);
}

function updateFollowTarget(force = false) {
  if (!controls) return;
  if (!state.followBall) return;
  if (!hasTrajectoryTip()) return;
  if (!force && state.visiblePoints <= 0) return;
  controls.target.copy(lineTip);
  controls.update();
}

function restartCurrentPlay() {
  state.elapsed = 0;
  state.finished = false;
  if (!state.trajectoryLine) return;
  const total = hasTrajectoryTip() ? state.trajectory.length : 0;
  if (total <= 0) {
    setDrawCount(0);
    state.trajectoryLine.visible = false;
    return;
  }
  const initial = total >= 2 ? 2 : total;
  setDrawCount(initial);
  updateFollowTarget(true);
  if (state.duration <= 0 && total > 0) {
    // Fall back to instant finish if duration is zero.
    setDrawCount(total);
    state.elapsed = state.duration;
    state.finished = true;
  }
}

function finishPlayback() {
  if (state.finished) return;
  state.finished = true;
  state.playing = false;
  clock?.stop();
  $('btnPlayPause').textContent = 'Play';
  updateFollowTarget();
  if (state.autoAdvance && state.currentIndex < state.plays.length - 1) {
    setTimeout(() => setPlay(state.currentIndex + 1, {autoplay: true}), 400);
  }
}

function advanceLineAnimation(delta) {
  if (!state.playing) return;
  if (!hasTrajectoryTip() || !state.trajectoryLine) return;
  const total = state.trajectory.length;
  if (total <= 0) {
    finishPlayback();
    return;
  }
  if (total === 1) {
    setDrawCount(1);
    state.elapsed = state.duration;
    finishPlayback();
    return;
  }
  const totalDuration = state.duration > 0 ? state.duration : 1;
  state.elapsed += delta * state.speedFactor;
  let fraction = state.elapsed / totalDuration;
  if (!Number.isFinite(fraction)) fraction = 1;
  fraction = Math.max(0, Math.min(1, fraction));
  const easedRaw = state.ease ? state.ease(fraction) : fraction;
  const eased = Math.max(0, Math.min(1, easedRaw));
  let drawTarget = Math.floor(eased * total);
  if (drawTarget < 2) drawTarget = 2;
  if (drawTarget > total) drawTarget = total;
  if (drawTarget !== state.visiblePoints) {
    setDrawCount(drawTarget);
    updateFollowTarget();
  } else if (state.followBall && state.visiblePoints > 0) {
    updateLineTipFromIndex(state.visiblePoints - 1);
    updateFollowTarget();
  }
  if (fraction >= 1) {
    setDrawCount(total);
    state.elapsed = state.duration;
    finishPlayback();
  }
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
  $('selSpeed').addEventListener('change', (e) => {
    const value = parseFloat(e.target.value);
    state.speedFactor = Number.isFinite(value) ? value : 1;
  });
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
    if (state.followBall) {
      updateFollowTarget(true);
    } else {
      const presetName = state.lastPresetByMode[state.cameraMode] || 'catcher';
      const preset = getCameraPreset(presetName);
      if (preset) controls.target.set(...preset.lookAt);
      controls.update();
    }
    resetViewAdjust();
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
  if (!state.trajectory || !state.trajectoryLine) {
    state.playing = false;
    $('btnPlayPause').textContent = 'Play';
    return;
  }
  if (desired) {
    if (state.finished || state.visiblePoints === 0 || state.visiblePoints >= state.trajectory.length) {
      restartCurrentPlay();
    }
    state.finished = false;
    state.playing = true;
    clock?.start();
    clock?.getDelta();
  } else {
    state.playing = false;
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
    const normalized = plays.map(normalizePlay);
    state.plays = sortPlaysChrono(normalized);
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
  if (!state.plays.length) return;
  const clamped = Math.max(0, Math.min(state.plays.length - 1, index));
  togglePlay(false);
  state.currentIndex = clamped;
  const play = state.plays[clamped];
  if (!play) return;
  updateOverlay({
    inning: play.inning,
    topbot: play.topbot ?? toTopBot(play.inning_half),
    outs: play.outs_when_up ?? play.outs,
    batter: play.batter ?? play.player_name,
    event: play.event ?? play.events,
    date: play.game_date,
    bat: play.bat_team,
    opp: play.opp_team,
  });
  setupTrajectory(play);
  $('btnPlayPause').textContent = 'Play';
  if (options.autoplay) {
    togglePlay(true);
  }
}

function animate() {
  requestAnimationFrame(animate);
  const delta = state.playing && clock ? clock.getDelta() : 0;
  if (state.playing && state.trajectory) {
    advanceLineAnimation(delta);
  }
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

