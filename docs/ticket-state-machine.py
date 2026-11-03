#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""票（ticket）状态机图 —— 谁写 status、谁能改谁。

和 worker-ticket-lifecycle-i18n.py 分工：
  那张是泳道图，讲 M / W / 票三层的时间线（谁先动、谁等谁）；
  这张只讲状态：六个 status、每条转移的写入者、以及哪几条边被代码写死了。
  两张图不互相替代。

用法：
    python3 ticket-state-machine.py                 -> ticket-state-machine.zh.png
    python3 ticket-state-machine.py --lang zh       -> 同上
    python3 ticket-state-machine.py --lang en       -> ticket-state-machine.en.png

跑完在终端打印一张自查表：每条边 → 源码文件:行号 → 该行原文。
行号是现读现验的（needle 必须真的出现在那一行），有一边对不上就 CHECK=FAIL。

源码事实（2026-11-03 读的是 working tree，不是印象）：
  src/store.ts:5    六个状态的定义
  src/store.ts:320  store.open 写 status='open'
  src/index.ts:229  dispatch_open 调 store.open
  src/index.ts:230  dispatch_open 带 owner 时补一次 status='running'
  src/index.ts:264  dispatch_touch 原样写调用方给的 status（enum 六值）
  src/index.ts:357  dispatch_close 的 status = outcome ?? 'done'
  src/index.ts:457  subagent/end 只看 open / running
  src/index.ts:473  subagent/end 写 status='waiting'（永不写 done）
  src/index.ts:474  subagent/end 的 note = worker 结束（stopReason），票内 N 条报告
  src/index.ts:547  sweep 复活只看 done
  src/index.ts:551  sweep 写 status='open'
  src/index.ts:703  dispatch_send 只 appendInput + markDelivered，不碰 status
  src/zombie.ts:101 noReportMinutes 的默认值（5）
  src/zombie.ts:112-114  waiting 且 0 条报告才进 no-report 这一档
