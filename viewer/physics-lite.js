const G_FTPS2 = 32.174;
const MPH_TO_FPS = 5280 / 3600;
const DEFAULT_DT = 1 / 120;
const DEFAULT_DRAG = 0.0035;
const INITIAL_HEIGHT = 3.0;
const HC_TRANSFORM = {
  x_offset: 125.42,
  y_offset: 198.27,
  angle_scale: 1.0,
  angle_offset_deg: 0,
};

function degToRad(deg) {
  return (deg * Math.PI) / 180;
}

function radToDeg(rad) {
  return (rad * 180) / Math.PI;
}

function mphToFps(mph) {
  return mph * MPH_TO_FPS;
}

function isFiniteNumber(value) {
  return Number.isFinite(value) && !Number.isNaN(value);
}

function parseNumber(value) {
  if (value === undefined || value === null || value === "") return NaN;
  const num = Number(value);
  return Number.isFinite(num) ? num : NaN;
}

function normalizeHalf(value) {
  const str = String(value || "").toLowerCase();
  if (str.startsWith("bot")) return "Bot";
  if (str.startsWith("bottom")) return "Bot";
  if (str.startsWith("top")) return "Top";
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : "";
}

function inferTeams(row, inningHalf) {
  const half = (inningHalf || "").toLowerCase();
  const home = (row.home_team || row.home || "").toString();
  const away = (row.away_team || row.away || "").toString();
  let bat = (row.bat_team || row.batting_team || row.bat_team_name || "").toString();
  let opp = (row.opp_team || row.opponent_team || "").toString();

  if (!bat) {
    if (half.startsWith("top")) {
      bat = away;
      if (!opp) opp = home;
    } else if (half.startsWith("bot")) {
      bat = home;
      if (!opp) opp = away;
    }
  }
  if (!opp) {
    if (bat && bat === home) opp = away;
    else if (bat && bat === away) opp = home;
  }
  return [bat || "", opp || ""];
}

function computeSprayAngle(row) {
  const rawSpray = parseNumber(row.spray_angle ?? row.hit_spray_angle);
  if (isFiniteNumber(rawSpray)) return rawSpray;
  const hcX = parseNumber(row.hc_x ?? row.hit_coord_x);
  const hcY = parseNumber(row.hc_y ?? row.hit_coord_y);
  if (!isFiniteNumber(hcX) || !isFiniteNumber(hcY)) return NaN;
  const base = Math.atan2(hcX - HC_TRANSFORM.x_offset, HC_TRANSFORM.y_offset - hcY);
  return radToDeg(base) * HC_TRANSFORM.angle_scale + HC_TRANSFORM.angle_offset_deg;
}

function integrateSimpleTrajectory(velocity, options = {}) {
  const dt = options.dt ?? DEFAULT_DT;
  const drag = options.drag ?? DEFAULT_DRAG;
  const maxTime = options.maxTime ?? 12;
  let x = 0;
  let y = 0;
  let z = INITIAL_HEIGHT;
  let vx = velocity.x;
  let vy = velocity.y;
  let vz = velocity.z;
  let t = 0;
  const points = [{t, x, y, z}];

  const maxSteps = Math.ceil(maxTime / dt);
  for (let step = 0; step < maxSteps; step += 1) {
    const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
    const dragFactor = drag * speed;
    const ax = -dragFactor * vx;
    const ay = -dragFactor * vy;
    const az = -dragFactor * vz - G_FTPS2;

    const nextVx = vx + ax * dt;
    const nextVy = vy + ay * dt;
    const nextVz = vz + az * dt;
    const nextX = x + nextVx * dt;
    const nextY = y + nextVy * dt;
    const nextZ = z + nextVz * dt;
    const nextT = t + dt;

    if (nextZ <= 0 && nextVz < 0) {
      const frac = z !== nextZ ? z / (z - nextZ) : 0;
      const landX = x + (nextX - x) * frac;
      const landY = y + (nextY - y) * frac;
      const landT = t + dt * frac;
      points.push({t: landT, x: landX, y: landY, z: 0});
      x = landX;
      y = landY;
      z = 0;
      t = landT;
      break;
    }

    vx = nextVx;
    vy = nextVy;
    vz = nextVz;
    x = nextX;
    y = nextY;
    z = nextZ;
    t = nextT;
    points.push({t, x, y, z});
    if (z <= 0) break;
  }

  if (points.at(-1).z > 0) {
    points.push({t: t + dt, x, y, z: 0});
  }
  const landing = points.at(-1);
  const landingDistance = Math.hypot(landing.x, landing.y);
  return {points, landingDistance};
}

