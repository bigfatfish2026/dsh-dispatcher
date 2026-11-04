import { defineConfig } from 'tsdown'

// tsdown bundles src/index.ts into lib/index.js (ESM) and emits lib/index.d.ts.
// It is also the self-contained `prepare` script for git installs: no project
// references, no type checking (see guide §7.1 "build-script catch").
export default defineConfig({
  entry: { index: 'src/index.ts', 'tickets-cli': 'src/cli.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  dts: true,
  // 2026-11-03：不能 clean。这个包是按 link 装进 profile 的，dsh-hmr 直接盯着
  // lib/index.js；tsdown 一 clean 就先删文件，落在删除到重写之间的一次配置重载
  // 会 import 到不存在的入口，loader 记一条错、条目就没有 fiber 了（票系统整条
  // 消失）。关掉 clean 让旧产物一直在原地，重载最差读到旧代码，不会读到空气。
  clean: false,
  sourcemap: false,
  outDir: 'lib',
  // With `platform: node` tsdown forces `.mjs`/`.cjs`; disable that so ESM output
  // follows the package `"type": "module"` and emits `lib/index.js` +
  // `lib/index.d.ts` — the paths this template's package.json declares. Without
  // this flag the build emits `lib/index.mjs`/`lib/index.d.mts`, `main` resolves
  // to nothing, and the plugin silently never loads.
  fixedExtension: false,
})
