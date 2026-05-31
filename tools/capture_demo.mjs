// public/demo.gif を生成するデモ録画スクリプト。
//
// WebGPU の canvas は Playwright のビデオ録画(screencast)では空フレームになるため、
// page.screenshot() を連射してフレームを集め、ffmpeg で GIF 化する。
// 実 Chrome (channel: 'chrome') + headed でのみ navigator.gpu が有効になる点に注意。
//
// 使い方:
//   node tools/capture_demo.mjs
//   URL=http://localhost:5173/ node tools/capture_demo.mjs   # ローカルを撮る場合
//
// 必要: Google Chrome, ffmpeg, devDependency の playwright

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const URL = process.env.URL ?? 'https://kimata1007.github.io/boids-webgpu/';
const CAP_W = 1280, CAP_H = 720; // キャプチャ解像度
const FRAMES = 60;               // 5 秒 @ 12fps
const OUT_W = 640;               // GIF の幅
const FPS = 12;

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outGif = join(repoRoot, 'public', 'demo.gif');
const frameDir = mkdtempSync(join(tmpdir(), 'boids-demo-'));

console.log(`URL          : ${URL}`);
console.log(`capture      : ${CAP_W}x${CAP_H}, ${FRAMES} frames`);
console.log(`output       : ${outGif} (${OUT_W}px wide, ${FPS}fps)`);
console.log(`frame tmp dir: ${frameDir}`);

const browser = await chromium.launch({ channel: 'chrome', headless: false });
try {
  const page = await browser.newPage({ viewport: { width: CAP_W, height: CAP_H } });
  await page.goto(URL, { waitUntil: 'load', timeout: 30000 });

  // シミュレーションが走り出す(8000 体が立ち上がる)まで待つ
  await page.waitForFunction(
    () => document.querySelector('#count')?.textContent === '8000',
    { timeout: 20000 },
  );
  await page.waitForTimeout(1500); // 群れが落ち着くまで少し待つ

  console.log('capturing frames...');
  for (let i = 0; i < FRAMES; i++) {
    await page.screenshot({
      path: join(frameDir, `f_${String(i).padStart(4, '0')}.png`),
    });
  }
  console.log('capture done');
} finally {
  await browser.close();
}

// ffmpeg: パレット生成 → 適用 の 2 パスで GIF を作る。
// 8000 体の鳥は高エントロピーなので、ディザは切って(dither=none)平坦な色面を作り、
// 64 色に抑えて圧縮を効かせる。仕上げに gifsicle の lossy 最適化をかける。
const palette = join(frameDir, 'palette.png');
const vf = `fps=${FPS},scale=${OUT_W}:-1:flags=lanczos`;
const MAX_COLORS = 64;

console.log('generating palette...');
execFileSync('ffmpeg', [
  '-y', '-framerate', String(FPS), '-i', join(frameDir, 'f_%04d.png'),
  '-vf', `${vf},palettegen=stats_mode=diff:max_colors=${MAX_COLORS}`, palette,
], { stdio: 'inherit' });

console.log('encoding gif...');
mkdirSync(dirname(outGif), { recursive: true });
execFileSync('ffmpeg', [
  '-y', '-framerate', String(FPS), '-i', join(frameDir, 'f_%04d.png'), '-i', palette,
  '-lavfi', `${vf} [x]; [x][1:v] paletteuse=dither=none`,
  '-loop', '0', outGif,
], { stdio: 'inherit' });

// gifsicle があれば lossy 最適化でさらに縮める(無ければスキップ)
try {
  execFileSync('gifsicle', ['-O3', '--lossy=100', outGif, '-o', outGif], { stdio: 'inherit' });
} catch {
  console.warn('gifsicle が無いため lossy 最適化をスキップしました (任意)');
}

rmSync(frameDir, { recursive: true, force: true });

const kb = (statSync(outGif).size / 1024).toFixed(0);
console.log(`\ndone: ${outGif} (${kb} KB)`);
