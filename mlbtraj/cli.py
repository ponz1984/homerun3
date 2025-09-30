"""Command line interface implemented with argparse."""
from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path
from typing import Sequence

from .ballpark import Ballpark, BallparkRegistry
from .events import EventLoader, extract_venue_id
from .output import OutputWriter
from .paths import DEFAULT_THEME_PATH, VIEWER_DIR
from .simulate import Simulator


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Simulate Statcast batted balls and bundle a viewer")
    parser.add_argument("--list-parks", action="store_true", help="List ballparks from the registry")
    subparsers = parser.add_subparsers(dest="command")

    sim = subparsers.add_parser("simulate", help="Run physics simulation for CSV events")
    sim.add_argument("events", type=Path, help="CSV with Statcast events")
    sim.add_argument("--out", type=Path, default=Path("out"), help="Directory for simulation artefacts")
    sim.add_argument("--park", type=str, help="Ballpark slug from the registry")
    sim.add_argument("--park-file", type=Path, help="Custom ballpark JSON file")
    sim.add_argument("--auto-park", action="store_true", help="Infer ballpark from venueId or home team")
    sim.add_argument(
        "--calibrate-distance",
        action="store_true",
        help="Scale drag to match Statcast hit_distance_sc",
    )

    bundle = subparsers.add_parser("bundle-viewer", help="Copy viewer assets and trajectories to a dist folder")
    bundle.add_argument("--playlist", type=Path, default=Path("out") / "playlist.json", help="Playlist JSON path")
    bundle.add_argument("--dest", type=Path, default=Path("dist"), help="Destination directory")
    bundle.add_argument("--park", type=str, help="Override ballpark slug")
    bundle.add_argument("--park-file", type=Path, help="Custom ballpark JSON file")
    bundle.add_argument("--theme", type=Path, help="Viewer theme JSON path")

    return parser


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if args.list_parks:
        registry = BallparkRegistry()
        print(registry.list_formatted())
        if not args.command:
            return 0
    if args.command == "simulate":
        return _run_simulate(args)
    if args.command == "bundle-viewer":
        return _run_bundle(args)
    if args.command is None:
        parser.print_help()
    return 0


def _resolve_ballpark(
    *,
    park: str | None,
    park_file: Path | None,
    auto_park: bool,
    events: list,
) -> Ballpark:
    if park_file:
        return Ballpark.from_file(park_file)
    registry = BallparkRegistry()
    if park:
        return registry.resolve_ballpark(slug=park)
    if not auto_park:
        raise SystemExit("Specify --park, --park-file, or enable --auto-park")
    venue_id = extract_venue_id(events)
    if venue_id is not None:
        return registry.resolve_ballpark(venue_id=venue_id)
    if events:
        home_team = events[0].raw.get("home_team") or events[0].raw.get("homeTeam")
        if home_team:
            entry = registry.find_by_slug(str(home_team))
            if entry:
                return Ballpark.from_file(entry.best_version_path())
    raise SystemExit("Unable to infer ballpark from data; specify --park explicitly")


def _run_simulate(args: argparse.Namespace) -> int:
    loader = EventLoader()
    plays = loader.load(args.events)
    if not plays:
        raise SystemExit("No playable events were found in the CSV")
    ballpark = _resolve_ballpark(
        park=args.park,
        park_file=args.park_file,
        auto_park=args.auto_park,
        events=plays,
    )
    print(f"Loaded {len(plays)} plays from {args.events}")
    print(f"Using ballpark: {ballpark.name} ({ballpark.slug})")
    simulator = Simulator(ballpark=ballpark)
    results = [
        simulator.simulate_event(play, calibrate_distance=args.calibrate_distance)
        for play in plays
    ]
    writer = OutputWriter(args.out)
    bundle = writer.write(ballpark, results)
    print(f"Playlist written to {bundle.playlist_path}")
    print(f"Summary written to {bundle.summary_path}")
    print(f"Trajectories stored in {bundle.trajectories_dir}")
    return 0


def _run_bundle(args: argparse.Namespace) -> int:
    playlist_data = json.loads(args.playlist.read_text())
    plays = playlist_data.get("plays", [])
    if not plays:
        raise SystemExit("Playlist has no plays")
    inferred_slug = playlist_data.get("park", {}).get("slug")
    if args.park_file:
        ballpark = Ballpark.from_file(args.park_file)
    else:
        resolved_slug = args.park or inferred_slug
        if not resolved_slug:
            raise SystemExit("Specify --park/--park-file or ensure playlist contains park metadata")
        registry = BallparkRegistry()
        ballpark = registry.resolve_ballpark(slug=resolved_slug)

    dest = args.dest
    dest.mkdir(parents=True, exist_ok=True)
    for filename in ("index.html", "style.css", "app.js", "physics-lite.js"):
        shutil.copy2(VIEWER_DIR / filename, dest / filename)
    theme_path = args.theme or DEFAULT_THEME_PATH
    theme_payload = json.loads(Path(theme_path).read_text())
    config_payload = {
        "theme": theme_payload,
        "ballpark": ballpark.wireframe_payload(),
        "camera_presets": ballpark.camera_presets,
    }
    (dest / "config.json").write_text(json.dumps(config_payload, ensure_ascii=False, indent=2))
    shutil.copy2(args.playlist, dest / "playlist.json")
    source_trajectories = args.playlist.parent / "trajectories"
    target_trajectories = dest / "trajectories"
    if target_trajectories.exists():
        shutil.rmtree(target_trajectories)
    shutil.copytree(source_trajectories, target_trajectories)
    print(f"Viewer bundled to {dest}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
