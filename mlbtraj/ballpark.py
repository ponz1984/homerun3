"""Ballpark registry and geometry helpers."""
from __future__ import annotations

from dataclasses import dataclass
import json
import math
from pathlib import Path
from typing import Any, Iterable, Mapping

from .paths import DEFAULT_REGISTRY_PATH

_LABEL_ORDER = [
    "RF",
    "SRF",
    "RFA",
    "RCF",
    "CF",
    "LCF",
    "LFA",
    "SLF",
    "LF",
]

_ANGLE_DEGREES = {
    "RF": 45.0,
    "SRF": 30.0,
    "RFA": 20.0,
    "RCF": 10.0,
    "CF": 0.0,
    "LCF": -10.0,
    "LFA": -20.0,
    "SLF": -30.0,
    "LF": -45.0,
}

_DEFAULT_WALL_HEIGHT = 8.0


@dataclass(slots=True)
class Ballpark:
    """Resolved ballpark definition and derived geometry."""

    slug: str
    name: str
    year: int | None
    source_path: Path
    fence_points: list[tuple[float, float]]
    fence_heights: list[float]
    camera_presets: dict[str, dict[str, list[float]]]

    @classmethod
    def from_file(cls, path: Path) -> "Ballpark":
        data = json.loads(Path(path).read_text())
        slug = str(data.get("slug", Path(path).stem))
        name = str(data.get("name", slug))
        year = data.get("year")
        distances = data.get("distance_by_label_ft") or {}
        if not distances:
            msg = f"Ballpark file {path} does not contain distance_by_label_ft"
            raise ValueError(msg)
        fence_points, fence_heights = _compute_fence(distances, data.get("wall_height_ft") or {})
        camera_presets = _normalise_camera_presets(data.get("camera_presets") or {})
        return cls(
            slug=slug,
            name=name,
            year=year,
            source_path=Path(path),
            fence_points=fence_points,
            fence_heights=fence_heights,
            camera_presets=camera_presets,
        )

    def wireframe_payload(self) -> dict[str, Any]:
        """Return a serialisable payload for the viewer."""

        base = [[x, y, 0.0] for (x, y) in self.fence_points]
        top = [[x, y, h] for (x, y), h in zip(self.fence_points, self.fence_heights)]
        foul_lines = [
            [[0.0, 0.0, 0.0], [base[0][0], base[0][1], 0.0]],
            [[0.0, 0.0, 0.0], [base[-1][0], base[-1][1], 0.0]],
        ]
        wall_segments = [[[bx, by, 0.0], [bx, by, height]] for (bx, by), height in zip(self.fence_points, self.fence_heights)]
        return {
            "slug": self.slug,
            "name": self.name,
            "year": self.year,
            "fence_base": base,
            "fence_top": top,
            "foul_lines": foul_lines,
            "wall_segments": wall_segments,
        }


def _compute_fence(
    distances: Mapping[str, float],
    heights: Mapping[str, float],
) -> tuple[list[tuple[float, float]], list[float]]:
    points: list[tuple[float, float]] = []
    point_heights: list[float] = []
    last_height = _DEFAULT_WALL_HEIGHT
    for label in _LABEL_ORDER:
        if label not in distances:
            continue
        distance = float(distances[label])
        angle = math.radians(_ANGLE_DEGREES[label])
        x = distance * math.sin(angle)
        y = distance * math.cos(angle)
        points.append((x, y))
        last_height = float(heights.get(label, last_height))
        point_heights.append(last_height)
    if not points:
        msg = "No fence points could be derived from distances"
        raise ValueError(msg)
    return points, point_heights


def _normalise_camera_presets(raw: Mapping[str, Any]) -> dict[str, dict[str, list[float]]]:
    presets: dict[str, dict[str, list[float]]] = {}
    for key, preset in raw.items():
        pos = _ensure_vector(preset.get("pos"), fallback=[0.0, -120.0, 55.0])
        look_at = _ensure_vector(preset.get("lookAt"), fallback=[0.0, 140.0, 10.0])
        presets[key] = {"pos": pos, "lookAt": look_at}
    if "if_high" not in presets:
        presets["if_high"] = {
            "pos": [0.0, -120.0, 55.0],
            "lookAt": [0.0, 140.0, 10.0],
        }
    return presets


def _ensure_vector(values: Iterable[float] | None, fallback: list[float]) -> list[float]:
    if values is None:
        return list(fallback)
    result = [float(v) for v in values]
    if len(result) != 3:
        return list(fallback)
    return result


@dataclass(slots=True)
class RegistryEntry:
    slug: str
    name: str
    aliases: tuple[str, ...]
    venue_ids: tuple[int, ...]
    versions: dict[str, str]

    def best_version_path(self) -> Path:
        if not self.versions:
            msg = f"No versions registered for park {self.slug}"
            raise ValueError(msg)
        latest_year = sorted(self.versions)[-1]
        return Path(self.versions[latest_year])


class BallparkRegistry:
    """Registry helper backed by ``data/ballparks/registry.json``."""

    def __init__(self, registry_path: Path = DEFAULT_REGISTRY_PATH):
        self._path = Path(registry_path)
        self._entries = self._load(self._path)

    @staticmethod
    def _load(path: Path) -> list[RegistryEntry]:
        data = json.loads(Path(path).read_text())
        parks = data.get("parks")
        if not isinstance(parks, list):
            msg = f"Registry file {path} does not contain a parks list"
            raise ValueError(msg)
        entries: list[RegistryEntry] = []
        base_dir = path.parent
        repo_root = base_dir.parent.parent
        for park in parks:
            versions = {}
            for year, relpath in (park.get("versions") or {}).items():
                path_obj = Path(relpath)
                if not path_obj.is_absolute():
                    path_obj = (repo_root / path_obj).resolve()
                versions[str(year)] = str(path_obj)
            entries.append(
                RegistryEntry(
                    slug=str(park["slug"]),
                    name=str(park.get("name", park["slug"])),
                    aliases=tuple(str(alias) for alias in park.get("aliases", [])),
                    venue_ids=tuple(int(v) for v in park.get("venue_ids", [])),
                    versions=versions,
                )
            )
        return entries

    @property
    def entries(self) -> list[RegistryEntry]:
        return list(self._entries)

    def list_formatted(self) -> str:
        rows = [f"{entry.slug:<24} {entry.name}" for entry in self._entries]
        return "\n".join(rows)

    def find_by_slug(self, slug: str) -> RegistryEntry | None:
        slug_lower = slug.lower()
        for entry in self._entries:
            if entry.slug.lower() == slug_lower or slug_lower in (alias.lower() for alias in entry.aliases):
                return entry
        return None

    def find_by_venue(self, venue_id: int) -> RegistryEntry | None:
        for entry in self._entries:
            if venue_id in entry.venue_ids:
                return entry
        return None

    def resolve_ballpark(self, *, slug: str | None = None, venue_id: int | None = None) -> Ballpark:
        entry: RegistryEntry | None = None
        if slug:
            entry = self.find_by_slug(slug)
            if entry is None:
                msg = f"Unknown ballpark slug '{slug}'"
                raise ValueError(msg)
        elif venue_id is not None:
            entry = self.find_by_venue(venue_id)
            if entry is None:
                msg = f"Could not find ballpark for venue ID {venue_id}"
                raise ValueError(msg)
        else:
            msg = "Either slug or venue_id must be provided"
            raise ValueError(msg)
        return Ballpark.from_file(entry.best_version_path())
