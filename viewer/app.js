import * as THREE from 'https://unpkg.com/three@0.160.0/build/three.module.js';
import {OrbitControls} from 'https://unpkg.com/three@0.160.0/examples/jsm/controls/OrbitControls.js';
import {Line2} from 'https://unpkg.com/three@0.160.0/examples/jsm/lines/Line2.js';
import {LineGeometry} from 'https://unpkg.com/three@0.160.0/examples/jsm/lines/LineGeometry.js';
import {LineMaterial} from 'https://unpkg.com/three@0.160.0/examples/jsm/lines/LineMaterial.js';

const $ = (id) => document.getElementById(id);

const state = {
  plays: [],
  currentIndex: 0,
  playing: false,
  autoAdvance: false,
  followBall: false,
  speed: 1,
  trajectory: null,
  trajectoryMaterial: null,
  trajectoryLine: null,
  duration: 0,
  time: 0,
  segmentIndex: 0,
  lastPreset: 'catcher',
};

let renderer;
let camera;
let controls;
let scene;
let ball;
let theme;
let cameraPresets;
let clock;

async function loadData() {
  const [config, playlist] = await Promise.all([
    fetch('config.json').then((r) => r.json()),
    fetch('playlist.json').then((r) => r.json()),
  ]);
  theme = config.theme || {};
  cameraPresets = config.camera_presets || {};
  const plays = playlist.plays || [];
  const trajectories = await Promise.all(
    plays.map(async (play) => {
      const points = await fetch(play.trajectory).then((r) => r.json());
      return {...play, points};
    }),
  );
  state.plays = trajectories;
  return config.ballpark;
}

function setupScene(ballpark) {
  const canvas = $('glcanvas');
  renderer = new THREE.WebGLRenderer({canvas, antialias: true});
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setClearColor(theme.background || '#f5f7fb');
  camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
  scene = new THREE.Scene();

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.set(0, 180, 6);

  const ballColor = theme.trajectory?.ball_color || theme.trajectory?.color || '#E03C31';
  const ballGeometry = new THREE.SphereGeometry(1.5, 32, 32);
  const ballMaterial = new THREE.MeshBasicMaterial({color: ballColor});
  ball = new THREE.Mesh(ballGeometry, ballMaterial);
  scene.add(ball);

  addBallparkWireframe(ballpark);
  addGroundGrid();
  applyCameraPreset('catcher');

  window.addEventListener('resize', handleResize);
  handleResize();
  clock = new THREE.Clock();
  clock.stop();
}

function addGroundGrid() {
  if (!theme.ground_grid || theme.ground_grid.enabled === false) return;
  const size = 600;
  const divisions = 24;
  const color = new THREE.Color(theme.ground_grid.line_color || '#E5E9F2');
  const grid = new THREE.GridHelper(size, divisions, color, color);
  grid.material.opacity = 0.35;
  grid.material.transparent = true;
  grid.rotation.x = Math.PI / 2;
  scene.add(grid);
}

function addBallparkWireframe(ballpark) {
  const lineColor = new THREE.Color(theme.ballpark?.line_color || '#8892a6');
  const lineWidth = theme.ballpark?.line_width || 1;
  const material = new THREE.LineBasicMaterial({color: lineColor, linewidth: lineWidth});

  const fenceBase = ballpark.fence_base.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
  const baseGeometry = new THREE.BufferGeometry().setFromPoints(fenceBase);
  const baseLine = new THREE.LineLoop(baseGeometry, material);
  scene.add(baseLine);

  const fenceTop = ballpark.fence_top.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
  const topGeometry = new THREE.BufferGeometry().setFromPoints(fenceTop);
  const topLine = new THREE.LineLoop(topGeometry, material);
  scene.add(topLine);

  const wallPoints = [];
  ballpark.wall_segments.forEach((segment) => {
    wallPoints.push(...segment[0], ...segment[1]);
  });
  if (wallPoints.length) {
    const wallGeometry = new THREE.BufferGeometry();
    wallGeometry.setAttribute('position', new THREE.Float32BufferAttribute(wallPoints, 3));
    const wallLines = new THREE.LineSegments(wallGeometry, material);
    scene.add(wallLines);
  }

  const foulMaterial = new THREE.LineBasicMaterial({color: lineColor, linewidth: lineWidth});
  ballpark.foul_lines.forEach((line) => {
    const geom = new THREE.BufferGeometry().setFromPoints(
      line.map((p) => new THREE.Vector3(p[0], p[1], p[2])),
    );
    scene.add(new THREE.Line(geom, foulMaterial));
  });
}

function handleResize() {
  const canvas = renderer.domElement;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  if (state.trajectoryMaterial) {
    state.trajectoryMaterial.resolution.set(width, height);
  }
}

