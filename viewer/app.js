// viewer/app.js — 互換モード：配列オブジェクト軌道 & ID指定修正
import * as THREE from 'three';
import {OrbitControls} from 'three/addons/controls/OrbitControls.js';
import {Line2} from 'three/addons/lines/Line2.js';
import {LineGeometry} from 'three/addons/lines/LineGeometry.js';
import {LineMaterial} from 'three/addons/lines/LineMaterial.js';
import {loadPlaysFromCsv} from './physics-lite.js';

const DEFAULT_TRAJECTORY_COLOR = '#DC2626';
const DEFAULT_TRAJECTORY_BALL_COLOR = '#DC2626';
const DEFAULT_TRAJECTORY_LINE_WIDTH = 6;
const DEFAULT_ANIMATION_DURATION_SECONDS = 1.5;
const DEFAULT_ANIMATION_MODE = 'sync_line_and_ball';
const DEFAULT_BALL_RADIUS = 1.0;
const MIN_TIME_EPSILON = 1e-4;
const POSITION_EPSILON = 1e-4;
const EASING_FUNCTIONS = {
  linear: (t) => t,
  inoutcubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
};
const PLAY_STATE = {READY: 'ready', PLAYING: 'playing', FINISHED: 'finished'};
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
const DEBUG_TRAJ = (() => {
  if (typeof window === 'undefined') return false;
  if (typeof window.DEBUG_TRAJ !== 'undefined') {
    const val = Number(window.DEBUG_TRAJ);
    if (Number.isFinite(val)) return val !== 0;
  }
  try {
    const params = new URLSearchParams(window.location.search || '');
    const raw = params.get('DEBUG_TRAJ');
    if (raw != null) return Number(raw) !== 0;
  } catch (err) {
    console.warn('Failed to parse DEBUG_TRAJ param', err);
  }
  return false;
})();

const $ = (id) => document.getElementById(id);

const state = {
  plays: [],
  currentIndex: 0,
  playing: false,
  playState: PLAY_STATE.READY,
  autoAdvance: false,
  followBall: false,
  speedFactor: 1,
  trajectoryMaterial: null,
  trajectoryLine: null,
  trajectoryBall: null,
  duration: 0,
  elapsed: 0,
  currentPointIndex: 0,
  visiblePoints: 0,
  ease: (t) => t,
  trajectoryPoints: [],
  effectiveDuration: DEFAULT_ANIMATION_DURATION_SECONDS,
  animationMode: DEFAULT_ANIMATION_MODE,
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

function toFiniteNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function isTrajectoryData(value) {
  if (!value) return false;
  if (Array.isArray(value)) {
    if (value.length === 0) return true;
    return value.some((item) => Array.isArray(item) || (item && typeof item === 'object'));
  }
  if (typeof value === 'object') {
    if (Array.isArray(value.points) || Array.isArray(value.samples)) return true;
    if (Array.isArray(value.t) || Array.isArray(value.x) || Array.isArray(value.y)) return true;
    if ('x' in value && 'y' in value) return true;
  }
  return false;
}

function extractTrajectorySource(raw) {
  if (!raw || typeof raw !== 'object') return {path: '', data: null};
  let path = '';
  let data = null;
  const candidates = [raw.trajectory, raw.trajectory_file, raw.points];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (isTrajectoryData(candidate)) {
      data = candidate;
      break;
    }
    if (!path && typeof candidate === 'string') {
      path = candidate;
    }
  }
  if (!path && typeof raw.trajectory_path === 'string') {
    path = raw.trajectory_path;
  }
  return {path, data};
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
  const {path, data} = extractTrajectorySource(p);
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
    trajectory_path: typeof path === 'string' ? path : '',
    trajectory_data: data ?? null,
  };
}
// 軌道JSONを [{t,x,y,z}, …] に正規化
function distanceFromHome(point) {
  if (!point) return 0;
  const x = Number(point.x) || 0;
  const y = Number(point.y) || 0;
  return Math.hypot(x, y);
}

function dedupeSequentialPoints(points) {
  if (!Array.isArray(points) || points.length === 0) return [];
  const result = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const prev = result[result.length - 1];
    const curr = points[i];
    if (!curr) continue;
    if (
      Math.abs(curr.x - prev.x) <= POSITION_EPSILON &&
      Math.abs(curr.y - prev.y) <= POSITION_EPSILON &&
      Math.abs(curr.z - prev.z) <= POSITION_EPSILON
    ) {
      continue;
    }
    result.push(curr);
  }
  return result;
}

