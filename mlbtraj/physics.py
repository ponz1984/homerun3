"""Trajectory integration with drag and Magnus force (standard-library implementation)."""
from __future__ import annotations

from dataclasses import dataclass
import json
import math
from pathlib import Path
from typing import Iterable, Sequence

from .paths import DEFAULT_DRAG_MODELS_PATH, DEFAULT_ENVIRONMENT_PATH

MPH_TO_FPS = 1.4666667
BALL_RADIUS_FT = 1.45 / 12.0
BALL_AREA_FT2 = math.pi * BALL_RADIUS_FT**2
BALL_MASS_LB = 0.3203125
BALL_MASS_SLUG = BALL_MASS_LB / 32.174
GRAVITY_FTPS2 = 32.174
Vector3 = tuple[float, float, float]


def _vec_add(a: Sequence[float], b: Sequence[float]) -> list[float]:
    return [ax + bx for ax, bx in zip(a, b)]


def _vec_scale(a: Sequence[float], scalar: float) -> list[float]:
    return [ax * scalar for ax in a]


def _vec_sub(a: Sequence[float], b: Sequence[float]) -> list[float]:
    return [ax - bx for ax, bx in zip(a, b)]


def _vec_len(a: Sequence[float]) -> float:
    return math.sqrt(sum(ax * ax for ax in a))


def _vec_norm(a: Sequence[float]) -> list[float]:
    length = _vec_len(a)
    if length <= 1e-9:
        return [0.0, 0.0, 0.0]
    inv = 1.0 / length
    return [ax * inv for ax in a]


def _vec_cross(a: Sequence[float], b: Sequence[float]) -> list[float]:
    ax, ay, az = a
    bx, by, bz = b
    return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx]


@dataclass(slots=True)
class Environment:
    air_density: float  # slug / ft^3
    gravity: float = GRAVITY_FTPS2
    wind_vector: Vector3 = (0.0, 0.0, 0.0)

    @classmethod
    def from_file(cls, path: Path = DEFAULT_ENVIRONMENT_PATH) -> "Environment":
        data = json.loads(Path(path).read_text())
        density = _compute_air_density(
            temperature_f=float(data.get("temperature_f", 70.0)),
            pressure_inhg=float(data.get("pressure_inHg", 29.92)),
            humidity_pct=float(data.get("humidity_pct", 50.0)),
            altitude_ft=float(data.get("altitude_ft", 0.0)),
        )
        wind_speed = float(data.get("wind_speed_mph", 0.0))
        wind_dir = float(data.get("wind_dir_deg", 0.0))
        wind_vec = _wind_vector(wind_speed, wind_dir) if wind_speed else (0.0, 0.0, 0.0)
        return cls(air_density=density, wind_vector=wind_vec)


@dataclass(slots=True)
class DragModel:
    knots_mph: Sequence[float]
    values: Sequence[float]

    @classmethod
    def from_file(cls, path: Path = DEFAULT_DRAG_MODELS_PATH, name: str = "default") -> "DragModel":
        data = json.loads(Path(path).read_text())
        model = data[name]["cd_model"]
        return cls(tuple(model["knots_mph"]), tuple(model["values"]))

    def cd(self, speed_fps: float, scale: float = 1.0) -> float:
        speed_mph = speed_fps / MPH_TO_FPS
        knots = list(self.knots_mph)
        values = list(self.values)
        if speed_mph <= knots[0]:
            return scale * values[0]
        if speed_mph >= knots[-1]:
            return scale * values[-1]
        for i in range(1, len(knots)):
            if speed_mph <= knots[i]:
                ratio = (speed_mph - knots[i - 1]) / (knots[i] - knots[i - 1])
                value = values[i - 1] + ratio * (values[i] - values[i - 1])
                return scale * value
        return scale * values[-1]


@dataclass(slots=True)
class LiftModel:
    c1: float
    max_value: float

    @classmethod
    def from_file(cls, path: Path = DEFAULT_DRAG_MODELS_PATH, name: str = "default") -> "LiftModel":
        data = json.loads(Path(path).read_text())
        model = data[name]["cl_model"]
        return cls(float(model["c1"]), float(model.get("max", 0.3)))

    def cl(self, spin_rps: float, speed_fps: float) -> float:
        if speed_fps <= 1e-6:
            return 0.0
        spin_ratio = (spin_rps * BALL_RADIUS_FT) / speed_fps
        return min(self.max_value, self.c1 * spin_ratio)


@dataclass(slots=True)
class TrajectoryPoint:
    t: float
    x: float
    y: float
    z: float


@dataclass(slots=True)
class Trajectory:
    points: list[TrajectoryPoint]
    landing_distance: float
    apex: float
    flight_time: float

    def to_json(self) -> list[dict[str, float]]:
        return [{"t": point.t, "x": point.x, "y": point.y, "z": point.z} for point in self.points]