function applyCameraPreset(name) {
  const preset = cameraPresets[name] || cameraPresets.catcher;
  if (!preset) return;
  state.lastPreset = name;
  camera.position.set(...preset.pos);
  controls.target.set(...preset.lookAt);
  controls.update();
}

function updateOverlay(play) {
  $('ovInning').textContent = `Inning: ${play.inning} ${play.inning_half}`;
  $('ovOuts').textContent = `Outs: ${play.outs}`;
  $('ovBatter').textContent = `Batter: ${play.player_name}`;
  $('ovEvent').textContent = `Event: ${play.events}`;
}

function setupTrajectory(play) {
  if (state.trajectoryLine) {
    scene.remove(state.trajectoryLine);
    state.trajectoryLine.geometry.dispose();
    state.trajectoryMaterial.dispose();
  }
  const lineWidth = theme.trajectory?.line_width || 4;
  const color = new THREE.Color(theme.trajectory?.color || '#E03C31');
  const geometry = new LineGeometry();
  const positions = [];
  play.points.forEach((p) => {
    positions.push(p.x, p.y, p.z);
  });
  geometry.setPositions(positions);
  const material = new LineMaterial({
    color,
    linewidth: lineWidth,
    transparent: false,
    worldUnits: false,
  });
  material.resolution.set(renderer.domElement.clientWidth, renderer.domElement.clientHeight);
  const line = new Line2(geometry, material);
  line.computeLineDistances();
  state.trajectoryLine = line;
  state.trajectoryMaterial = material;
  scene.add(line);
  state.trajectory = play.points;
  state.duration = play.points.at(-1).t;
  state.time = 0;
  state.segmentIndex = 0;
  updateBallPosition(0);
  clock?.start();
}

function updateBallPosition(time) {
  if (!state.trajectory) return;
  const sample = sampleTrajectory(state.trajectory, time);
  ball.position.set(sample.x, sample.y, sample.z);
  if (state.followBall) {
    controls.target.copy(ball.position);
  }
}

function sampleTrajectory(points, t) {
  if (t <= points[0].t) {
    return {x: points[0].x, y: points[0].y, z: points[0].z};
  }
  if (t >= points.at(-1).t) {
    const p = points.at(-1);
    return {x: p.x, y: p.y, z: p.z};
  }
  let idx = state.segmentIndex;
  while (idx < points.length - 2 && points[idx + 1].t < t) idx++;
  while (idx > 0 && points[idx].t > t) idx--;
  state.segmentIndex = idx;
  const p0 = points[idx];
  const p1 = points[idx + 1];
  const span = p1.t - p0.t || 1e-6;
  const alpha = (t - p0.t) / span;
  return {
    x: p0.x + (p1.x - p0.x) * alpha,
    y: p0.y + (p1.y - p0.y) * alpha,
    z: p0.z + (p1.z - p0.z) * alpha,
  };
}

function attachUI(ballpark) {
  $('#btnStart').addEventListener('click', () => setPlay(0));
  $('#btnPrev').addEventListener('click', () => setPlay(Math.max(0, state.currentIndex - 1)));
  $('#btnNext').addEventListener('click', () => setPlay(Math.min(state.plays.length - 1, state.currentIndex + 1)));
  $('#btnPlayPause').addEventListener('click', () => togglePlay());
  $('#chkAuto').addEventListener('change', (e) => (state.autoAdvance = e.target.checked));
  $('#selSpeed').addEventListener('change', (e) => (state.speed = parseFloat(e.target.value)));
  document.querySelectorAll('[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => applyCameraPreset(btn.dataset.view));
  });
  $('#chkFollow').addEventListener('change', (e) => {
    state.followBall = e.target.checked;
    if (state.followBall) {
      controls.target.copy(ball.position);
    } else {
      const preset = cameraPresets[state.lastPreset] || cameraPresets.catcher;
      if (preset) {
        controls.target.set(...preset.lookAt);
      }
    }
    controls.update();
  });
}

function togglePlay(force) {
  const desired = typeof force === 'boolean' ? force : !state.playing;
  state.playing = desired;
  if (state.playing) {
    clock?.start();
  } else {
    clock?.stop();
  }
  $('#btnPlayPause').textContent = state.playing ? 'Pause' : 'Play';
}

function setPlay(index) {
  index = Math.max(0, Math.min(state.plays.length - 1, index));
  state.currentIndex = index;
  const play = state.plays[index];
  updateOverlay(play);
  setupTrajectory(play);
  togglePlay(false);
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
        setTimeout(() => setPlay(state.currentIndex + 1), 600);
      }
    }
    updateBallPosition(state.time);
  }
  controls.update();
  renderer.render(scene, camera);
}

async function init() {
  const ballpark = await loadData();
  setupScene(ballpark);
  attachUI(ballpark);
  if (state.plays.length) {
    setPlay(0);
  }
  animate();
}

init().catch((err) => {
  console.error('Failed to initialise viewer', err);
});