function computeCumulativeDistances(points) {
  const distances = new Array(points.length).fill(0);
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const curr = points[i];
    const dx = curr.x - prev.x;
    const dy = curr.y - prev.y;
    const dz = curr.z - prev.z;
    const step = Math.hypot(dx, dy, dz);
    total += step;
    distances[i] = total;
  }
  return distances;
}

function isStrictlyIncreasing(values) {
  if (!Array.isArray(values) || values.length === 0) return false;
  let last = values[0];
  for (let i = 1; i < values.length; i++) {
    const v = values[i];
    if (!(v > last + POSITION_EPSILON)) return false;
    last = v;
  }
  return true;
}

function orientTrajectoryPoints(points) {
  if (!Array.isArray(points) || points.length < 2) return points;
  let reversed = false;
  const startDist = distanceFromHome(points[0]);
  const endDist = distanceFromHome(points[points.length - 1]);
  if (!(startDist < endDist)) {
    points.reverse();
    reversed = !reversed;
  }
  const forwardDistances = computeCumulativeDistances(points);
  if (!isStrictlyIncreasing(forwardDistances)) {
    points.reverse();
    reversed = !reversed;
  }
  if (DEBUG_TRAJ) {
    console.debug('normalizeTrajectory orientation', {reversed});
  }
  return points;
}

function finalizeTrajectoryPoints(points) {
  const prepared = Array.isArray(points)
    ? points.filter((p) => p && typeof p === 'object')
    : [];
  if (!prepared.length) return [];
  const filtered = prepared.filter((p) => (
    Number.isFinite(p.x) &&
    Number.isFinite(p.y) &&
    Number.isFinite(p.z)
  ));
  if (!filtered.length) return [];
  const finiteTimes = filtered
    .map((p) => Number(p.t))
    .filter((t) => Number.isFinite(t));
  if (finiteTimes.length >= 2) {
    filtered.sort((a, b) => {
      const ta = Number(a.t);
      const tb = Number(b.t);
      const aFinite = Number.isFinite(ta);
      const bFinite = Number.isFinite(tb);
      if (aFinite && bFinite && ta !== tb) return ta - tb;
      if (aFinite && !bFinite) return -1;
      if (!aFinite && bFinite) return 1;
      return (a.order ?? 0) - (b.order ?? 0);
    });
  } else {
    filtered.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }
  const deduped = dedupeSequentialPoints(filtered);
  if (deduped.length < 2) {
    deduped.forEach((p) => { if ('order' in p) delete p.order; });
    return deduped;
  }
  orientTrajectoryPoints(deduped);
  deduped.forEach((p) => {
    if ('order' in p) delete p.order;
  });
  return ensureMonotonicTimes(deduped);
}