function calibrateHorizontal(points, targetDistance) {
  if (!targetDistance || !Number.isFinite(targetDistance)) return points;
  const last = points.at(-1);
  const current = Math.hypot(last.x, last.y);
  if (!current) return points;
  const scale = targetDistance / current;
  return points.map((p) => ({t: p.t, x: p.x * scale, y: p.y * scale, z: p.z}));
}

function buildTrajectory(row, options = {}) {
  const speedMph = parseNumber(row.launch_speed ?? row.exit_velocity ?? row.ev ?? row.ev_mph);
  const launchDeg = parseNumber(row.launch_angle ?? row.la_angle ?? row.angle);
  const sprayDeg = computeSprayAngle(row);
  if (!isFiniteNumber(speedMph) || !isFiniteNumber(launchDeg) || !isFiniteNumber(sprayDeg)) {
    return null;
  }
  const speedFps = mphToFps(speedMph);
  const launchRad = degToRad(launchDeg);
  const sprayRad = degToRad(sprayDeg);
  const vz = speedFps * Math.sin(launchRad);
  const vh = speedFps * Math.cos(launchRad);
  const vx = vh * Math.sin(sprayRad);
  const vy = vh * Math.cos(sprayRad);
  const {points, landingDistance} = integrateSimpleTrajectory({x: vx, y: vy, z: vz}, options);
  const hitDistance = parseNumber(
    row.hit_distance_sc ?? row.estimated_distance ?? row.hit_distance ?? row.projected_distance,
  );
  const calibrated = calibrateHorizontal(points, hitDistance);
  return {points: calibrated, landingDistance: hitDistance || landingDistance};
}

function sanitizeRow(row) {
  if (!row) return {};
  const cleaned = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "string") {
      cleaned[key.trim()] = value.trim();
    } else {
      cleaned[key.trim()] = value;
    }
  }
  return cleaned;
}

function derivePlay(row, index, options = {}) {
  const cleaned = sanitizeRow(row);
  const trajectory = buildTrajectory(cleaned, options);
  if (!trajectory) return null;
  const inning = parseInt(cleaned.inning ?? cleaned.frame ?? "0", 10) || 0;
  const inningHalf = normalizeHalf(cleaned.inning_half ?? cleaned.inning_topbot);
  const [batTeam, oppTeam] = inferTeams(cleaned, inningHalf);
  const outs = parseInt(cleaned.outs_when_up ?? cleaned.outs ?? "0", 10) || 0;
  const playId = cleaned.play_id || cleaned.playid || `csv-${index + 1}`;
  return {
    play_id: playId,
    game_pk: cleaned.game_pk || cleaned.gamepk || "csv",
    game_date: cleaned.game_date || "",
    inning,
    inning_half: inningHalf,
    outs,
    outs_when_up: outs,
    bat_team: batTeam,
    opp_team: oppTeam,
    player_name: cleaned.player_name || cleaned.batter || cleaned.batter_name || "",
    events: cleaned.events || cleaned.event || "",
    description: cleaned.des || cleaned.description || "",
    launch_speed: parseNumber(cleaned.launch_speed),
    launch_angle: parseNumber(cleaned.launch_angle),
    spray_angle: computeSprayAngle(cleaned),
    topbot: inningHalf,
    points: trajectory.points,
  };
}

function parseCsv(file) {
  return new Promise((resolve, reject) => {
    if (!window.Papa) {
      reject(new Error("PapaParse is required for CSV uploads"));
      return;
    }
    window.Papa.parse(file, {
      header: true,
      skipEmptyLines: "greedy",
      dynamicTyping: false,
      complete: (results) => {
        if (results.errors && results.errors.length) {
          reject(new Error(results.errors[0].message || "CSV parse error"));
          return;
        }
        resolve(results.data || []);
      },
      error: (err) => reject(err),
    });
  });
}

export async function loadPlaysFromCsv(file, options = {}) {
  const rows = await parseCsv(file);
  const plays = [];
  rows.forEach((row, idx) => {
    const play = derivePlay(row, idx, options);
    if (play && Array.isArray(play.points) && play.points.length) {
      plays.push(play);
    }
  });
  return plays;
}

