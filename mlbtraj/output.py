"""Persist simulation artefacts."""
from __future__ import annotations

import csv
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from .ballpark import Ballpark
from .simulate import SimulationResult


@dataclass(slots=True)
class OutputBundle:
    playlist_path: Path
    summary_path: Path
    trajectories_dir: Path


class OutputWriter:
    def __init__(self, out_dir: Path):
        self.out_dir = Path(out_dir)
        self.playlist_path = self.out_dir / "playlist.json"
        self.summary_path = self.out_dir / "summary.csv"
        self.trajectories_dir = self.out_dir / "trajectories"

    def write(self, ballpark: Ballpark, results: Iterable[SimulationResult]) -> OutputBundle:
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self.trajectories_dir.mkdir(parents=True, exist_ok=True)
        ordered_results = sorted(results, key=_sort_key)
        playlist_payload = {
            "park": {
                "slug": ballpark.slug,
                "name": ballpark.name,
                "year": ballpark.year,
            },
            "count": len(ordered_results),
            "plays": [],
        }
        with self.summary_path.open("w", newline="", encoding="utf-8") as csvfile:
            writer = csv.writer(csvfile)
            writer.writerow(
                [
                    "play_id",
                    "game_pk",
                    "inning",
                    "inning_half",
                    "outs",
                    "player_name",
                    "events",
                    "description",
                    "launch_speed",
                    "launch_angle",
                    "spray_angle",
                    "hit_distance",
                    "sim_distance",
                    "distance_error",
                    "drag_scale",
                    "apex",
                    "flight_time",
                ]
            )
            for result in ordered_results:
                traj_rel = Path("trajectories") / f"{result.event.play_id}.json"
                playlist_payload["plays"].append(
                    {
                        "play_id": result.event.play_id,
                        "game_pk": result.event.game_pk,
                        "game_date": result.event.game_date,
                        "inning": result.event.inning,
                        "inning_half": result.event.inning_half,
                        "outs": result.event.outs,
                        "bat_team": result.event.bat_team,
                        "opp_team": result.event.opp_team,
                        "player_name": result.event.player_name,
                        "events": result.event.events,
                        "description": result.event.description,
                        "trajectory": str(traj_rel),
                    }
                )
                traj_path = self.trajectories_dir / f"{result.event.play_id}.json"
                traj_path.write_text(json.dumps(result.trajectory.to_json(), ensure_ascii=False, indent=2))
                writer.writerow(
                    [
                        result.event.play_id,
                        result.event.game_pk,
                        result.event.inning,
                        result.event.inning_half,
                        result.event.outs,
                        result.event.player_name,
                        result.event.events,
                        result.event.description,
                        round(result.event.launch_speed, 4),
                        round(result.event.launch_angle, 4),
                        round(result.event.spray_angle, 4),
                        round(result.event.hit_distance, 4) if result.event.hit_distance else "",
                        round(result.trajectory.landing_distance, 4),
                        round(result.distance_error, 4) if result.distance_error is not None else "",
                        round(result.drag_scale, 6),
                        round(result.trajectory.apex, 4),
                        round(result.trajectory.flight_time, 4),
                    ]
                )
        self.playlist_path.write_text(json.dumps(playlist_payload, ensure_ascii=False, indent=2))
        return OutputBundle(
            playlist_path=self.playlist_path,
            summary_path=self.summary_path,
            trajectories_dir=self.trajectories_dir,
        )


def _sort_key(result: SimulationResult) -> tuple[int, int, int]:
    inning_half_order = {"Top": 0, "Bot": 1}
    half_order = inning_half_order.get(result.event.inning_half, 2)
    return (result.event.inning, half_order, result.event.row_index)