function normalizeTrajectory(traj) {
  if (!traj) return [];
  const points = [];
  const addPoint = (x, y, z, t, order) => {
    points.push({
      x: toFiniteNumber(x, 0),
      y: toFiniteNumber(y, 0),
      z: toFiniteNumber(z, 0),
      t: Number.isFinite(Number(t)) ? Number(t) : NaN,
      order: Number.isFinite(order) ? order : points.length,
    });
  };

  if (Array.isArray(traj.points)) {
    traj.points.forEach((p, idx) => {
      if (!p) return;
      if (Array.isArray(p)) {
        const [t, x, y, z] = p;
        if (p.length === 4) addPoint(x, y, z, t, idx);
        else addPoint(p[0], p[1], p[2], idx / 60, idx);
        return;
      }
      addPoint(p.x, p.y, p.z, p.t, idx);
    });
    return finalizeTrajectoryPoints(points);
  }
  if (Array.isArray(traj.samples)) {
    traj.samples.forEach((sample, idx) => {
      if (!Array.isArray(sample)) return;
      if (sample.length === 4) {
        const [t, x, y, z] = sample;
        addPoint(x, y, z, t, idx);
      } else if (sample.length >= 3) {
        addPoint(sample[0], sample[1], sample[2], idx / 60, idx);
      }
    });
    return finalizeTrajectoryPoints(points);
  }
  if (Array.isArray(traj.t) && Array.isArray(traj.x) && Array.isArray(traj.y) && Array.isArray(traj.z)) {
    const n = Math.min(traj.t.length, traj.x.length, traj.y.length, traj.z.length);
    for (let i = 0; i < n; i++) {
      addPoint(traj.x[i], traj.y[i], traj.z[i], traj.t[i], i);
    }
    return finalizeTrajectoryPoints(points);
  }
  if (Array.isArray(traj) && Array.isArray(traj[0])) {
    traj.forEach((row, idx) => {
      if (!Array.isArray(row)) return;
      if (row.length === 4) {
        const [t, x, y, z] = row;
        addPoint(x, y, z, t, idx);
      } else if (row.length >= 3) {
        addPoint(row[0], row[1], row[2], idx / 60, idx);
      }
    });
    return finalizeTrajectoryPoints(points);
  }
  if (Array.isArray(traj) && typeof traj[0] === 'object' && traj[0] !== null && ('x' in traj[0] || 'y' in traj[0])) {
    traj.forEach((p, idx) => {
      if (!p || typeof p !== 'object') return;
      addPoint(p.x, p.y, p.z, 't' in p ? p.t : idx / 60, idx);
    });
    return finalizeTrajectoryPoints(points);
  }
  if (typeof traj === 'object') {
    const {points: nestedPoints} = traj;
    if (Array.isArray(nestedPoints)) {
      nestedPoints.forEach((p, idx) => {
        if (!p) return;
        addPoint(p.x, p.y, p.z, p.t, idx);
      });
      return finalizeTrajectoryPoints(points);
    }
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
  const halfRank = (tb) => (String(tb ?? 'Top').toLowerCase().startsWith('top') ? 0 : 1);
  const compareGame = (a, b) => {
    const pkA = Number(a.game_pk);
    const pkB = Number(b.game_pk);
    const pkAFinite = Number.isFinite(pkA);
    const pkBFinite = Number.isFinite(pkB);
    if (pkAFinite && pkBFinite && pkA !== pkB) return pkA - pkB;
    if (pkAFinite && !pkBFinite) return -1;
    if (!pkAFinite && pkBFinite) return 1;
    const dateA = String(a.game_date || '');
    const dateB = String(b.game_date || '');
    const dateCmp = dateA.localeCompare(dateB);
    if (dateCmp !== 0) return dateCmp;
    const idA = String(a.game_pk ?? a.game_id ?? a.game ?? dateA ?? '');
    const idB = String(b.game_pk ?? b.game_id ?? b.game ?? dateB ?? '');
    return idA.localeCompare(idB);
  };
  const parseSeq = (play) => {
    const numericCandidates = [
      play.play_index,
      play.play_number,
      play.play_seq,
      play.sequence,
      play.index,
      play.at_bat_index,
      play.pitch_number,
    ];
    for (const candidate of numericCandidates) {
      const num = Number(candidate);
      if (Number.isFinite(num)) return num;
    }
    const idCandidates = [play.play_id, play.playid, play.event_id, play.at_bat_id];
    for (const id of idCandidates) {
      const str = String(id || '');
      if (!str) continue;
      const match = str.match(/(\d+)$/);
      if (match) return parseInt(match[1], 10);
    }
    return Number.MAX_SAFE_INTEGER;
  };

  const decorated = plays.map((play, idx) => ({play, idx}));
  decorated.sort((a, b) => {
    const gameCmp = compareGame(a.play, b.play);
    if (gameCmp !== 0) return gameCmp;
    const inningCmp = (Number(a.play.inning) || 0) - (Number(b.play.inning) || 0);
    if (inningCmp !== 0) return inningCmp;
    const halfCmp = halfRank(a.play.topbot ?? a.play.inning_half) - halfRank(b.play.topbot ?? b.play.inning_half);
    if (halfCmp !== 0) return halfCmp;
    const seqCmp = parseSeq(a.play) - parseSeq(b.play);
    if (seqCmp !== 0) return seqCmp;
    return a.idx - b.idx;
  });
  return decorated.map((entry) => entry.play);
}

function getConfiguredAnimationDuration() {
  const raw = theme?.animation?.duration_seconds;
  if (raw == null) return DEFAULT_ANIMATION_DURATION_SECONDS;
  const num = Number(raw);
  if (Number.isFinite(num) && num > 0) return num;
  return DEFAULT_ANIMATION_DURATION_SECONDS;
}

function getAnimationMode() {
  const raw = String(theme?.animation?.mode || DEFAULT_ANIMATION_MODE).toLowerCase();
  if (raw === 'line_only') return 'line_only';
  return 'sync_line_and_ball';
}

function interpolateSegment(basePositions, startIndex, endIndex, alpha, out) {
  const sOffset = startIndex * 3;
  const eOffset = endIndex * 3;
  const sx = basePositions[sOffset];
  const sy = basePositions[sOffset + 1];
  const sz = basePositions[sOffset + 2];
  const ex = basePositions[eOffset];
  const ey = basePositions[eOffset + 1];
  const ez = basePositions[eOffset + 2];
  out.set(
    sx + (ex - sx) * alpha,
    sy + (ey - sy) * alpha,
    sz + (ez - sz) * alpha,
  );
  return out;
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
    const normalized = normalizePlay(rp);
    let points = [];
    const directSource = normalized.trajectory_data ?? normalized.points ?? rp.points ?? null;
    if (directSource) {
      points = normalizeTrajectory(directSource);
    }
    if ((!points || points.length === 0) && typeof normalized.trajectory_path === 'string' && normalized.trajectory_path) {
      try {
        const trajRaw = await fetchJSON(normalized.trajectory_path);
        points = normalizeTrajectory(trajRaw);
      } catch (err) {
        console.error(`Failed to load trajectory at ${normalized.trajectory_path}`, err);
        points = [];
      }
    }
    const playEntry = {...normalized, points};
    delete playEntry.trajectory_data;
    plays.push(playEntry);
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
  if (state.trajectoryMaterial) {
    state.trajectoryMaterial.resolution.set(w, h);
  }
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

function computeTrajectoryDuration(points) {
  if (!Array.isArray(points) || points.length < 2) return 0;
  const times = points
    .map((p) => Number(p.t))
    .filter((t) => Number.isFinite(t));
  if (times.length >= 2) {
    const minTime = Math.min(...times);
    const maxTime = Math.max(...times);
    const duration = Math.max(maxTime - minTime, 0);
    if (duration > MIN_TIME_EPSILON) return duration;
  }
  return getConfiguredAnimationDuration();
}

function updateEffectiveDuration() {
  const base = state.duration > MIN_TIME_EPSILON ? state.duration : getConfiguredAnimationDuration();
  const speed = Number.isFinite(state.speedFactor) && state.speedFactor > 0 ? state.speedFactor : 1;
  const effective = base / speed;
  const previous = state.effectiveDuration > MIN_TIME_EPSILON ? state.effectiveDuration : base;
  state.effectiveDuration = effective > MIN_TIME_EPSILON ? effective : MIN_TIME_EPSILON;
  if (previous > MIN_TIME_EPSILON && state.effectiveDuration > MIN_TIME_EPSILON) {
    const progress = state.elapsed / previous;
    state.elapsed = Math.max(0, Math.min(state.effectiveDuration, progress * state.effectiveDuration));
  } else if (state.elapsed > state.effectiveDuration) {
    state.elapsed = state.effectiveDuration;
  }
}

function applyTrajectoryIndex(index, {force = false, activate = false} = {}) {
  const points = state.trajectoryPoints;
  const total = Array.isArray(points) ? points.length : 0;
  if (!state.trajectoryLine || total < 2) return;
  const geometry = state.trajectoryLine.geometry;
  const clamped = Math.max(0, Math.min(total - 1, index));
  const target = force ? clamped : Math.max(state.currentPointIndex, clamped);
  const drawCount = Math.max(2, Math.min(total, target + 1));
  geometry.setDrawRange(0, drawCount);
  state.visiblePoints = drawCount;
  state.currentPointIndex = target;
  const point = points[target];
  if (point) {
    lineTip.set(point.x, point.y, point.z);
    if (state.trajectoryBall) {
      state.trajectoryBall.position.set(point.x, point.y, point.z);
    }
  }
  if (activate) {
    state.trajectoryLine.visible = true;
    if (state.trajectoryBall) setBallVisibility(true);
  }
  if (DEBUG_TRAJ) {
    console.debug('trajectory progress', {
      N: total,
      duration: state.duration,
      effectiveDuration: state.effectiveDuration,
      k: target,
      s: total > 1 ? target / (total - 1) : 0,
    });
  }
}

function prepareTrajectoryForStart() {
  state.elapsed = 0;
  state.playing = false;
  state.playState = PLAY_STATE.READY;
  state.currentPointIndex = 0;
  state.visiblePoints = 0;
  updateEffectiveDuration();
  if (state.trajectoryLine) {
    applyTrajectoryIndex(0, {force: true});
    state.trajectoryLine.visible = false;
    state.trajectoryLine.renderOrder = 20;
    state.visiblePoints = 0;
  }
  if (state.trajectoryBall) {
    const point = state.trajectoryPoints[0];
    if (point) {
      state.trajectoryBall.position.set(point.x, point.y, point.z);
      lineTip.set(point.x, point.y, point.z);
    } else {
      state.trajectoryBall.position.set(0, 0, 0);
      lineTip.set(0, 0, 0);
    }
    if (state.trajectoryPoints.length >= 2) {
      setBallVisibility(false);
    } else {
      setBallVisibility(true);
    }
    state.trajectoryBall.renderOrder = 21;
  } else {
    if (state.trajectoryPoints.length) {
      const first = state.trajectoryPoints[0];
      lineTip.set(first.x, first.y, first.z);
    } else {
      lineTip.set(0, 0, 0);
    }
  }
}

function setupTrajectory(play) {
  clearTrajectory();
  const rawPoints = Array.isArray(play.points) ? play.points : [];
  const normalized = normalizeTrajectory(rawPoints);
  state.animationMode = getAnimationMode();
  const showBall = state.animationMode !== 'line_only';
  const shouldCreateBall = showBall || normalized.length < 2;
  const lineWidthRaw = theme?.trajectory?.line_width;
  const parsedLineWidth = Number(lineWidthRaw);
  const lineWidth = Number.isFinite(parsedLineWidth) && parsedLineWidth > 0 ? parsedLineWidth : DEFAULT_TRAJECTORY_LINE_WIDTH;
  const lineColor = new THREE.Color(theme?.trajectory?.color || DEFAULT_TRAJECTORY_COLOR);
  const ballColor = new THREE.Color(theme?.trajectory?.ball_color || theme?.trajectory?.color || DEFAULT_TRAJECTORY_BALL_COLOR);
  const radiusRaw = Number(theme?.trajectory?.ball_radius);
  const ballRadius = Number.isFinite(radiusRaw) && radiusRaw > 0 ? radiusRaw : DEFAULT_BALL_RADIUS;
  state.trajectoryPoints = normalized;
  state.duration = computeTrajectoryDuration(normalized);
  state.ease = EASING_FUNCTIONS[String(theme?.animation?.ease || 'linear').toLowerCase()] || EASING_FUNCTIONS.linear;

  if (normalized.length >= 2) {
    const positions = new Float32Array(normalized.length * 3);
    normalized.forEach((p, idx) => {
      const offset = idx * 3;
      positions[offset] = p.x;
      positions[offset + 1] = p.y;
      positions[offset + 2] = p.z;
    });
    const geometry = new LineGeometry();
    geometry.setPositions(positions);
    geometry.setDrawRange(0, Math.min(2, normalized.length));
    const material = new LineMaterial({
      color: lineColor,
      linewidth: lineWidth,
      transparent: false,
      depthTest: false,
      depthWrite: false,
      worldUnits: false,
      vertexColors: false,
    });
    material.resolution.set(renderer.domElement.clientWidth, renderer.domElement.clientHeight);
    const line = new Line2(geometry, material);
    line.renderOrder = 20;
    line.material.visible = true;
    line.visible = false;
    scene.add(line);
    state.trajectoryLine = line;
    state.trajectoryMaterial = material;

    if (shouldCreateBall) {
      const ballGeom = new THREE.SphereGeometry(ballRadius, 16, 16);
      const ballMat = new THREE.MeshBasicMaterial({color: ballColor});
      ballMat.depthTest = false;
      ballMat.depthWrite = false;
      const ball = new THREE.Mesh(ballGeom, ballMat);
      ball.renderOrder = 21;
      ball.visible = false;
      scene.add(ball);
      state.trajectoryBall = ball;
    }
  } else {
    if (normalized.length === 1) {
      const single = normalized[0];
      lineTip.set(single.x, single.y, single.z);
    } else {
      lineTip.set(0, 0, 0);
    }
    if (shouldCreateBall) {
      const ballGeom = new THREE.SphereGeometry(ballRadius, 16, 16);
      const ballMat = new THREE.MeshBasicMaterial({color: ballColor});
      ballMat.depthTest = false;
      ballMat.depthWrite = false;
      const ball = new THREE.Mesh(ballGeom, ballMat);
      ball.renderOrder = 21;
      ball.visible = true;
      if (normalized.length === 1) {
        ball.position.set(normalized[0].x, normalized[0].y, normalized[0].z);
      } else {
        ball.position.set(0, 0, 0);
      }
      scene.add(ball);
      state.trajectoryBall = ball;
    }
    if (normalized.length < 2) {
      console.warn('WARN: too few points', {count: normalized.length});
    }
  }

  prepareTrajectoryForStart();
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
  if (state.trajectoryBall) {
    scene.remove(state.trajectoryBall);
    state.trajectoryBall.geometry?.dispose?.();
    state.trajectoryBall.material?.dispose?.();
    state.trajectoryBall = null;
  }
  state.trajectoryPoints = [];
  state.duration = 0;
  state.elapsed = 0;
  state.currentPointIndex = 0;
  state.visiblePoints = 0;
  state.playState = PLAY_STATE.READY;
  state.playing = false;
  updateEffectiveDuration();
  lineTip.set(0, 0, 0);
}

function hasTrajectoryTip() {
  return Array.isArray(state.trajectoryPoints) && state.trajectoryPoints.length > 0;
}

function updateFollowTarget(force = false) {
  if (!controls) return;
  if (!state.followBall) return;
  if (!hasTrajectoryTip()) return;
  if (!force && state.playState === PLAY_STATE.READY) return;
  controls.target.copy(lineTip);
  controls.update();
}

function setBallVisibility(visible) {
  if (!state.trajectoryBall) return;
  state.trajectoryBall.visible = !!visible;
}


function restartCurrentPlay() {
  prepareTrajectoryForStart();
  updateFollowTarget(true);
}

function finishPlayback() {
  if (state.playState === PLAY_STATE.FINISHED) return;
  const points = state.trajectoryPoints;
  const total = Array.isArray(points) ? points.length : 0;
  if (total >= 2 && state.trajectoryLine) {
    applyTrajectoryIndex(total - 1, {force: true, activate: true});
  } else if (total === 1 && state.trajectoryBall) {
    const only = points[0];
    state.trajectoryBall.position.set(only.x, only.y, only.z);
    setBallVisibility(true);
  }
  state.elapsed = state.effectiveDuration;
  state.playing = false;
  state.playState = PLAY_STATE.FINISHED;
  clock?.stop();
  $('btnPlayPause').textContent = 'Play';
  updateFollowTarget();
  if (state.autoAdvance && state.currentIndex < state.plays.length - 1) {
    setTimeout(() => setPlay(state.currentIndex + 1, {autoplay: true}), 400);
  }
}

function advanceTrajectory(delta) {
  if (!state.playing || state.playState !== PLAY_STATE.PLAYING) return;
  const points = state.trajectoryPoints;
  const total = Array.isArray(points) ? points.length : 0;
  if (total < 2 || !state.trajectoryLine) {
    finishPlayback();
    return;
  }
  const effective = state.effectiveDuration > MIN_TIME_EPSILON ? state.effectiveDuration : MIN_TIME_EPSILON;
  state.elapsed += delta;
  if (state.elapsed < 0) state.elapsed = 0;
  if (state.elapsed > effective) state.elapsed = effective;
  const fractionRaw = effective > 0 ? state.elapsed / effective : 1;
  const clampedFraction = Math.max(0, Math.min(1, fractionRaw));
  const eased = state.ease ? state.ease(clampedFraction) : clampedFraction;
  const s = Math.max(0, Math.min(1, eased));
  const rawIndex = s * (total - 1);
  const k = Math.min(total - 1, Math.max(0, Math.floor(rawIndex + 1e-6)));
  applyTrajectoryIndex(k, {activate: true});
  updateFollowTarget();
  if (state.elapsed >= effective - MIN_TIME_EPSILON || s >= 1) {
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
    updateEffectiveDuration();
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
  const totalPoints = Array.isArray(state.trajectoryPoints) ? state.trajectoryPoints.length : 0;
  if (!state.trajectoryLine || totalPoints < 2) {
    if (desired) finishPlayback();
    state.playing = false;
    $('btnPlayPause').textContent = 'Play';
    return;
  }
  if (desired) {
    if (state.playState === PLAY_STATE.FINISHED || state.playState === PLAY_STATE.READY) {
      restartCurrentPlay();
    }
    state.playState = PLAY_STATE.PLAYING;
    state.playing = true;
    applyTrajectoryIndex(state.currentPointIndex, {force: true, activate: true});
    if (state.trajectoryBall && state.animationMode !== 'line_only') {
      setBallVisibility(true);
    }
    updateFollowTarget(true);
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
    const normalized = plays.map((play) => {
      const base = normalizePlay(play);
      let points = [];
      const source = base.trajectory_data ?? base.points ?? play.points ?? null;
      if (source) {
        points = normalizeTrajectory(source);
      }
      const entry = {...base, points};
      delete entry.trajectory_data;
      return entry;
    });
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
  if (state.playing) {
    advanceTrajectory(delta);
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

