"""Helper paths for accessing repository assets."""
from __future__ import annotations

from pathlib import Path


PACKAGE_ROOT = Path(__file__).resolve().parent
REPO_ROOT = PACKAGE_ROOT.parent
DATA_DIR = REPO_ROOT / "data"
CONFIG_DIR = REPO_ROOT / "config"
VIEWER_DIR = REPO_ROOT / "viewer"

DEFAULT_REGISTRY_PATH = DATA_DIR / "ballparks" / "registry.json"
DEFAULT_THEME_PATH = CONFIG_DIR / "theme.json"
DEFAULT_COORDINATE_PATH = CONFIG_DIR / "coordinates.json"
DEFAULT_ENVIRONMENT_PATH = CONFIG_DIR / "environment.json"
DEFAULT_DRAG_MODELS_PATH = CONFIG_DIR / "drag_models.json"