def integrate_trajectory(
    pos0: Iterable[float],
    vel0: Iterable[float],
    *,
    spin_rpm: float,
    environment: Environment,
    drag_model: DragModel,
    lift_model: LiftModel,
    drag_scale: float = 1.0,
    dt: float = 0.01,
    max_time: float = 12.0,
) -> Trajectory:
    state = list(pos0) + list(vel0)
    points: list[TrajectoryPoint] = []

    def deriv(vec: list[float]) -> list[float]:
        vel = vec[3:]
        accel = _acceleration(
            vel,
            spin_rpm=spin_rpm,
            environment=environment,
            drag_model=drag_model,
            lift_model=lift_model,
            drag_scale=drag_scale,
        )
        return vel + list(accel)

    t = 0.0
    apex = state[2]
    while t <= max_time:
        points.append(TrajectoryPoint(t=t, x=state[0], y=state[1], z=state[2]))
        apex = max(apex, state[2])
        if t > 0 and state[2] <= 0.0:
            break
        k1 = deriv(state)
        k2 = deriv(_state_step(state, k1, dt * 0.5))
        k3 = deriv(_state_step(state, k2, dt * 0.5))
        k4 = deriv(_state_step(state, k3, dt))
        step = [
            dt / 6.0 * (k1[i] + 2.0 * k2[i] + 2.0 * k3[i] + k4[i])
            for i in range(6)
        ]
        state = [state[i] + step[i] for i in range(6)]
        t += dt

    if len(points) >= 2 and points[-1].z < 0.0:
        last = points[-1]
        prev = points[-2]
        span = last.z - prev.z
        ratio = 0.0 if abs(span) < 1e-6 else prev.z / (prev.z - last.z)
        x = prev.x + (last.x - prev.x) * ratio
        y = prev.y + (last.y - prev.y) * ratio
        t_contact = prev.t + (last.t - prev.t) * ratio
        points[-1] = TrajectoryPoint(t=t_contact, x=x, y=y, z=0.0)
        t = t_contact

    landing_distance = math.hypot(points[-1].x, points[-1].y) if points else 0.0
    flight_time = points[-1].t if points else 0.0
    return Trajectory(points=points, landing_distance=landing_distance, apex=apex, flight_time=flight_time)


def _state_step(state: list[float], deriv: list[float], factor: float) -> list[float]:
    return [state[i] + deriv[i] * factor for i in range(6)]


def _acceleration(
    vel: Sequence[float],
    *,
    spin_rpm: float,
    environment: Environment,
    drag_model: DragModel,
    lift_model: LiftModel,
    drag_scale: float,
) -> Vector3:
    wind = environment.wind_vector
    rel_vel = _vec_sub(vel, wind)
    speed = _vec_len(rel_vel)
    if speed < 1e-6:
        return (0.0, 0.0, -environment.gravity)
    drag_direction = _vec_scale(rel_vel, -1.0 / speed)
    drag_coeff = drag_model.cd(speed, scale=drag_scale)
    drag_mag = 0.5 * environment.air_density * BALL_AREA_FT2 * drag_coeff * speed**2 / BALL_MASS_SLUG
    drag_force = _vec_scale(drag_direction, drag_mag)

    spin_rps = spin_rpm / 60.0
    cl = lift_model.cl(spin_rps, speed)
    if cl:
        v_hat = _vec_scale(rel_vel, 1.0 / speed)
        spin_axis = _vec_cross(v_hat, (0.0, 0.0, 1.0))
        spin_axis_len = _vec_len(spin_axis)
        if spin_axis_len > 1e-6:
            spin_axis = _vec_scale(spin_axis, 1.0 / spin_axis_len)
            lift_dir = _vec_cross(spin_axis, v_hat)
            lift_mag = 0.5 * environment.air_density * BALL_AREA_FT2 * cl * speed**2 / BALL_MASS_SLUG
            magnus = _vec_scale(lift_dir, lift_mag)
        else:
            magnus = [0.0, 0.0, 0.0]
    else:
        magnus = [0.0, 0.0, 0.0]
    gravity = (0.0, 0.0, -environment.gravity)
    total = _vec_add(gravity, drag_force)
    total = _vec_add(total, magnus)
    return (total[0], total[1], total[2])


def _compute_air_density(
    *,
    temperature_f: float,
    pressure_inhg: float,
    humidity_pct: float,
    altitude_ft: float,
) -> float:
    temperature_c = (temperature_f - 32.0) * 5.0 / 9.0
    temperature_k = temperature_c + 273.15
    pressure_pa = pressure_inhg * 3386.389
    pressure_pa *= math.exp(-altitude_ft / (temperature_k * 29.263))
    saturation_vapor_pa = 610.94 * math.exp(17.625 * temperature_c / (temperature_c + 243.04))
    vapor_pressure = saturation_vapor_pa * (humidity_pct / 100.0)
    dry_pressure = pressure_pa - vapor_pressure
    r_dry = 287.058
    r_vapor = 461.495
    density_kg_m3 = dry_pressure / (r_dry * temperature_k) + vapor_pressure / (r_vapor * temperature_k)
    return density_kg_m3 * 0.0019403203


def _wind_vector(speed_mph: float, direction_deg: float) -> Vector3:
    speed_fps = speed_mph * MPH_TO_FPS
    rad = math.radians(direction_deg)
    x = speed_fps * math.sin(rad)
    y = speed_fps * math.cos(rad)
    return (x, y, 0.0)
