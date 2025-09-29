# GPT‑5 Codex 依頼文（ワイヤーフレーム & 内野席ハイビュー 版）

## 目的
Baseball Savant CSV（`launch_speed/launch_angle/hc_x/hc_y[/hit_distance_sc]`）と球場プリセットJSONから、**打球の3D軌道を近似再現**し、**鑑賞ビューア**を提供する。  
**判定は行わず**、CSVの結果（home_run/single/…）は**表示にのみ使用**。  
**レンダリング要件**：**球場は線（ワイヤーフレーム）のみ、着色やテクスチャなし**。**打球の軌道だけ色付きで目立つ**。

## 構成
- Python パッケージ `mlbtraj`（物理＋出力＋球場切替）
- 静的 Web ビューア `viewer/`（Three.js, vanilla JS）
- ブランチ: `dev` → PR → `main`

## 入力
- CSV フィルタ：`launch_speed`, `launch_angle`, `hc_x`, `hc_y` が非NULL
- 列マッピング：EV=`launch_speed`|`ev_mph`; LA=`launch_angle`|`la_deg`; 方位=`hc_x`,`hc_y`; 任意=`hit_distance_sc`
- 表示用：`game_pk`, `inning`, `inning_topbot`, `outs_when_up`, `player_name`, `events`, `des`
- `play_id` は無ければ `game_pk+row_index`

## 球場切替
- `--park <slug>` / `--park-file <path>` / `--list-parks`（`data/ballparks/registry.json` 参照）
- 任意：`--auto-park`（`venueId` or `game_pk` から自動解決）

## 物理・出力
- 座標：原点=本塁、+y=二塁、+x=一塁、+z=上
- 初速：EV(mph)→ft/s、LA/スプレー角φ（`hc_x/hc_y` から設定化可能）
- 力学：重力 + 抗力 + マグナス、RK4。`--calibrate-distance` で `hit_distance_sc` に距離合わせ
- 出力：
  - `out/playlist.json`（再生順＋メタ）
  - `out/trajectories/<play_id>.json`（t, x, y, z）
  - `out/summary.csv`

## Viewer（Three.js）
- **レンダリング制約（重要）**
  - **球場**：`THREE.Line` / `THREE.LineSegments` による**ワイヤーフレーム**（外野フェンス輪郭・フェンス上端・ファウルライン）。**塗り・テクスチャは禁止**。
  - **打球軌道**：`THREE.Line2` 等で**太く色付き**（他要素より強調）。ボール（Sphere）は軌道色に合わせる。
- UI：Start / Prev / Play-Pause / Next / Auto / Speed(0.5/1/2) / **視点切替（Catcher / IF High / LF Stand / CF Stand / RF Stand）** / Follow Ball
- オーバーレイ：イニング（Top/Bot）、アウト、打者名、イベント
- `bundle-viewer --theme config/theme.json` で色・線幅を差し替え可能に（既定テーマ同梱）

## カメラプリセット
- `camera_presets`: `catcher`, **`if_high`（内野席やや高め）**, `lf_stand`, `cf_stand`, `rf_stand`
- `if_high` が JSON に無い場合は自動生成（例：`pos≈[0,-120,55]`, `lookAt≈[0,140,10]`）

## 受け入れ基準
1) CLI と Viewer が動作し、浅い回から順に再生できる  
2) **球場はワイヤーフレームのみ**、**軌道は色付きで強調**  
3) 視点切替（含む `IF High`）と Follow Ball が動く  
4) `--park` / `--park-file` / `--list-parks` が機能  
5) `--calibrate-distance` で誤差±15ft 以内  
6) CI（pytest/ruff/mypy）が緑、README手順で再現可能