"""
import argparse
import os
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib import font_manager
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch

HERE = __file__.rsplit("/", 1)[0]
REPO = HERE.rsplit("/", 1)[0]

# ======================================================================
# 参数 / 字体
# ======================================================================
parser = argparse.ArgumentParser(add_help=True)
parser.add_argument("--lang", default=None, help="zh 或 en")
parser.add_argument("positional_lang", nargs="?", default=None)
args = parser.parse_args()
LANG = (args.lang or args.positional_lang or "zh").strip().lower()
if LANG not in ("zh", "en"):
    raise SystemExit("usage: ticket-state-machine.py [--lang zh|en]")


def require_font(family, why):
    try:
        path = font_manager.findfont(
            font_manager.FontProperties(family=family), fallback_to_default=False
        )
    except Exception:
        raise SystemExit(
            "[font] 缺字体：%s（%s）。装一下 fonts-noto-cjk / fonts-dejavu 再跑，"
            "别让图中文字变成方框。" % (family, why)
        )
    return path


F_SANS = "Noto Sans CJK SC" if LANG == "zh" else "DejaVu Sans"
F_MONO = "DejaVu Sans Mono"
require_font(F_SANS, "正文")
require_font(F_MONO, "工具名 / 代码 / 行号")

plt.rcParams["font.family"] = [F_SANS, F_MONO, "Noto Sans CJK SC"]
plt.rcParams["font.sans-serif"] = [F_SANS, "DejaVu Sans"]
plt.rcParams["axes.unicode_minus"] = False

# ======================================================================
# 文案表
# ======================================================================
T = {
    "zh": {
        "title": "票的状态机：六个 status，谁写、谁能改谁",
        "subtitle": "dsh-dispatcher · status 只由 6 处 append 写入（dispatch_open / touch / close / sweep / subagent,end）"
                   " · 图只画代码里找得到出处的边",
        "region": "未结区　isOpen = open | running | waiting | blocked",
        "open_t": "open", "open_2": "建票 / 复活后的初态", "open_3": "store.open · sweep",
        "run_t": "running", "run_2": "小鱼在干", "run_3": "dispatch_open·owner",
        "wait_t": "waiting", "wait_2": "小鱼结束，等人判交付", "wait_3": "subagent/end · 非交付",
        "wait_4": "这个状态不代表交活", "wait_5": "票里 0 条报告会被巡检盯",
        "blk_t": "blocked", "blk_2": "人按着不动", "blk_3": "只有 dispatch_touch 写",
        "done_t": "done", "done_2": "交付完了", "done_3": "终态",
        "drop_t": "dropped", "drop_2": "不干了", "drop_3": "终态 · 不会复活",
        "e_create": "建票",
        "e_open_run": "dispatch_open",
        "e_open_run2": "带 owner",
        "e_run_wait": "subagent/end",
        "e_run_wait2": "owner 匹配",
        "e_note_h": "落 waiting 时写进 note（原文）：",
        "e_note": "worker 结束（completed），票内 N 条报告",
        "e_open_wait": "subagent/end（open 也在内）",
        "e_close": "dispatch_close",
        "e_close2": "任一未结状态",
        "e_dropped": "dropped",
        "e_revive": "sweep：晚于 closedAt 的未送达 input → 复活",
        "e_touch": "dispatch_touch",
        "e_touch2": "双向示例",
        "cardA_title": "四条硬规矩（图上实线的全部出处）",
        "rule1": "① done / dropped 只由 dispatch_close 写 —— index.ts:357-358（outcome 默认 done，显式传 dropped 才是 dropped）",
        "rule1b": "   约定，不是守卫：dispatch_touch 的 enum 六态全在（index.ts:33 / 264），它真能写 done",
        "rule2": "② subagent/end 只把 open|running 落成 waiting，永不写 done —— index.ts:457 / 469",
        "rule3": "③ sweep 复活只认晚于 closedAt 的未送达 input，且只复活 done —— index.ts:541-545 + store.ts:247",
        "rule3b": "   dropped 是人叫停，永远不复活；closedAt 由那次 status 事件钉住（store.ts:247）",
        "rule4": "④ 巡检另有独立一档 noReportMinutes（默认 5 分钟），只盯 waiting 且 0 条报告的票 —— zombie.ts:101-114",
        "rule4b": "   补上报告就不再提醒，指纹随巡检清掉；这类票在列表上显示 waiting?",
        "cardB_title": "显示标记 / 边的样式 / 没画出来的边",
        "mark": "»n 有 n 条消息小鱼还没收到（index.ts:302）　«n 有 n 条报告主会话还没读（index.ts:303）　"
                "! 这张票静默了（index.ts:307）",
        "mark2": "三个都是列表里的显示标记，不是 status，也不单独存一行日志。",
        "style": "实线 = 工具或事件写死的边；灰虚线 = dispatch_touch 手改（六态两两互改 30 条有向边，"
                 "图上只画一条双向示例）。waiting→running 这种回头路只有 touch 能做，"
                 "dispatch_send 不会把票拉回 running。",
        "missing": "没画出来的边（找不到出处）：",
        "missing2": "· dispatch_send 只 appendInput + markDelivered，不碰 status（index.ts:694-701）　"
                    "· blocked 没有任何自动入口，只有 dispatch_touch 能写（index.ts:264）",
        "footer": "生成：docs/ticket-state-machine.py --lang zh　·　源码行号由脚本现读现验，终端会打 CHECK 表",
    },
    "en": {
        "title": "Ticket state machine: who writes which status",
        "subtitle": "dsh-dispatcher · status is only ever written by 6 append sites "
                    "(dispatch_open / touch / close / sweep / subagent,end) · only edges with a source line are drawn",
        "region": "not ended　isOpen = open | running | waiting | blocked",
        "open_t": "open", "open_2": "created / revived", "open_3": "store.open · sweep",
        "run_t": "running", "run_2": "worker is working", "run_3": "dispatch_open + owner",
        "wait_t": "waiting", "wait_2": "worker gone, judge it", "wait_3": "subagent/end event",
        "wait_4": "this is not a hand-off", "wait_5": "0 reports → watched",
        "blk_t": "blocked", "blk_2": "a person holds it", "blk_3": "only dispatch_touch",
        "done_t": "done", "done_2": "delivered", "done_3": "terminal",
        "drop_t": "dropped", "drop_2": "called off", "drop_3": "terminal · no revive",
        "e_create": "create",
        "e_open_run": "dispatch_open",
        "e_open_run2": "with owner",
        "e_run_wait": "subagent/end",
        "e_run_wait2": "owner match",
        "e_note_h": "the note written when landing in waiting:",
        "e_note": "worker 结束（completed），票内 N 条报告",
        "e_open_wait": "subagent/end (open included)",
        "e_close": "dispatch_close",
        "e_close2": "any not-ended",
        "e_dropped": "dropped",
        "e_revive": "sweep: undelivered input newer than closedAt → revive",
        "e_touch": "dispatch_touch",
        "e_touch2": "both ways",
        "cardA_title": "Four hard rules (every solid edge, with its source)",
        "rule1": "(1) done / dropped only written by dispatch_close — index.ts:357-358 (outcome defaults to done)",
        "rule1b": "    by convention, not by a guard: dispatch_touch accepts all six (index.ts:33 / 264), so it can write done",
        "rule2": "(2) subagent/end only turns open|running into waiting, never done — index.ts:457 / 469",
        "rule3": "(3) sweep revives only on undelivered input newer than closedAt, and only from done — index.ts:541-545 + store.ts:247",
        "rule3b": "    dropped is a person's stop and never revives; closedAt is pinned by that status event (store.ts:247)",
        "rule4": "(4) the sweep has its own noReportMinutes tier (default 5 min) watching only waiting tickets with 0 reports — zombie.ts:101-114",
        "rule4b": "   a report landing ends the watch and its fingerprint is dropped; such rows print waiting?",
        "cardB_title": "Display marks / edge styles / edges not drawn",
        "mark": "»n n messages the worker has not received (index.ts:302)　«n n reports unread (index.ts:303)　"
                "! quiet ticket (index.ts:307)",
        "mark2": "all three are display marks in dispatch_list, not statuses, not log lines of their own.",
        "style": "solid = written by a tool or an event; grey dashed = dispatch_touch (all 30 directed pairs exist, "
                 "one sample drawn). a way back such as waiting→running is touch-only: dispatch_send never "
                 "pulls a ticket back to running.",
        "missing": "edges not drawn (no source found):",
        "missing2": "· dispatch_send only appends input + marks delivered, it never touches status (index.ts:694-701)　"
                    "· blocked has no automatic entry at all (index.ts:264)",
        "footer": "generated by docs/ticket-state-machine.py --lang en　·　line numbers are read and verified at run time; CHECK table in terminal",
    },
}[LANG]


def t(key):
    return T[key]


# ======================================================================
# 边的清单：同时供绘图与自查表使用
# 每条边必须能指到 (文件, 行号, 必须在那一行里出现的片段)
# ======================================================================
EDGES = [
    {
        "id": "E1", "frm": "-", "to": "open",
        "label": "dispatch_open (create)",
        "srcs": [("src/index.ts", 229, "store.open(args.goal"),
                 ("src/store.ts", 320, "status: 'open'")],
    },
    {
        "id": "E2", "frm": "open", "to": "running",
        "label": "dispatch_open (owner given)",
        "srcs": [("src/index.ts", 230, "status: 'running'"),
                 ("src/index.ts", 233, "args.owner ? 'running' : 'open'")],
    },
    {
        "id": "E3", "frm": "open", "to": "waiting",
        "label": "subagent/end",
        "srcs": [("src/index.ts", 457, "ticket.status !== 'open' && ticket.status !== 'running'"),
                 ("src/index.ts", 473, "status: 'waiting'")],
    },
    {
        "id": "E4", "frm": "running", "to": "waiting",
        "label": "subagent/end",
        "srcs": [("src/index.ts", 457, "ticket.status !== 'open' && ticket.status !== 'running'"),
                 ("src/index.ts", 473, "status: 'waiting'")],
    },
    {
        "id": "E5", "frm": "open|running|waiting|blocked", "to": "done",
        "label": "dispatch_close (outcome default done)",
        "srcs": [("src/index.ts", 357, "args.outcome ?? 'done'"),
                 ("src/index.ts", 358, "store.update(args.id, { status, note: args.note })")],
    },
    {
        "id": "E6", "frm": "open|running|waiting|blocked", "to": "dropped",
        "label": "dispatch_close (outcome=dropped)",
        "srcs": [("src/index.ts", 337, "['done', 'dropped']"),
                 ("src/index.ts", 358, "store.update(args.id, { status, note: args.note })")],
    },
    {
        "id": "E7", "frm": "done", "to": "open",
        "label": "sweep (revive)",
        "srcs": [("src/index.ts", 547, "if (ticket.status !== 'done') continue"),
                 ("src/index.ts", 549, "Date.parse(entry.at) > since"),
                 ("src/index.ts", 551, "status: 'open'"),
                 ("src/store.ts", 247, "closedAt: event.status")],
    },
    {
        "id": "E8", "frm": "any", "to": "any",
        "label": "dispatch_touch (unguarded)",
        "srcs": [("src/index.ts", 264, "status: args.status"),
                 ("src/index.ts", 33, "'blocked', 'done', 'dropped'")],
    },
]

# 证伪 / 没画出来的边：也要指到行号，但不参与实线绘制
NEGATIVES = [
    {"id": "N1", "what": "dispatch_send does not change status",
     "srcs": [("src/index.ts", 703, "store.appendInput(args.id, args.text)"),
              ("src/index.ts", 708, "store.markDelivered(ticket.id, 'input', entry.id)")]},
    {"id": "N2", "what": "blocked has no automatic writer",
     "srcs": [("src/index.ts", 264, "status: args.status"),
              ("src/index.ts", 33, "'open', 'running', 'waiting', 'blocked'")]},
    {"id": "N3", "what": "subagent/end never writes done",
     "srcs": [("src/index.ts", 473, "status: 'waiting'"),
              ("src/index.ts", 457, "ticket.status !== 'open' && ticket.status !== 'running'")]},
]

# 图上的「巡检新档」相关的三句话：不属于边，也要能指到源码
CLAIMS = [
    {"id": "C1", "what": "subagent/end writes stopReason + report count into note",
     "srcs": [("src/index.ts", 473, "status: 'waiting'"),
              ("src/index.ts", 474, "note: `worker 结束（${String(information.stopReason"),
              ("src/index.ts", 475, "carried === 0 ? '票内无报告'")]},
    {"id": "C2", "what": "noReportMinutes defaults to 5",
     "srcs": [("src/zombie.ts", 18, "export const DEFAULT_NO_REPORT_MINUTES = 5"),
              ("src/zombie.ts", 101, "const noReportMinutes = options.noReportMinutes ?? DEFAULT_NO_REPORT_MINUTES"),
              ("src/config.ts", 211, ".default(5)")]},
    {"id": "C3", "what": "only waiting + 0 reports enters the no-report tier",
     "srcs": [("src/zombie.ts", 112, "if (ticket.status === 'waiting') {"),
              ("src/zombie.ts", 113, "if (ticket.reports.length > 0) continue"),
              ("src/zombie.ts", 114, "if (idleMinutes < noReportMinutes) continue")]},
]

# ======================================================================
# 画布（A4 横向 ≈ 297×210mm，dpi 160 → 1871×1323 px）
# 坐标单位就是像素：坐标轴铺满整张 figure，1 单位 = 1 px
# ======================================================================
DPI = 160
W, H = 1871, 1323
fig = plt.figure(figsize=(W / DPI, H / DPI), dpi=DPI)
ax = fig.add_axes([0, 0, 1, 1])
ax.set_xlim(0, W)
ax.set_ylim(0, H)
ax.axis("off")
fig.patch.set_facecolor("white")

INK = "#111827"
SUB = "#4b5563"
C_LIVE_BG, C_LIVE_ED = "#ece9fe", "#7c3aed"     # open / running
C_WAIT_BG, C_WAIT_ED = "#fef9c3", "#d97706"     # waiting（第三色：非交付）
C_BLK_BG, C_BLK_ED = "#fff7ed", "#ea580c"       # blocked（人按着）
C_DONE_BG, C_DONE_ED = "#bbf7d0", "#15803d"     # done（终态）
C_DROP_BG, C_DROP_ED = "#fde2e2", "#b91c1c"     # dropped（终态）
C_NOTE_BG, C_NOTE_ED = "#f8fafc", "#94a3b8"     # 卡片 / 区域
C_EDGE = "#334155"
C_TOUCH = "#94a3b8"
C_MONO = "#0f172a"

DASH = (0, (6, 4))
DOT = (0, (3, 3))

SEGS = []      # 所有线段，用于「箭头穿过文字」检查
RECTS = {}     # 名字 -> (x0, y0, x1, y1)
TEXTS = []     # (label, artist, owner_box)
PAD = 2.0


def register_segs(pts):
    for k in range(len(pts) - 1):
        SEGS.append((pts[k], pts[k + 1]))


def box(cx, cy, w, h, bg, ed, ls="-", lw=1.9, z=3, name=None):
    ax.add_patch(FancyBboxPatch((cx - w / 2, cy - h / 2), w, h,
                                boxstyle="round,pad=0,rounding_size=12",
                                linewidth=lw, edgecolor=ed, facecolor=bg,
                                linestyle=ls, zorder=z))
    if name:
        RECTS[name] = (cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)
    return (cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)


def tag(x, y, text, fs_=10, color=SUB, ha="center", va="center", rot=0,
        bold=False, mono=False, z=6, label=None, owner=None, ls_sp=1.5):
    art = ax.text(x, y, text, ha=ha, va=va, rotation=rot, fontsize=fs_,
                  color=color, zorder=z, linespacing=ls_sp,
                  fontweight="bold" if bold else "normal",
                  fontfamily=[F_MONO, F_SANS, "Noto Sans CJK SC"] if mono
                  else [F_SANS, "Noto Sans CJK SC"])
    TEXTS.append((label or text.replace("\n", " / ")[:34], art, owner))
    return art


def arrow(pts, color=C_EDGE, ls="-", lw=2.0, z=4, head=16):
    register_segs(pts)
    if len(pts) > 2:
        ax.plot([p[0] for p in pts[:-1]], [p[1] for p in pts[:-1]], color=color,
                linestyle=ls, linewidth=lw, zorder=z, solid_capstyle="round")
    ax.add_patch(FancyArrowPatch(pts[-2], pts[-1], arrowstyle="-|>", mutation_scale=head,
                                 color=color, linestyle=ls, linewidth=lw,
                                 zorder=z, shrinkA=0, shrinkB=0))


def arrow_both(pts, color=C_TOUCH, ls=DASH, lw=2.0, z=4, head=13):
    register_segs(pts)
    ax.add_patch(FancyArrowPatch(pts[0], pts[1], arrowstyle="-|>", mutation_scale=head,
                                 color=color, linestyle=ls, linewidth=lw,
                                 zorder=z, shrinkA=0, shrinkB=0))
    ax.add_patch(FancyArrowPatch(pts[-1], pts[-2], arrowstyle="-|>", mutation_scale=head,
                                 color=color, linestyle=ls, linewidth=lw,
                                 zorder=z, shrinkA=0, shrinkB=0))


def seg(pts, color, ls=DASH, lw=1.6, z=2):
    register_segs(pts)
    ax.plot([p[0] for p in pts], [p[1] for p in pts], color=color, linestyle=ls,
            linewidth=lw, zorder=z, solid_capstyle="round")


RENDER = None


def renderer():
    global RENDER
    if RENDER is None:
        fig.canvas.draw()
        RENDER = fig.canvas.get_renderer()
    return RENDER


def fit_tag(x, y, text, fs_, max_w, **kw):
    """画一段文字；比 max_w 宽就自动缩字号（最小 6.4pt），保证不出框。"""
    art = tag(x, y, text, fs_=fs_, **kw)
    cur = fs_
    while art.get_window_extent(renderer()).width > max_w and cur > 6.4:
        cur -= 0.2
        art.set_size(cur)
    return art


def state(cx, cy, w, h, name, title, line2, line3, bg, ed, tcol,
          line4=None, line5=None):
    """一个状态框。给了 line4/line5 就排五行（waiting 那种要补一句的框）。"""
    box(cx, cy, w, h, bg, ed, name=name)
    if line4 is None:
        fit_tag(cx, cy + 32, title, 14.5, w - 20, color=tcol, bold=True, mono=True, owner=name)
        fit_tag(cx, cy - 9, line2, 9.2, w - 16, color=INK, owner=name)
        fit_tag(cx, cy - 40, line3, 8.2, w - 16, color=SUB, owner=name, mono=True)
        return
    fit_tag(cx, cy + 40, title, 14.0, w - 20, color=tcol, bold=True, mono=True, owner=name)
    fit_tag(cx, cy + 12, line2, 9.2, w - 16, color=INK, owner=name)
    fit_tag(cx, cy - 10, line3, 8.2, w - 16, color=SUB, owner=name, mono=True)
    fit_tag(cx, cy - 33, line4, 8.2, w - 16, color="#b45309", bold=True, owner=name)
    if line5 is not None:
        fit_tag(cx, cy - 55, line5, 8.2, w - 16, color="#b45309", bold=True, owner=name)


# ======================================================================
# 标题
# ======================================================================
fit_tag(70, 1276, t("title"), 21, W - 150, color=INK, ha="left", bold=True, label="title")
fit_tag(70, 1222, t("subtitle"), 10.0, W - 150, color=SUB, ha="left", label="subtitle")

# ======================================================================
# 六个状态框
# ======================================================================
BW, BH = 236, 120
X_OPEN, X_RUN, X_WAIT, X_TERM = 350, 735, 1120, 1640
Y_ROW, Y_BLK = 1000, 760
Y_DONE, Y_DROP = 1015, 745
GAP_L, GAP_R = X_RUN - BW / 2 - (X_OPEN + BW / 2), X_WAIT - BW / 2 - (X_RUN + BW / 2)

state(X_OPEN, Y_ROW, BW, BH, "open", t("open_t"), t("open_2"), t("open_3"),
      C_LIVE_BG, C_LIVE_ED, C_LIVE_ED)
state(X_RUN, Y_ROW, BW, BH, "running", t("run_t"), t("run_2"), t("run_3"),
      C_LIVE_BG, C_LIVE_ED, C_LIVE_ED)
# waiting 比同排两个框高一点：它要多写两句「不等于交活」，压扁了就得缩字号。
BH_WAIT = 156
Y_WAIT = Y_ROW - 18
state(X_WAIT, Y_WAIT, BW, BH_WAIT, "waiting", t("wait_t"), t("wait_2"), t("wait_3"),
      C_WAIT_BG, C_WAIT_ED, "#b45309", line4=t("wait_4"), line5=t("wait_5"))
state(X_WAIT, Y_BLK, BW, BH, "blocked", t("blk_t"), t("blk_2"), t("blk_3"),
      C_BLK_BG, C_BLK_ED, C_BLK_ED)
state(X_TERM, Y_DONE, BW, BH, "done", t("done_t"), t("done_2"), t("done_3"),
      C_DONE_BG, C_DONE_ED, C_DONE_ED)
state(X_TERM, Y_DROP, BW, BH, "dropped", t("drop_t"), t("drop_2"), t("drop_3"),
      C_DROP_BG, C_DROP_ED, C_DROP_ED)

# 未结区（dashed 包围 open / running / waiting / blocked；左边留一个入口缺口）
RX0, RX1, RY0, RY1 = 205, 1250, 640, 1090
GAP0, GAP1 = 990, 1010
for pts in (
    [(RX0, RY1), (RX1, RY1)],
    [(RX1, RY1), (RX1, RY0)],
    [(RX1, RY0), (RX0, RY0)],
    [(RX0, RY1), (RX0, GAP1)],
    [(RX0, GAP0), (RX0, RY0)],
):
    ax.plot([p[0] for p in pts], [p[1] for p in pts], color=C_NOTE_ED,
            linestyle=(0, (8, 5)), linewidth=1.5, zorder=1)
tag(RX0 + 12, RY0 + 28, t("region"), fs_=9.3, color="#64748b", ha="left", label="region-label")

# ---------- E1 建票：起点 -> open ----------
ax.add_patch(plt.Circle((98, Y_ROW), 7.5, color=C_EDGE, zorder=5))
fit_tag(132, 1040, "dispatch_open\n" + t("e_create"), 8.4, 132, color=C_EDGE,
        mono=True, bold=True, label="E1-label")
arrow([(106, Y_ROW), (X_OPEN - BW / 2, Y_ROW)], lw=2.1)

# ---------- E2 open -> running ----------
arrow([(X_OPEN + BW / 2, Y_ROW), (X_RUN - BW / 2, Y_ROW)])
fit_tag((X_OPEN + X_RUN) / 2, 1034, t("e_open_run"), 8.5, GAP_L - 8,
        color=C_EDGE, mono=True, label="E2-label")
fit_tag((X_OPEN + X_RUN) / 2, 966, t("e_open_run2"), 8.5, GAP_L - 8,
        color=SUB, label="E2-label2")

# ---------- E4 running -> waiting ----------
arrow([(X_RUN + BW / 2, Y_ROW), (X_WAIT - BW / 2, Y_ROW)])
fit_tag((X_RUN + X_WAIT) / 2, 1034, t("e_run_wait"), 8.5, GAP_R - 8,
        color=C_EDGE, mono=True, label="E4-label")
fit_tag((X_RUN + X_WAIT) / 2, 966, t("e_run_wait2"), 8.5, GAP_R - 8,
        color=SUB, label="E4-label2")

# E4 这条边落 waiting 时会把 stopReason 和报告条数写进 note —— 原文放不下那条缝，
# 引到右上角空地，一条点线指回 waiting 框。
fit_tag(1150, 1138, t("e_note_h"), 8.4, 420, color=SUB, ha="left", label="E4-note-h")
fit_tag(1150, 1110, t("e_note"), 8.6, 420, color=C_EDGE, ha="left", mono=True,
        label="E4-note")
seg([(1150, 1094), (1204, 1068)], "#94a3b8", ls=DOT, lw=1.6, z=2)

# ---------- E3 open -> waiting（绕过 running 上方） ----------
arrow([(X_OPEN + 80, Y_ROW + BH / 2), (X_OPEN + 80, 1120), (X_WAIT, 1120),
       (X_WAIT, Y_WAIT + BH_WAIT / 2)], lw=1.9)
tag(600, 1138, t("e_open_wait"), fs_=9.0, color=C_EDGE, label="E3-label")

# ---------- E7 done -> open（sweep 复活，走最上方） ----------
arrow([(X_TERM, Y_DONE + BH / 2), (X_TERM, 1192), (X_OPEN - 80, 1192),
       (X_OPEN - 80, Y_ROW + BH / 2)], color=C_DONE_ED, lw=1.9)
tag(1010, 1172, t("e_revive"), fs_=9.2, color=C_DONE_ED, label="E7-label")

# ---------- E5 / E6 close：未结区 -> done / dropped ----------
CLOSE_Y = 920
CLOSE_X = 1440
# 共干：从整个未结区引出一条，再在岔口分成 done / dropped 两条
seg([(RX1, CLOSE_Y), (CLOSE_X, CLOSE_Y)], C_EDGE, ls="-", lw=2.0, z=4)
ax.add_patch(plt.Circle((CLOSE_X, CLOSE_Y), 3.6, color=C_EDGE, zorder=5))
arrow([(CLOSE_X, CLOSE_Y), (CLOSE_X, Y_DONE), (X_TERM - BW / 2, Y_DONE)],
      color=C_DONE_ED, lw=1.9)
arrow([(CLOSE_X, CLOSE_Y), (CLOSE_X, Y_DROP), (X_TERM - BW / 2, Y_DROP)],
      color=C_DROP_ED, lw=1.9)
fit_tag(1340, 902, t("e_close"), 8.6, 168, color=C_EDGE, mono=True, bold=True,
        label="E5-label")
fit_tag(1340, 874, t("e_close2"), 9.0, 168, color=SUB, label="E5-label2")

# ---------- E8 dispatch_touch：双向示例（waiting <-> blocked） ----------
arrow_both([(X_WAIT, Y_BLK + BH / 2), (X_WAIT, Y_WAIT - BH_WAIT / 2)])
tag(975, 888, t("e_touch"), fs_=8.6, color=C_TOUCH, mono=True, label="E8-label")
tag(975, 860, t("e_touch2"), fs_=9.0, color=C_TOUCH, label="E8-label2")

# ======================================================================
# 底部两张卡片（段落按实测高度往下排，不靠手数行距）
# ======================================================================
def est_w(text, fs_):
    total = 0.0
    for ch in text:
        total += fs_ * 2.222 * (1.0 if ord(ch) > 0x2E80 else 0.55)
    return total


def wrap_text(text, fs_, max_px):
    out, line, cur = [], "", 0.0
    for ch in text:
        w = fs_ * 2.222 * (1.0 if ord(ch) > 0x2E80 else 0.55)
        if cur + w > max_px and line:
            cut = line.rfind(" ")
            if cut > len(line) * 0.6 and ord(ch) < 0x2E80:
                out.append(line[:cut])
                line = line[cut + 1:]
            else:
                out.append(line)
                line = ""
            cur = est_w(line, fs_)
        line += ch
        cur += w
    if line:
        out.append(line)
    return "\n".join(out)


def card(x0, x1, y0, y1, title, name):
    ax.add_patch(FancyBboxPatch((x0, y0), x1 - x0, y1 - y0,
                                boxstyle="round,pad=0,rounding_size=14",
                                facecolor=C_NOTE_BG, edgecolor=C_NOTE_ED,
                                linewidth=1.4, zorder=2))
    RECTS[name] = (x0, y0, x1, y1)
    tag(x0 + 18, y1 - 27, title, fs_=11.2, color=INK, ha="left", bold=True,
        label=name + "-title")
    return x0 + 18, y1 - 60


def paras(x, y, items, max_px, owner):
    renderer_local = fig.canvas.get_renderer() if fig.canvas.get_renderer() else None
    for text, fs_, color, gap in items:
        body = wrap_text(text, fs_, max_px)
        art = tag(x, y, body, fs_=fs_, color=color, ha="left", va="top",
                  owner=owner, label=owner + ":" + text[:16], ls_sp=1.38)
        fig.canvas.draw()
        ext = art.get_window_extent(fig.canvas.get_renderer())
        y -= ext.height + gap
    return y


AX0, AX1 = 70, 985
BX0, BX1 = 1015, 1801
CY0, CY1 = 70, 634
card(AX0, AX1, CY0, CY1, t("cardA_title"), "cardA")
card(BX0, BX1, CY0, CY1, t("cardB_title"), "cardB")

ax_, ay_ = card(AX0, AX1, CY0, CY1, "", "cardA-ghost") if False else (AX0 + 18, CY1 - 60)
paras(AX0 + 18, CY1 - 62, [
    (t("rule1"), 9.6, C_DONE_ED, 14),
    (t("rule1b"), 9.2, SUB, 18),
    (t("rule2"), 9.6, "#b45309", 18),
    (t("rule3"), 9.6, C_DONE_ED, 14),
    (t("rule3b"), 9.2, SUB, 18),
    (t("rule4"), 9.4, "#b45309", 12),
    (t("rule4b"), 9.0, SUB, 0),
], (AX1 - 18) - (AX0 + 18), "cardA")

paras(BX0 + 18, CY1 - 62, [
    (t("mark"), 9.2, INK, 10),
    (t("mark2"), 9.2, SUB, 20),
    (t("style"), 9.2, SUB, 20),
    (t("missing"), 9.2, INK, 8),
    (t("missing2"), 9.2, SUB, 0),
], (BX1 - 18) - (BX0 + 18), "cardB")

tag(70, 44, t("footer"), fs_=8.6, color="#94a3b8", ha="left", label="footer")

# ======================================================================
# 自查表：边的出处（现读现验）
# ======================================================================
_cache = {}


def line_of(path, no):
    if path not in _cache:
        with open(path, "r", encoding="utf-8") as handle:
            _cache[path] = handle.read().split("\n")
    lines = _cache[path]
    if no < 1 or no > len(lines):
        return None
    return lines[no - 1]


def src_path(rel):
    return "%s/%s" % (REPO, rel)


def check_edge(edge):
    rows, ok = [], True
    for rel, no, needle in edge["srcs"]:
        text = line_of(src_path(rel), no)
        good = text is not None and needle in text
        ok = ok and good
        rows.append((rel, no, (text or "<no such line>").strip(), good))
    return ok, rows


def wrap(text, width=78):
    out = []
    while len(text) > width:
        out.append(text[:width])
        text = text[width:]
    out.append(text)
    return out


print("=" * 108)
print("ticket state machine — edge sources (file:line read and verified now)")
print("=" * 108)
bad_edges = []
for edge in EDGES:
    ok, rows = check_edge(edge)
    head = "%-3s %-34s -> %-6s" % (edge["id"], edge["frm"], edge["to"])
    print("%s %-42s %s" % (head, edge["label"], "OK" if ok else "FAIL"))
    for rel, no, text, good in rows:
        snippet = text if len(text) <= 96 else text[:93] + "..."
        print("      %-24s %5d  %s  %s" % ("%s:%d" % (rel, no), no,
                                           "ok " if good else "BAD", snippet))
        if not good:
            print("      %-24s %5d  expected substring: %s" % ("", no, needle_hint := edge["srcs"][0][2]))
    if not ok:
        bad_edges.append(edge["id"])

print("-" * 108)
print("edges not drawn (negative evidence, still pinned to a line)")
for neg in NEGATIVES:
    ok, rows = check_edge(neg)
    print("%-3s %-52s %s" % (neg["id"], neg["what"], "OK" if ok else "FAIL"))
    for rel, no, text, good in rows:
        snippet = text if len(text) <= 96 else text[:93] + "..."
        print("      %-24s %5d  %s  %s" % ("%s:%d" % (rel, no), no,
                                           "ok " if good else "BAD", snippet))
    if not ok:
        bad_edges.append(neg["id"])

print("-" * 108)
print("legend claims pinned to a source line")
for claim in CLAIMS:
    ok, rows = check_edge(claim)
    print("%-3s %-70s %s" % (claim["id"], claim["what"], "OK" if ok else "FAIL"))
    for rel, no, text, good in rows:
        snippet = text if len(text) <= 96 else text[:93] + "..."
        print("      %-24s %5d  %s  %s" % ("%s:%d" % (rel, no), no,
                                           "ok " if good else "BAD", snippet))
    if not ok:
        bad_edges.append(claim["id"])

print("-" * 108)
if bad_edges:
    print("CHECK=FAIL  edges without a verified source line: %s" % ", ".join(bad_edges))
else:
    print("CHECK=PASS  %d/%d drawn edges + %d negatives + %d claims all resolve to a source line"
          % (len(EDGES), len(EDGES), len(NEGATIVES), len(CLAIMS)))

# ======================================================================
# 版面自查：越界 / 文字互压 / 箭头穿字 / 箭头穿框
# ======================================================================
fig.canvas.draw()
renderer = fig.canvas.get_renderer()
extents = []
for label, art, owner in TEXTS:
    bb = art.get_window_extent(renderer)
    extents.append((label, bb.x0, bb.y0, bb.x1, bb.y1, owner))

issues = 0
for label, x0, y0, x1, y1, owner in extents:
    if x0 < 0 or y0 < 0 or x1 > W or y1 > H:
        issues += 1
        print("OUT-OF-CANVAS  %-30s (%.0f,%.0f)-(%.0f,%.0f)" % (label, x0, y0, x1, y1))

for label, x0, y0, x1, y1, owner in extents:
    if not owner or owner not in RECTS or RECTS[owner] is None:
        continue
    rx0, ry0, rx1, ry1 = RECTS[owner]
    if x0 < rx0 + 2 or x1 > rx1 - 2 or y0 < ry0 + 2 or y1 > ry1 - 2:
        issues += 1
        print("OVERFLOW-BOX   %-30s text=%.0f..%.0f/%.0f..%.0f box=%.0f..%.0f/%.0f..%.0f"
              % (label, x0, x1, y0, y1, rx0, rx1, ry0, ry1))

for i in range(len(extents)):
    for j in range(i + 1, len(extents)):
        a, b = extents[i], extents[j]
        if a[5] and a[5] == b[5]:
            continue
        ox = min(a[3], b[3]) - max(a[1], b[1])
        oy = min(a[4], b[4]) - max(a[2], b[2])
        if ox > 2 and oy > 2:
            issues += 1
            print("TEXT-OVERLAP   %-30s <> %-30s (%.0fx%.0f)" % (a[0], b[0], ox, oy))

if os.environ.get("SM_DEBUG"):
    for e in sorted(extents, key=lambda r: -r[4]):
        print("BB %-44s x %.0f..%.0f  y %.0f..%.0f" % (e[0], e[1], e[3], e[2], e[4]))

pts = []
for (a0, b0) in SEGS:
    for f in np.linspace(0.004, 0.996, 240):
        pts.append((a0[0] + (b0[0] - a0[0]) * f, a0[1] + (b0[1] - a0[1]) * f))
for label, x0, y0, x1, y1, owner in extents:
    hit = sum(1 for (px, py) in pts if x0 + 1 < px < x1 - 1 and y0 + 1 < py < y1 - 1)
    if hit >= 3:
        issues += 1
        print("ARROW-ON-TEXT  %-30s hits=%d" % (label, hit))

for name, rect in RECTS.items():
    if rect is None:
        continue
    rx0, ry0, rx1, ry1 = rect
    for idx, (a0, b0) in enumerate(SEGS):
        for f in np.linspace(0.12, 0.88, 30):
            px = a0[0] + (b0[0] - a0[0]) * f
            py = a0[1] + (b0[1] - a0[1]) * f
            if rx0 + 2 < px < rx1 - 2 and ry0 + 2 < py < ry1 - 2:
                issues += 1
                print("SEG-IN-BOX     seg#%d crosses box %s at (%.0f,%.0f)" % (idx, name, px, py))
                break

print("layout check: texts=%d segs=%d boxes=%d issues=%d"
      % (len(extents), len(SEGS), sum(1 for r in RECTS.values() if r), issues))

# ======================================================================
# 输出
# ======================================================================
out = "%s/ticket-state-machine.%s.png" % (HERE, LANG)
fig.savefig(out, dpi=DPI, facecolor="white")
import os
print("wrote %s  (%d x %d px, %d bytes)" % (out, W, H, os.path.getsize(out)))
