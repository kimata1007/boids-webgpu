# 用語集

迷ったらここを引いてください。アルファベット順、各 1 行説明 + 関連する PR。

## A

### Adapter
物理的な GPU の代理人を表す WebGPU のオブジェクト。`navigator.gpu.requestAdapter()` で取得。複数 GPU 環境ではどれを使うかを選ぶ役割。**Device** の上位概念。

### Animation Channel
glTF アニメーションの 1 軌道。「どのボーンの何（回転/位置/スケール）を、どの時刻でどう動かすか」を持つ。→ PR5

### Armature（アーマチュア）
3D キャラクターを動かす骨格構造の総称。Blender 用語で、glTF だと **Skin** + **Joints** に対応。→ PR2

### Aspect Ratio
画面の縦横比。横 ÷ 縦。Projection 行列の作成時に必要。→ PR1

### <a id="alignment"></a>Alignment（メモリアラインメント）
GPU メモリでデータを配置する規則。Uniform Buffer の構造体メンバーは 16 バイト境界に揃う必要がある。WGSL と JS のレイアウトを一致させないとバグる。

## B

### Bind Group
シェーダにバッファ・テクスチャ・サンプラーを「この番号で繋ぐ」と紐付けるもの。`@group(0) @binding(0)` の番号と一致させる。→ 全 PR

### Bind Pose
スキンメッシュの「動かす前の静止姿勢」。T ポーズのこと。→ PR3, PR4

### Boid
1986 年 Craig Reynolds が発表した群行動シミュレーションのモデル。鳥や魚の群れの動きを 3 つの単純なルール（cohesion / separation / alignment）で再現する。

### Buffer
GPU メモリ上のデータ領域。Vertex / Index / Uniform / Storage の 4 種類。→ 00-primer

## C

### Clip Space
Vertex Shader の `@builtin(position)` が出力する座標空間。`(x, y, z, w)` の 4 次元で、後で w で割って NDC に正規化される。→ 00-primer, PR1

### Cohesion / Alignment / Separation
Boid の 3 ルール。「中心に集まろう」「同じ向きに揃えよう」「近すぎないように離れよう」。

### CommandEncoder
GPU 命令を録音するためのレコーダー。最後に `submit` で GPU にまとめて送る。→ 00-primer

### Compute Shader
任意の並列計算を行うシェーダ。WebGL にはなく、WebGPU で使えるようになった機能。→ 00-primer

## D

### Device
GPU 命令を発行する窓口。`adapter.requestDevice()` で取得。バッファ・パイプラインの作成は全て `device` 経由。

### Depth Buffer（深度バッファ）
ピクセルごとに z 値を保持し、奥のものを手前のものが覆い隠すよう自動制御する仕組み。→ PR1

### Dispatch
Compute Shader を起動するコマンド。`pass.dispatchWorkgroups(x, y, z)` で `x*y*z` 個のワークグループが起動する。

## F

### Fragment Shader
ピクセルごとに色を決めるシェーダ。`fs_main` の名前で実装。→ 00-primer

## G

### glTF
3D アセットの標準フォーマット。JSON ベース。`.gltf` は別ファイル参照、`.glb` は単一バイナリ。→ PR2, PR3

### GPU
Graphics Processing Unit。同じ処理を大量並列に行う計算機。→ 00-primer

## H

### Homogeneous Coordinates（同次座標）
3D の点を `(x, y, z, w)` の 4 要素で扱う方式。平行移動を 4×4 行列で表現できる利点がある。→ PR1

### HUD
Heads Up Display。画面上に常時表示されるオーバーレイ UI（fps 表示など）。

## I

### Index Buffer
三角形を構成する頂点番号の並び。頂点を共有して重複を減らせる。→ PR3

### Inverse Bind Matrix（インバースバインド行列）
スキニング計算で必須の補正行列。「bind pose 時のボーンの世界座標の逆行列」。glTF の `skin.inverseBindMatrices` に格納。→ PR4

### Instance（インスタンス）
同じメッシュを描画位置だけ変えて複数描く仕組み。`draw(vertexCount, instanceCount)` で `instance_index` がシェーダに渡る。8000 羽はこれで実現。

## J

### Joint（ジョイント / ボーン）
スキンメッシュを動かす関節。glTF では node 配列の中で `skin` から参照される特別な node。→ PR2, PR4

