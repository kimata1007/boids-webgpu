import { defineConfig } from "vite";

// GitHub Pages でサブパス配信される (https://kimata1007.github.io/boids-webgpu/)
// ため、本番ビルドのみ base prefix を付ける。dev サーバはそのまま `/` で動く。
export default defineConfig({
  base: process.env.NODE_ENV === "production" ? "/boids-webgpu/" : "/",
});
