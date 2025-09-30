import json
from pathlib import Path

def test_ballpark_line_color_is_white():
    theme_path = Path(__file__).resolve().parent.parent / "config" / "theme.json"
    with theme_path.open() as f:
        theme = json.load(f)
    assert theme["ballpark"]["line_color"].lower() == "#ffffff"