## L

### Lambertian Shading（ランバート照明）
最も単純な拡散反射モデル: `輝度 = max(法線 · 光方向, 0)`。3D らしい立体感を最小コストで出す。→ PR3

## M

### Mesh
頂点 + インデックス + マテリアルから成る 3D 形状。

### MVP（Model-View-Projection 行列）
3D の点を画面に映すまでの 3 段階の変換行列。`MVP = P * V * M`。→ PR1

## N

### NDC（Normalized Device Coordinates）
`-1 ≤ x, y ≤ 1`、`0 ≤ z ≤ 1` の正規化空間。Clip Space を w で割ったもの。→ 00-primer, PR1

### Normal（法線）
頂点の向き。ライティング計算に必須。`vec3<f32>` の単位ベクトル。→ PR3

## P

### Pipeline
シェーダとレンダリング設定を束ねたもの。Compute / Render の 2 種類。→ 00-primer

### Perspective Projection（透視投影）
奥行きに応じて物が小さく見える投影方式。視野角と near/far で行列を作る。→ PR1

### Ping-Pong Buffer
読み込み用と書き込み用に 2 個のバッファを交互に使う技法。Compute での自己参照競合を避けるための定番。→ 01-current-state

## Q

### Quaternion（クォータニオン）
3D 回転を 4 要素 `(x, y, z, w)` で表す方式。glTF の回転は必ずこれ。→ PR5

## R

### Render Pass
1 回の描画セッション。`beginRenderPass` で開始、`end` で終了。中で `setPipeline` `setVertexBuffer` `draw` を呼ぶ。

### Render Pipeline
Vertex Shader + Fragment Shader + ブレンド/深度等の描画設定をまとめたもの。→ 00-primer

## S

### Sampler
テクスチャのフィルタリング設定（`linear` か `nearest` か等）を持つオブジェクト。WebGPU では `texture` と独立して持つ。

### Skinning（スキニング）
ボーンの動きに応じて頂点を変形する計算。`P' = Σ w[k] * M[j[k]] * P`。→ PR4

### SIMD
Single Instruction Multiple Data。同じ処理を多数のデータに並列適用する。GPU の本質。→ 00-primer

### Storage Buffer
任意の大きさで読み書き可能な GPU バッファ。Compute Shader の入出力に最適。→ 00-primer

## T

### TRS
Translation, Rotation, Scale の頭文字。3D オブジェクトの基本変換 3 種類。

### TextureLoad / TextureSample
シェーダからテクスチャを読む 2 つの方法。
- `textureLoad`: 整数座標で生のテクセルを取る（フィルタリングなし）
- `textureSample`: 0〜1 の浮動座標でフィルタリング付きで取る

## U

### Uniform Buffer
全コアで共有する読み取り専用の小さなバッファ（〜64KB）。カメラ行列、時刻など。→ 00-primer

## V

### VAT（Vertex Animation Texture）
アニメーションの結果（頂点位置）をテクスチャに焼き込み、ランタイムでスキニング計算をスキップする群衆最適化手法。→ PR6

### VRAM
GPU 専用のメモリ。CPU メモリと別。バッファはここに置かれる。

### Vertex Buffer
頂点ごとの属性データ（位置、法線、UV 等）を持つバッファ。→ PR3

### Vertex Shader
頂点ごとに座標を計算するシェーダ。`vs_main` の名前で実装。→ 00-primer

## W

### WebGL
旧世代のブラウザ用 GPU API。OpenGL ES の派生。Compute Shader が使えない。

### WebGPU
新世代のブラウザ用 GPU API。Vulkan/Metal/DirectX12 と同世代の設計。Compute Shader 対応。

### Weight（頂点重み）
スキニングで「この頂点はこのボーンの動きにこれだけ追従する」を表す浮動小数。4 個ずつ持ち、合計 1.0。→ PR4

### WGSL（WebGPU Shading Language）
WebGPU で使うシェーダ言語。Rust と C を混ぜたような構文。型に厳格。

### Workgroup
Compute Shader の実行単位。`@workgroup_size(64)` なら 64 コア 1 組。`dispatchWorkgroups(125)` で `125 * 64 = 8000` コアが起動する。
