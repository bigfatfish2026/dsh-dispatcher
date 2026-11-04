#!/usr/bin/env node
// `dsh-dispatcher tickets` 的入口。真正的实现在 lib/tickets-cli.js（由 src/cli.ts
// 构建而来）：这里只转发参数和退出码，不碰票日志。
import { runTicketsCli } from '../lib/tickets-cli.js'

process.exitCode = runTicketsCli(process.argv.slice(2))
