#!/usr/bin/env node
/**
 * `dsh-dispatcher` 票日志迁移：jsonl → SQLite。
 *
 * 逻辑全在 `src/store/migrate.ts`（`runMigrateCli`），这个文件只是入口：Node 直接
 * 跑 .ts 时不做「无扩展名 import」的解析，所以这里动态加载构建产物
 * `lib/migrate.js`；没 build 过就提示先 `npm run build`。
 *
 *   npm run build
 *   node scripts/migrate-to-sqlite.ts ~/.dsh/dispatcher/tickets.jsonl --dry-run
 *   node scripts/migrate-to-sqlite.ts ~/.dsh/dispatcher/tickets.jsonl --out /tmp/check.db
 *
 * 输入只读；输出默认 /tmp；--out 落进真实 ~/.dsh 会被拒绝。
 */
import { existsSync } from 'node:fs'

const lib = new URL('../lib/migrate.js', import.meta.url)

if (!existsSync(lib)) {
  process.stderr.write('找不到 lib/migrate.js：先 npm run build（这条入口加载的是构建产物）。\n')
  process.exit(2)
}

const { runMigrateCli } = await import(lib.href)
const io = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
}
process.exitCode = runMigrateCli(process.argv.slice(2), io)
