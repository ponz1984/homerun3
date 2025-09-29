# mlbtraj — 初期コミット（ワイヤーフレーム版）

**目的**：Baseball Savant の打球CSVと球場プリセットJSONから、打球の3D軌道を再現・鑑賞するツールの**初期コミット**です。  
本スターターは **球場を線（ワイヤーフレーム）のみ**で描画し、**打球軌道だけ色付きで強調**するスタイルを前提にしています。

## 手順（概要）
1. この一式を GitHub の `main` にアップロード  
2. `data/samples/` に `sample.csv` を配置  
3. Codex に `docs/codex_request.md` をコピペして実装依頼  
4. 実装後の例：
   ```bash
   mlbtraj simulate --events data/samples/sample.csv --park lad-dodger-stadium --out out/lad --calibrate-distance
   mlbtraj bundle-viewer --playlist out/lad/playlist.json --park lad-dodger-stadium --dest dist/lad --theme config/theme.json
   python -m http.server --directory dist/lad 8080
   ```