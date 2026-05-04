# boids-webgpu 設計書

このディレクトリは [boids-webgpu](../) プロジェクトの設計書です。
WebGPU を初めて触る読者でも、最後まで読んで手を動かせば、ハトの 3D 群衆シミュレーションを再現できることを目標にしています。

## このプロジェクトの最終ゴール

ブラウザ上で、**羽ばたく 3D ハト 8000 羽**を群行動則（Boids）に従って飛ばします。マウスで誘導できます。

```
最終形のイメージ:

   .   ✈     .  ✈                    ✈ ✈
        ✈        ✈    ✈     .  ✈
   ✈   .          .  ✈    ✈
        .   ✈    ✈      .   .   ✈    ✈ .
  ✈      ✈   .   .  ✈            ✈
        ✈              ✈  .  ✈
   ✈     ✈    .   .       ✈
        .  ✈    ✈   .   ✈
              ✈
        [マウスで吸引/反発]
```

具体的に達成したい要件:

- ハトに見える 3D メッシュ（数百〜数千の三角形）
- 翼が周期的に羽ばたくスケルタルアニメーション
- 8000 羽が滑らかに動く（60fps 目標）
- ブラウザだけで動く。Node や特殊ハードは不要
- 1 行も「ライブラリ任せ」にせず、各層で何が起きているか説明できる

## 読む順番

このディレクトリは、**前から順に読めば理解が積み上がる**よう構成しています。

| # | ファイル | 内容 | 読了目安 |
|---|---------|------|---------|
| 1 | [00-webgpu-primer.md](./00-webgpu-primer.md) | WebGPU とは何か。GPU の基礎、シェーダ、バッファ、パイプラインの考え方 | 30 分 |
| 2 | [01-current-state.md](./01-current-state.md) | 今動いているコード（2D Boids）の構造と、各ファイルの役割 | 20 分 |
| 3 | [02-roadmap.md](./02-roadmap.md) | 最終ゴールに向けた 6 本のコア PR + 拡張 PR の全体像と学習階段 | 10 分 |
| 4 | [pr/PR-01-3d-scene.md](./pr/PR-01-3d-scene.md) | PR1: シーンを 3D 化する | 30 分 |
| 5 | [pr/PR-02-asset-pipeline.md](./pr/PR-02-asset-pipeline.md) | PR2: ハトの 3D アセットを作る（Blender Python） | 45 分 |
| 6 | [pr/PR-03-gltf-loading.md](./pr/PR-03-gltf-loading.md) | PR3: glTF を WebGPU に読み込む | 45 分 |
| 7 | [pr/PR-04-skinning.md](./pr/PR-04-skinning.md) | PR4: ボーンで翼を曲げる（スキニング） | 60 分 |
| 8 | [pr/PR-05-animation.md](./pr/PR-05-animation.md) | PR5: 時間に沿って羽ばたかせる | 30 分 |
| 9 | [pr/PR-06-vat.md](./pr/PR-06-vat.md) | PR6: 8000 羽を捌くために VAT に切り替える | 60 分 |
| 10 | [pr/PR-07-sketchfab-bird.md](./pr/PR-07-sketchfab-bird.md) | PR7: 自家製ハトを Sketchfab の CC-BY 鳥モデルに置き換える | 45 分 |
| 11 | [pr/PR-08-github-pages.md](./pr/PR-08-github-pages.md) | PR8: GitHub Pages で公開する（サブパス対応・Actions・LICENSE） | 30 分 |
| 12 | [glossary.md](./glossary.md) | 用語集（迷ったら参照） | 適宜 |

完走の所要時間: 約 7〜9 時間（読むだけ）。実装まで含めると 2 週間程度。

PR7 以降は「コアが完成した後の拡張」です。PR1〜PR6 で「8000 羽が群れて飛ぶ」を達成し、PR7 で外部アセットへの差し替え、PR8 で公開作業を扱います。

## 表記の約束

- **太字**: 初出の用語と、覚えてほしい結論
- `コード`: ファイル名・関数名・コマンド
- > 引用: 注意点・落とし穴
- 図は ASCII または Mermaid で書きます。Mermaid は GitHub 上でレンダリングされます

## 質問に困ったら

- 用語が分からない → [glossary.md](./glossary.md)
- WebGPU の概念が分からない → [00-webgpu-primer.md](./00-webgpu-primer.md)
- 今のコードのどこが何をしているか分からない → [01-current-state.md](./01-current-state.md)
- どの順序で進めるか迷った → [02-roadmap.md](./02-roadmap.md)
