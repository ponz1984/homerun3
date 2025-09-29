"""High level simulation orchestrator."""
from __future__ import annotations

from dataclasses import dataclass
import math
from pathlib import Path

from .ballpark import Ballpark
from .events import PlayEvent
from .physics import (
    MPH_TO_FPS,
    DragModel,
    Environment,
    LiftModel,
    Trajectory,
    integrate_trajectory,
)

_INITIAL_HEIGHT_FT = 3.0


@dataclass(slots=True)
class SimulationResult:
    event: PlayEvent
    trajectory: Trajectory
    drag_scale: float
    distance_error: float | None


class Simulator:
    def __init__(
        self,
        *,
        ballpark: Ballpark,
        environment: Environment | None = None,
        drag_model: DragModel | None = None,
        lift_model: LiftModel | None = None,
    ):
        self.ballpark = ballpark
        self.environment = environment or Environment.from_file()
        self.drag_model = drag_model or DragModel.from_file()
        self.lift_model = lift_model or LiftModel.from_file()

    def simulate_event(
        self,
        event: PlayEvent,
        *,
        calibrate_distance: bool,
        tolerance: float = 15.0,
    ) -> SimulationResult:
        speed_fps = event.launch_speed * MPH_TO_FPS
        launch_rad = math.radians(event.launch_angle)
        spray_rad = math.radians(event.spray_angle)
        vz0 = speed_fps * math.sin(launch_rad)
        vh = speed_fps * math.cos(launch_rad)
        vx0 = vh * math.sin(spray_rad)
        vy0 = vh * math.cos(spray_rad)
        pos0 = (0.0, 0.0, _INITIAL_HEIGHT_FT)
        vel0 = (vx0, vy0, vz0)

        if calibrate_distance and event.hit_distance:
            trajectory, scale, err = self._calibrate_to_distance(pos0, vel0, event)
            return SimulationResult(event=event, trajectory=trajectory, drag_scale=scale, distance_error=err)
        trajectory = integrate_trajectory(
            pos0,
            vel0,
            spin_rpm=event.spin_rpm,
            environment=self.environment,
            drag_model=self.drag_model,
            lift_model=self.lift_model,
        )
        err = (trajectory.landing_distance - event.hit_distance) if event.hit_distance else None
        return SimulationResult(event=event, trajectory=trajectory, drag_scale=1.0, distance_error=err)

    def _calibrate_to_distance(
        self,
        pos0: tuple[float, float, float],
        vel0: tuple[float, float, float],
        event: PlayEvent,
        *,
        tolerance: float = 15.0,
        max_iter: int = 24,
    ) -> tuple[Trajectory, float, float | None]:
        target = float(event.hit_distance)
        low = 0.1
        high = 2.5
        traj_low = integrate_trajectory(
            pos0,
            vel0,
            spin_rpm=event.spin_rpm,
            environment=self.environment,
            drag_model=self.drag_model,
            lift_model=self.lift_model,
            drag_scale=low,
        )
        traj_high = integrate_trajectory(
            pos0,
            vel0,
            spin_rpm=event.spin_rpm,
            environment=self.environment,
            drag_model=self.drag_model,
            lift_model=self.lift_model,
            drag_scale=high,
        )
        while target >= traj_low.landing_distance and low > 0.02:
            low *= 0.5
            traj_low = integrate_trajectory(
                pos0,
                vel0,
                spin_rpm=event.spin_rpm,
                environment=self.environment,
                drag_model=self.drag_model,
                lift_model=self.lift_model,
                drag_scale=low,
            )
        if target >= traj_low.landing_distance:
            err = traj_low.landing_distance - target
            return traj_low, low, err
        while target <= traj_high.landing_distance and high < 12.0:
            high *= 1.5
            traj_high = integrate_trajectory(
                pos0,
                vel0,
                spin_rpm=event.spin_rpm,
                environment=self.environment,
                drag_model=self.drag_model,
                lift_model=self.lift_model,
                drag_scale=high,
            )
        if target <= traj_high.landing_distance:
            err = traj_high.landing_distance - target
            return traj_high, high, err

        best_traj = traj_low
        best_scale = low
        best_diff = abs(traj_low.landing_distance - target)
        for _ in range(max_iter):
            mid = 0.5 * (low + high)
            traj_mid = integrate_trajectory(
                pos0,
                vel0,
                spin_rpm=event.spin_rpm,
                environment=self.environment,
                drag_model=self.drag_model,
                lift_model=self.lift_model,
                drag_scale=mid,
            )
            diff = traj_mid.landing_distance - target
            abs_diff = abs(diff)
            if abs_diff < best_diff:
                best_traj = traj_mid
                best_scale = mid
                best_diff = abs_diff
            if diff > 0:
                low = mid
            else:
                high = mid
            if high - low < 1e-3:
                break
        final_diff = best_traj.landing_distance - target
        return best_traj, best_scale, final_diff
