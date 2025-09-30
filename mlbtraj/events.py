"""CSV ingestion and feature extraction without external dependencies."""
from __future__ import annotations

from dataclasses import dataclass
import csv
import json
import math
from pathlib import Path
from typing import Any

from .paths import DEFAULT_COORDINATE_PATH

_REQUIRED_COLUMNS = (("launch_speed", "ev_mph"), ("launch_angle", "la_angle", "la_deg"))
_SPRAY_COLUMNS = (("hc_x", "hit_coord_x"), ("hc_y", "hit_coord_y"))
_OPTIONAL_DISTANCE = ("hit_distance_sc", "estimated_distance")
_OPTIONAL_SPIN = ("hit_spin_rate", "hit_spin_rate_rpm", "batted_ball_spin_rate")


@dataclass(slots=True)
class PlayEvent:
    play_id: str
    row_index: int
    game_pk: str
    game_date: str
    inning: int
    inning_half: str
    outs: int
    bat_team: str
    opp_team: str
    player_name: str
    events: str
    description: str
    launch_speed: float
    launch_angle: float
    spray_angle: float
    hit_distance: float | None
    spin_rpm: float
    raw: dict[str, Any]


@dataclass(slots=True)
class CoordinateTransform:
    x_offset: float
    y_offset: float
    angle_scale: float
    angle_offset_deg: float

    @classmethod
    def from_file(cls, path: Path = DEFAULT_COORDINATE_PATH) -> "CoordinateTransform":
        data = json.loads(Path(path).read_text())
        cfg = data.get("hc_transform", {})
        return cls(
            x_offset=float(cfg.get("x_offset", 125.42)),
            y_offset=float(cfg.get("y_offset", 198.27)),
            angle_scale=float(cfg.get("angle_scale", 1.0)),
            angle_offset_deg=float(cfg.get("angle_offset_deg", 0.0)),
        )

    def spray_angle(self, hc_x: float, hc_y: float) -> float:
        base = math.degrees(math.atan2(hc_x - self.x_offset, self.y_offset - hc_y))
        return base * self.angle_scale + self.angle_offset_deg


class EventLoader:
    def __init__(self, *, transform: CoordinateTransform | None = None):
        self.transform = transform or CoordinateTransform.from_file()

    def load(self, csv_path: Path) -> list[PlayEvent]:
        events: list[PlayEvent] = []
        with Path(csv_path).open("r", encoding="utf-8-sig", newline="") as handle:
            reader = csv.DictReader(handle)
            headers = reader.fieldnames or []
            speed_col = self._find_column(headers, _REQUIRED_COLUMNS[0])
            angle_col = self._find_column(headers, _REQUIRED_COLUMNS[1])
            hc_x_col = self._find_column(headers, _SPRAY_COLUMNS[0])
            hc_y_col = self._find_column(headers, _SPRAY_COLUMNS[1])
            for idx, row in enumerate(reader):
                if not self._has_values(row, (speed_col, angle_col, hc_x_col, hc_y_col)):
                    continue
                launch_speed = float(row[speed_col])
                launch_angle = float(row[angle_col])
                hc_x = float(row[hc_x_col])
                hc_y = float(row[hc_y_col])
                hit_distance = self._optional_float(row, _OPTIONAL_DISTANCE)
                spin_rpm = self._optional_float(row, _OPTIONAL_SPIN) or 1800.0
                spray = self.transform.spray_angle(hc_x, hc_y)
                game_pk = str(row.get("game_pk", "unknown"))
                game_date = str(row.get("game_date") or "")
                play_id = str(row.get("play_id") or f"{game_pk}-{idx+1}")
                inning = int(row.get("inning", 0) or 0)
                inning_half = str(row.get("inning_topbot", "")) or "Unknown"
                outs = int(row.get("outs_when_up", 0) or 0)
                bat_team, opp_team = _infer_teams(row, inning_half)
                player_name = str(row.get("player_name") or row.get("batter_name") or "Unknown")
                event_label = str(row.get("events") or row.get("event")) or "Unknown"
                description = str(row.get("des") or row.get("description") or "")
                events.append(
                    PlayEvent(
                        play_id=play_id,
                        row_index=idx,
                        game_pk=game_pk,
                        game_date=game_date,
                        inning=inning,
                        inning_half=inning_half,
                        outs=outs,
                        bat_team=bat_team,
                        opp_team=opp_team,
                        player_name=player_name,
                        events=event_label,
                        description=description,
                        launch_speed=launch_speed,
                        launch_angle=launch_angle,
                        spray_angle=spray,
                        hit_distance=hit_distance,
                        spin_rpm=spin_rpm,
                        raw=row,
                    )
                )
        return events

    @staticmethod
    def _find_column(headers: list[str], choices: tuple[str, ...]) -> str:
        for name in choices:
            for header in headers:
                if header and header.strip().lower() == name.lower():
                    return header
        msg = f"None of the columns {choices} were found in the CSV"
        raise KeyError(msg)

    @staticmethod
    def _has_values(row: dict[str, Any], columns: tuple[str, ...]) -> bool:
        for column in columns:
            value = row.get(column)
            if value is None or str(value).strip() == "":
                return False
        return True

    @staticmethod
    def _optional_float(row: dict[str, Any], choices: tuple[str, ...]) -> float | None:
        for name in choices:
            value = row.get(name)
            if value is not None and str(value).strip() != "":
                try:
                    return float(value)
                except ValueError:
                    continue
        return None


def extract_venue_id(events: list[PlayEvent]) -> int | None:
    for event in events:
        value = event.raw.get("venueId") or event.raw.get("venue_id")
        if value:
            try:
                return int(value)
            except (TypeError, ValueError):
                continue
    return None


def _infer_teams(row: dict[str, Any], inning_half: str) -> tuple[str, str]:
    bat_team = str(
        row.get("bat_team")
        or row.get("batting_team")
        or row.get("bat_team_name")
        or ""
    )
    opp_team = str(row.get("opp_team") or row.get("opponent_team") or "")
    home_team = str(row.get("home_team") or "")
    away_team = str(row.get("away_team") or "")

    half = (inning_half or "").lower()
    if not bat_team:
        if half.startswith("top"):
            bat_team = away_team
            opp_team = opp_team or home_team
        elif half.startswith("bot"):
            bat_team = home_team
            opp_team = opp_team or away_team
    if not opp_team:
        if bat_team and bat_team == home_team:
            opp_team = away_team
        elif bat_team and bat_team == away_team:
            opp_team = home_team
    return bat_team or "", opp_team or ""
