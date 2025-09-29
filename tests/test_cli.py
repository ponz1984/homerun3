from __future__ import annotations

import csv
import io
import json
from contextlib import redirect_stdout
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from mlbtraj import cli

SAMPLE_CSV = Path("data/samples/sample.csv")


def run_cli(args: list[str]):
    buffer = io.StringIO()
    with redirect_stdout(buffer):
        exit_code = cli.main(args)
    return exit_code, buffer.getvalue()


@pytest.mark.parametrize("args", [["--list-parks"]])
def test_list_parks(args):
    exit_code, output = run_cli(args)
    assert exit_code == 0
    assert "dodger" in output.lower()


def test_simulate_and_bundle(tmp_path: Path) -> None:
    out_dir = tmp_path / "lad"
    exit_code, _ = run_cli(
        [
            "simulate",
            str(SAMPLE_CSV),
            "--park",
            "lad-dodger-stadium",
            "--out",
            str(out_dir),
            "--calibrate-distance",
        ]
    )
    assert exit_code == 0
    playlist_path = out_dir / "playlist.json"
    summary_path = out_dir / "summary.csv"
    traj_dir = out_dir / "trajectories"
    assert playlist_path.exists()
    assert summary_path.exists()
    assert traj_dir.is_dir()

    playlist = json.loads(playlist_path.read_text())
    assert playlist["count"] == len(playlist["plays"])
    assert playlist["plays"], "playlist must contain at least one play"

    with summary_path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        rows = list(reader)
    assert rows
    for row in rows:
        hit_distance = row.get("hit_distance")
        if hit_distance:
            distance_error = float(row["distance_error"]) if row["distance_error"] else 0.0
            assert abs(distance_error) <= 15 + 1e-6

    dist_dir = tmp_path / "dist"
    exit_code, _ = run_cli(
        [
            "bundle-viewer",
            "--playlist",
            str(playlist_path),
            "--dest",
            str(dist_dir),
        ]
    )
    assert exit_code == 0
    for filename in ("index.html", "style.css", "app.js", "config.json", "playlist.json"):
        assert (dist_dir / filename).exists()
    config = json.loads((dist_dir / "config.json").read_text())
    assert "ballpark" in config and "camera_presets" in config
    assert (dist_dir / "trajectories").is_dir()
