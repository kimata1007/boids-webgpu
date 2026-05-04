# PR Plan: VAT と GLB の座標系不整合を修正

## Status

**事後記録** (Retroactive)。実装コミット `195ef92` 後にこの計画書を起こしました。
本来は `/prp-plan` → 合意 → 実装 の順を守るべきでした。同じブランチに上書きする形でコミットします。

## Context

PR #1 ([feat/sketchfab-bird](https://github.com/kimata1007/boids-webgpu/pull/1)) で取り込んだ Sketchfab の "Flying Bird" モデルが、ブラウザで一切描画されない不具合が発生しました。

## Problem

### 再現条件

```bash
git checkout feat/sketchfab-bird   # ← 195ef92 より前 (commit 221894f)
npm install
npm run dev
# Chrome で http://localhost:5173/ を開く
```

### 症状

- Canvas 自体は表示される（暗い背景）
- **8000 羽の鳥が一切見えない**
- console エラーなし
- WebGPU パイプラインの初期化は完走 (showMessage によるエラー表示なし)

## Root Cause Analysis

VAT (頂点位置を時系列で持つテクスチャ) と静的 GLB (頂点バッファ・インデックス) の **座標スケールが約 100 倍ずれていた**ことが直接原因。

| データ | 範囲 | 経路 |
|---|---|---|
| VAT | x: ±0.25, y: -0.28..+0.16, z: -0.02..+0.26 (~0.5 単位) | Blender Python で `wm @ v.co` を直接読む |
| 静的 GLB | x: -27..+18, y: -12..+20, z: -25..+19 (~45 単位) | `bpy.ops.export_scene.gltf` 経由 |

Blender の glTF エクスポータが暗黙にスケール変換（Maya 由来の cm→m など）を施しており、VAT との一貫性が崩れていた。

頂点分裂 (501→529) 対応として書いていた position-matching ロジックは、スケールが桁違いに違うため**最近傍探索が無意味化**し、ほぼランダムな割り当てを生成 → VAT データ全体が破損していた。

ランタイムでは:
- `vertex_index` は 0..528 を走査
- 各 vid に対し `textureLoad(vat, vec2<u32>(vid, frame))` で位置をサンプル
- 取れる値はランダム化されたゴミ → 三角形が原点近くに潰れて見えない、または巨大化してクリップ外に飛ぶ

## Proposed Change

### 1. `tools/bake_flying_bird.py` を全面改修

**Blender の glTF エクスポータを完全に廃止**し、自前で GLB を構築:

- bmesh で 3 メッシュ (Body / Wing_L / Wing_R) を deterministic 順で統合
- 統合後の頂点位置は VAT[0] と bit-identical (どちらも同じ Blender world coords を使う)
- `struct.pack` と `json.dumps` で minimal GLB を出力
- 頂点数 501 のまま (529 への拡張不要)
- 不要属性 (UV / TEXCOORD_0 / JOINTS_0 / WEIGHTS_0) は出力しない
- POSITION + NORMAL + INDICES のみ

### 2. `src/shaders/render.wgsl` の軸マッピング修正

VAT 範囲から推定したモデル軸:

```
+X : 横 (両翼端の幅、~0.5 単位)
+Y : 上下 (頭が上、足が下)
+Z : 前後 (頭が +Z 方向)
```

シェーダの per-instance world frame `(forward, right, realUp)` への対応:

```wgsl
// before (自家製ハト由来 — localPos.x を forward と仮定)
forward * localPos.x + right * localPos.y + realUp * localPos.z

// after (Sketchfab Flying Bird に合わせ)
right * localPos.x + realUp * localPos.y + forward * localPos.z
```

bind-pose 法線も同じ軸マッピングで再マップ。

### 3. `BIRD_SCALE` 定数の調整

`0.001` → `0.15` に変更。

- 旧値は「モデルが ~45 単位」前提で計算した値だった
- 修正後の VAT は ~0.5 単位なので、`0.15 × 0.5 ≈ 0.075` sim 単位の鳥になる
- sim space は `[-aspect..aspect] × [-0.4..0.4] × [-1..1]` (~3 単位幅)
- 8000 羽が個別に視認できるサイズ

## Files Changed

| ファイル | 変更内容 |
|---|---|
| `tools/bake_flying_bird.py` | 全面改修 (Blender exporter 廃止 + 自前 GLB 出力) |
| `public/flying_bird_static.glb` | 再生成 (501 頂点 / POSITION + NORMAL のみ) |
| `public/flying_bird_vat.bin` | 再生成 (32 frames × 501 verts × 8 byte = 128KB) |
| `public/flying_bird_vat.json` | 再生成 (vertexCount: 529→501, modelExtent 追加) |
| `src/shaders/render.wgsl` | 軸マッピング + BIRD_SCALE (0.001→0.15) |

## Validation

| 項目 | 結果 |
|---|---|
| `npx tsc --noEmit` | ✅ 0 errors |
| `npx vite build` | ✅ 24KB JS 出力成功 |
| dev server smoke (4 endpoints 全て 200) | ✅ |
| VAT バイナリの NaN/Inf チェック (numpy で直接読込) | ✅ NaN=0, Inf=0 |
| 静的 GLB の vertex count == VAT vertex count | ✅ 501 == 501 |
| **ブラウザ視認確認 (8000羽が群れて飛び羽ばたく)** | ⏳ 井上さんお願いします |

## Risks / Open Questions

1. **軸マッピングの妥当性**: VAT 範囲から推測した「x=横, y=上下, z=前後」が誤っていた場合、鳥が横向きや逆向きに飛ぶ。修正は容易（シェーダ 3 行を入れ替え）

2. **bind-pose 法線の固定**: VAT が動いても法線は frame 0 のまま。羽ばたき中のライティングが微妙に不自然になる可能性あり。設計書 PR-06 で明示的に許容している妥協

3. **BIRD_SCALE の決め打ち**: 0.15 は推測値。実機で大き過ぎ/小さ過ぎなら調整が必要

## Lessons Learned

- **思いつきで実装→push せず、必ず先に計画書を書く**
- bug fix でも根本原因と修正方針を文書化してから着手する
- 軽微な変更でも `/prp-plan` → 合意 → `/prp-implement` → `/prp-pr` の順を守る
- 「Blender の glTF エクスポータが暗黙のスケール変換をかける」のは罠として記憶しておく
