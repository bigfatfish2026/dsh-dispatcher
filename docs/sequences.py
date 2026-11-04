#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""dsh-dispatcher 2.0 的两张时序图（中英双版）。

图一「一次派活」：router 调 dispatch_open → 票台校验、选档、建票、spawn → 回执。
图二「一张票的生命周期」：报告 → 读报告 → 干完落 waiting → 再派活 → blocked / 解封
→ 每 10 秒巡检把四类事实写进动态上下文（只有 blocked 过阈值才发一条 [sweep] 提醒）→ 收工。

图上每一条线都对着 src/index.ts + src/store/reducer.ts 的实际行为，不引用没进仓的设计稿。
两个版本共用同一套布局，只切文案（LANG 里的 zh / en 两张表）。

用法：
  python3 docs/sequences.py            # 中英四张全出
  python3 docs/sequences.py zh         # 只出中文两张
  python3 docs/sequences.py en         # 只出英文两张

产出（与脚本同目录）：
  dispatcher-seq-open.zh.png / dispatcher-seq-open.en.png
  dispatcher-seq-lifecycle.zh.png / dispatcher-seq-lifecycle.en.png

依赖：matplotlib + 任一中文字体（Noto Sans CJK / 文泉驿）。

脚本自带两道自检：
  1. 禁用工具名自检——2.0 删掉的那三个玩具名（touch / sweep / poll）不许出现在图上，
     名字在代码里拼出来，免得自检自己命中自己；
  2. 文字越框自检——finalize() 里按实际渲染宽度回缩字号，缩到 6.4pt 以下记一条 warning 并退非零。
"""

import os
import sys
import unicodedata

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager
from matplotlib.patches import Circle, FancyArrowPatch, FancyBboxPatch

HERE = os.path.dirname(os.path.abspath(__file__))

FONT_CANDIDATES = ("Noto Sans CJK SC", "Noto Sans CJK JP", "WenQuanYi Zen Hei", "Source Han Sans SC")


def pick_font():
    for cand in FONT_CANDIDATES:
        try:
            font_manager.findfont(font_manager.FontProperties(family=cand), fallback_to_default=False)
        except Exception:
            continue
        return cand
    raise SystemExit("[font] 没有中文字体，先装 fonts-noto-cjk")


FONT = pick_font()
plt.rcParams["font.family"] = [FONT, "DejaVu Sans"]
plt.rcParams["axes.unicode_minus"] = False

INK = "#16232e"
MUTED = "#5b6b7a"
BG = "#f6f8fa"
PANEL = "#ffffff"
BLUE = "#2563eb"
BLUE_FC = "#e8f0fe"
TEAL = "#0f766e"
TEAL_FC = "#e6f4f1"
RED = "#dc2626"
RED_FC = "#fdeaea"
AMBER = "#b45309"
AMBER_FC = "#fff4e0"
GREEN = "#15803d"
GREEN_FC = "#e8f5ec"
GREY = "#6b7280"
GREY_FC = "#eef1f4"
VIOLET = "#6d5bd0"
VIOLET_FC = "#f3f0ff"

WARNINGS = []
FIT = []


# ---------------------------------------------------------------- 画布与元件
def est_width(text, fs):
    total = 0.0
    for ch in text:
        wide = unicodedata.east_asian_width(ch) in ("W", "F")
        total += (fs / 0.72) * (1.0 if wide else 0.55)
    return total


def fit_fs(lines, max_w, fs, min_fs=7.4, what=""):
    need = max(est_width(s, fs) for s in lines)
    if need <= max_w:
        return fs
    shrunk = fs * max_w / need
    if shrunk < min_fs:
        WARNINGS.append(f"越框：{what or lines[0][:24]}（需 {need:.0f}，可用 {max_w:.0f}）")
        return min_fs
    return shrunk


def canvas(w, h, figsize):
    fig, ax = plt.subplots(figsize=figsize, dpi=100)
    fig.patch.set_facecolor(BG)
    ax.set_facecolor(BG)
    ax.set_xlim(0, w)
    ax.set_ylim(0, h)
    ax.set_aspect("equal")
    ax.axis("off")
    ax.set_position([0, 0, 1, 1])
    return fig, ax


def box(ax, x, y, w, h, fc, ec, lw=1.6, ls="-", r=9, z=2):
    patch = FancyBboxPatch(
        (x, y), w, h,
        boxstyle=f"round,pad=0,rounding_size={r}",
        facecolor=fc, edgecolor=ec, linewidth=lw, linestyle=ls, zorder=z,
    )
    ax.add_patch(patch)
    return patch


def txt(ax, x, y, s, fs=10, color=INK, ha="left", va="top", weight="normal", z=6, ls=1.34, max_w=None):
    artist = ax.text(x, y, s, fontsize=fs, color=color, ha=ha, va=va, weight=weight,
                     zorder=z, linespacing=ls)
    if max_w:
        FIT.append((artist, max_w))
    return artist


def finalize(fig):
    fig.canvas.draw()
    renderer = fig.canvas.get_renderer()
    for artist, max_w in FIT:
        for _ in range(4):
            drawn = artist.get_window_extent(renderer).width
            if drawn <= max_w:
                break
            fs = artist.get_fontsize() * (max_w / drawn) * 0.98
            if fs < 6.4:
                WARNINGS.append(f"越框：{artist.get_text().splitlines()[0][:26]}（需 {drawn:.0f}，可用 {max_w:.0f}）")
                fs = 6.4
                artist.set_fontsize(fs)
                break
            artist.set_fontsize(fs)
    fig.canvas.draw()
    FIT.clear()


def arrow(ax, p1, p2, color=GREY, lw=1.6, ls="-", style="-|>", rad=0.0, ms=12, z=3, halo=False):
    if halo:
        ax.plot([p1[0], p2[0]], [p1[1], p2[1]], color=BG, lw=lw + 5, zorder=z - 1,
                solid_capstyle="round", alpha=0.95)
    patch = FancyArrowPatch(
        p1, p2, arrowstyle=style, color=color, linewidth=lw, linestyle=ls,
        mutation_scale=ms, zorder=z, connectionstyle=f"arc3,rad={rad}",
        shrinkA=0, shrinkB=0,
    )
    ax.add_patch(patch)
    return patch


def path(ax, pts, color=GREY, lw=1.6, ls="-", z=3, halo=False):
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    if halo:
        ax.plot(xs, ys, color=BG, linewidth=lw + 5, linestyle=ls, zorder=z - 1,
                solid_capstyle="round", solid_joinstyle="round", alpha=0.95)
    ax.plot(xs, ys, color=color, linewidth=lw, linestyle=ls, zorder=z,
            solid_capstyle="round", solid_joinstyle="round")


def label(ax, x, y, s, fs=9.4, color=INK, bg="white", ha="center", va="center", z=7, ls=1.3, max_w=None):
    if max_w:
        fs = fit_fs(s.split("\n"), max_w, fs, min_fs=7.6, what=s[:20])
    ax.text(x, y, s, fontsize=fs, color=color, ha=ha, va=va, zorder=z, linespacing=ls,
            bbox=dict(boxstyle="round,pad=0.32", facecolor=bg, edgecolor="none", alpha=0.97))


def numtag(ax, x, y, n, color, fs=8.6):
    ax.add_patch(Circle((x, y), 11, facecolor="white", edgecolor=color, lw=1.5, zorder=8))
    ax.text(x, y - 3.6, str(n), fontsize=fs, color=color, ha="center", zorder=9)


# ---------------------------------------------------------------- 泳道与消息
def _lane(ax, x, w, name, sub, fc, ec, y_top, y_bot):
    box(ax, x - w / 2, y_top - 66, w, 66, fc, ec, lw=1.7, r=9, z=3)
    ax.plot([x, x], [y_top - 66, y_bot], color="#b3bfca", lw=1.1, ls=(0, (3, 4)), zorder=1)
    txt(ax, x, y_top - 26, name, fs=10.6, weight="bold", color=ec, ha="center", va="center", z=6)
    txt(ax, x, y_top - 50, sub, fs=7.7, color="#33424f", ha="center", va="center", z=6, max_w=w - 12)


def _msg(ax, n, x1, x2, y, l1, l2, kind="sync"):
    if kind == "sync":
        ls, color = "-", INK
    elif kind == "fail":
        ls, color = (0, (5, 3)), RED
    else:
        ls, color = (0, (6, 3)), MUTED
    d = 1 if x2 > x1 else -1
    arrow(ax, (x1, y), (x2, y), color=color, lw=1.8 if kind == "sync" else 1.6,
          ls=ls, ms=13, halo=True)
    numtag(ax, x1 + d * 17, y, n, color)
    mid = (x1 + x2) / 2
    mw = min(abs(x2 - x1) - 46, 470)
    label(ax, mid, y + 30, l1, fs=8.6, color=color if kind != "sync" else INK, max_w=mw)
    label(ax, mid, y - 15, l2, fs=7.6, color=MUTED, max_w=mw, bg="#fbfcfd")


def _legend(ax, x, y, w, items, note, head):
    box(ax, x, y, w, 2, PANEL, PANEL, lw=0, r=0)  # spacer no-op
    box(ax, x, y, w, 196, PANEL, "#d5dde4", lw=1.3, r=10, z=1)
    txt(ax, x + 20, y + 176, head, fs=10.6, weight="bold")
    cx = x + 20
    for color, ls, text in items:
        ax.plot([cx, cx + 52], [y + 148, y + 148], color=color, lw=2.2, ls=ls, zorder=6,
                solid_capstyle="round")
        txt(ax, cx + 60, y + 158, text, fs=8.4, color="#33424f", max_w=300)
        cx += 350
    txt(ax, x + 20, y + 118, note, fs=8.6, color=MUTED, ls=1.4, max_w=w - 40)


# ---------------------------------------------------------------- 文案（zh / en）
LANG = {
    "zh": {
        "open_title": "dsh-dispatcher 2.0 一次派活：router 只递一句话，选档、建票、spawn 全在票台里",
        "open_sub": "从左到右是一条调用链：M 只调一个工具，票台负责校验、选档、记账，日志只追加；下面 15 步是这条链上的实际顺序",
        "open_lanes": [
            ("router agent", "主会话 M", BLUE_FC, BLUE),
            ("dispatch_open", "工具壳（唯一入口）", VIOLET_FC, VIOLET),
            ("TicketDesk", "票台：校验 / 选档 / 记账", TEAL_FC, TEAL),
            ("PresetCatalog", "presets.yaml 注册表", GREY_FC, "#4b5563"),
            ("选档 LLM", "deepseek-flash · effort=off", AMBER_FC, AMBER),
            ("subagent seam", "startActivation", TEAL_FC, TEAL),
            ("worker agent", "小鱼（可能是另一台机器）", GREEN_FC, GREEN),
            ("票据日志", "tickets.jsonl 只追加", GREY_FC, "#4b5563"),
        ],
        "open_rows": [
            (1, "R", "T", "sync", "dispatch_open(goal, brief, dir?)", "同步 · 参数里没有 preset"),
            (2, "T", "D", "sync", "desk.ticket(intent, actor)", "同步 · 工具只是壳"),
            (3, "D", "C", "sync", "读 config.defaultPreset", "同步 · 由 profile 给，代码没硬编码"),
            (4, "D", "L", "sync", "分类：goal / brief / dir + 六档 description", "同步 · effort=off、超时 8000ms"),
            (5, "L", "D", "sync", "档名 + 一句理由", "同步 · 正常 0.9–1.2 秒"),
            (6, "D", "C", "sync", "resolve(档名)", "同步 · 必须 ∈ config.presets"),
            (7, "D", "LG", "async", "commit(published, open, preset, presetSource)", "异步落盘 + 广播 ticket"),
            (8, "D", "S", "sync", "startActivation(prompt 含票号, agentPreset, cwd, parent=M)", "同步 · signal 是 desk 自持的 AC"),
            (9, "S", "D", "sync", "childId + messageId", "同步 · 首条 prompt 已进 inbox，原子"),
            (10, "D", "LG", "async", "commit(spawned, running, workerId)", "异步"),
            (11, "D", "R", "sync", "回执：票号 + status + openCount", "同步 · 没有 workerId"),
            (12, "S", "W", "async", "worker 开始跑（首条 prompt）", "异步 · 不阻塞回执"),
            (13, "L", "D", "fail", "超时 / 报错 / 返回空 / 名单外的档", "回落 config.defaultPreset，presetSource='fallback'，照走"),
            (14, "C", "D", "fail", "resolve 失败：档名不在 config.presets", "不报错，同样回落默认档，建票继续"),
            (15, "S", "D", "fail", "reject（容量 / 深度 / 取消）", "commit(spawn-failed)，票停在 open，工具把原文抛给模型"),
        ],
        "open_notes": [
            "票是先落盘、再 spawn：7 的 published(open) 一定早于 8 的 startActivation，所以不存在「spawn 了但票里没它」的窗口。",
            "选档失败只是一次降级——4/5 挂了照样往 7 走；只有 8 的 seam reject 才让票停在 open（可重试、可关，不删票）。",
            "参数里没有 preset：router 想指定也只是建议，判定结果和来源（llm / static / fallback）写进票里，router 从 dispatch_list 看得到。",
        ],
        "open_boundary": "router 只看 ticket，worker 对它透明：回执里没有 workerId",
        "life_title": "dsh-dispatcher 2.0 一张票的完整生命周期：票号从头到尾不变，只有 dispatch_close 能收工",
        "life_sub": "同一张票 t-xxxx 上先后发生的所有事：交活 → 读报告 → 再派活 → 卡住/解封 → 巡检提醒 → 收工；22 步，最后一步是收工后再派活被拒",
        "life_lanes": [
            ("router agent", "主会话 M", BLUE_FC, BLUE),
            ("dispatch_* 工具", "send / read / block / close / list", VIOLET_FC, VIOLET),
            ("TicketDesk", "唯一中介", TEAL_FC, TEAL),
            ("subagent seam", "startActivation / sendMessage", TEAL_FC, TEAL),
            ("worker agent", "小鱼", GREEN_FC, GREEN),
            ("票据日志", "tickets.jsonl", GREY_FC, "#4b5563"),
            ("巡检事实 / [sweep] 兜底", "四类事实进上下文 · 只 blocked 发提醒", RED_FC, RED),
        ],
        "life_rows": [
            (1, "W", "T", "sync", "dispatch_report(id, 正文)", "同步 · worker 唯一写入口"),
            (2, "T", "D", "sync", "append(reported)", "同步 · 不碰 status、不推送、不叫醒人"),
            (3, "D", "N", "async", "报告到了 → 记一条巡检事实", "异步 · 只进投影，没有推送这条路"),
            (4, "N", "R", "async", "下一轮巡检：动态上下文里带上「这票有报告」", "异步 · 不打断、不唤醒"),
            (5, "R", "T", "sync", "dispatch_read(id)", "同步"),
            (6, "T", "D", "sync", "读投影 + 标记已读（quietly）", "同步 · 不改 status、不广播"),
            (7, "D", "R", "sync", "tickets[] + returned / markedRead", "同步"),
            (8, "W", "S", "async", "这一轮干完 / 人没了", "异步 · idle 或 end / disposed"),
            (9, "S", "D", "async", "① idled  ② ended / disposed", "异步 · ① → workerAlive=true  ② → false"),
            (10, "D", "LG", "async", "commit(idled | ended) → waiting", "异步 · 三条路都进 waiting，都不终止票"),
            (11, "R", "T", "sync", "dispatch_send(id, text)", "同步"),
            (12, "T", "D", "sync", "投递（活 agent 直接投，死了冷启动）", "同步 · 走 ctx.subagents.sendMessage"),
            (13, "D", "LG", "async", "commit(resumed, epoch+1) + delivered → running", "异步 · 票号不变、epochReports 归零"),
            (14, "R", "T", "sync", "dispatch_block(id, reason)", "同步 · reason 非空"),
            (15, "D", "LG", "async", "commit(blocked)", "异步 · workerAlive 原样保留"),
            (16, "R", "T", "sync", "dispatch_send(id, text)：解封", "同步"),
            (17, "D", "LG", "async", "投递成功 → commit(resumed) → running", "异步 · 投不进去就留在 blocked"),
            (18, "D", "N", "async", "每 10 秒巡一遍：四类事实", "异步 · 报告到了 / 干完没交报告 / waiting / running，只读不改票"),
            (19, "N", "R", "async", "只有 blocked 超过阈值才发一条带 [sweep] 的提醒", "异步 · 其余事实只进动态上下文，不打扰人"),
            (20, "R", "T", "sync", "dispatch_close(id, 'done')", "同步 · 唯一终态入口"),
            (21, "D", "LG", "async", "commit(closed(done))，作废未投递消息", "异步 · 活着的 child 一并 dispose"),
            (22, "R", "T", "fail", "done 票上再 dispatch_send", "拒绝、一行不写，回「票已收工，需要继续请开新票」"),
        ],
        "life_notes": [
            "整张图都是同一张票 t-xxxx：进 waiting 不前、进 blocked 不再开票、解封回 running 也不换号——只有 dispatch_close 能把它写成 done / dropped。",
            "waiting 是静息态不是终态：workerAlive=true 表示叫得醒，=false 表示人已经结束（send 走冷启动），但票还是同一张。",
            "巡检（18-19）和 dispatch_report（1-2）都不改 status：每 10 秒只把四类事实读出来写进动态上下文，只有 blocked 过阈值才发一条 [sweep] 提醒。",
            "22 号是唯一被拒的动作：done / dropped 上 dispatch_send 一律拒绝、一行不写；「重开」这条边在 2.0 里不存在。",
            "票状态一路走过：open → running → waiting → running → blocked → running → done；没有重开，因为收工就是收工。",
        ],
        "legend_head": "怎么读这张图",
        "legend_items": [
            (INK, "-", "实线：同步，调用方等结果"),
            (MUTED, (0, (6, 3)), "虚线：异步 / 回调，不等"),
            (RED, (0, (5, 3)), "红虚线：被拒绝 / 失败的分支"),
        ],
    },
    "en": {
        "open_title": "dsh-dispatcher 2.0 · one dispatch: the router sends a sentence, the desk picks the preset, opens the ticket and spawns",
        "open_sub": "Left to right is one call chain: M calls a single tool, the desk validates, picks the preset and records; the log is append-only. The 15 steps below are the real order",
        "open_lanes": [
            ("router agent", "main session M", BLUE_FC, BLUE),
            ("dispatch_open", "tool shell (only entry)", VIOLET_FC, VIOLET),
            ("TicketDesk", "validate / pick preset / record", TEAL_FC, TEAL),
            ("PresetCatalog", "presets.yaml registry", GREY_FC, "#4b5563"),
            ("preset LLM", "deepseek-flash · effort=off", AMBER_FC, AMBER),
            ("subagent seam", "startActivation", TEAL_FC, TEAL),
            ("worker agent", "a subagent, maybe on another host", GREEN_FC, GREEN),
            ("ticket log", "tickets.jsonl, append-only", GREY_FC, "#4b5563"),
        ],
        "open_rows": [
            (1, "R", "T", "sync", "dispatch_open(goal, brief, dir?)", "sync · no preset in the args"),
            (2, "T", "D", "sync", "desk.ticket(intent, actor)", "sync · the tool is only a shell"),
            (3, "D", "C", "sync", "read config.defaultPreset", "sync · set by the profile, not hardcoded"),
            (4, "D", "L", "sync", "classify: goal / brief / dir + six preset descriptions", "sync · effort=off, 8000 ms budget"),
            (5, "L", "D", "sync", "preset name + one-line reason", "sync · usually 0.9–1.2 s"),
            (6, "D", "C", "sync", "resolve(preset)", "sync · must exist in config.presets"),
            (7, "D", "LG", "async", "commit(published, open, preset, presetSource)", "async · write to log + ticket event"),
            (8, "D", "S", "sync", "startActivation(prompt with ticket id, agentPreset, cwd, parent=M)", "sync · the signal is the desk's own AC"),
            (9, "S", "D", "sync", "childId + messageId", "sync · first prompt already in the inbox"),
            (10, "D", "LG", "async", "commit(spawned, running, workerId)", "async"),
            (11, "D", "R", "sync", "reply: ticket id + status + openCount", "sync · no workerId"),
            (12, "S", "W", "async", "the worker starts (first prompt)", "async · does not block the reply"),
            (13, "L", "D", "fail", "timeout / error / empty / unknown preset", "fall back to config.defaultPreset, presetSource='fallback'"),
            (14, "C", "D", "fail", "resolve fails: preset not in config.presets", "no error — same fallback, the ticket still opens"),
            (15, "S", "D", "fail", "reject (capacity / depth / cancelled)", "commit(spawn-failed), ticket stays open, the error text goes to the model"),
        ],
        "open_notes": [
            "The ticket is written before the spawn: step 7's published(open) always precedes step 8's startActivation, so there is no window with a worker but no ticket.",
            "A preset failure is only a downgrade — steps 4/5 can fail and step 7 still runs; only a seam reject at step 8 leaves the ticket in open (retryable, closable, never deleted).",
            "No preset argument: the router may suggest one, but the decision and its source (llm / static / fallback) are stored on the ticket and visible via dispatch_list.",
        ],
        "open_boundary": "the router only sees the ticket; the worker is invisible to it — the reply has no workerId",
        "life_title": "dsh-dispatcher 2.0 · one ticket's whole life: the id never changes, and only dispatch_close can close it",
        "life_sub": "Everything that happens to the same ticket t-xxxx: hand off → read reports → hand off again → block / unblock → sweep reminders → close. 22 steps, the last one rejected",
        "life_lanes": [
            ("router agent", "main session M", BLUE_FC, BLUE),
            ("dispatch_* tools", "send / read / block / close / list", VIOLET_FC, VIOLET),
            ("TicketDesk", "the only middleman", TEAL_FC, TEAL),
            ("subagent seam", "startActivation / sendMessage", TEAL_FC, TEAL),
            ("worker agent", "the worker", GREEN_FC, GREEN),
            ("ticket log", "tickets.jsonl", GREY_FC, "#4b5563"),
            ("sweep facts / [sweep] ping", "facts → context · ping only for blocked", RED_FC, RED),
        ],
        "life_rows": [
            (1, "W", "T", "sync", "dispatch_report(id, text)", "sync · the worker's only write"),
            (2, "T", "D", "sync", "append(reported)", "sync · no status change, no push, no wake-up"),
            (3, "D", "N", "async", "report arrived → one sweep fact", "async · projection only, there is no push path"),
            (4, "N", "R", "async", "next sweep: “this ticket has a report” in the dynamic context", "async · no interruption, no wake-up"),
            (5, "R", "T", "sync", "dispatch_read(id)", "sync"),
            (6, "T", "D", "sync", "read projection + mark read (quietly)", "sync · no status change, no broadcast"),
            (7, "D", "R", "sync", "tickets[] + returned / markedRead", "sync"),
            (8, "W", "S", "async", "turn finished / worker gone", "async · idle, or end / disposed"),
            (9, "S", "D", "async", "① idled   ② ended / disposed", "async · ① → workerAlive=true   ② → false"),
            (10, "D", "LG", "async", "commit(idled | ended) → waiting", "async · all three paths end in waiting, none ends the ticket"),
            (11, "R", "T", "sync", "dispatch_send(id, text)", "sync"),
            (12, "T", "D", "sync", "deliver (live agent) or cold-start (dead one)", "sync · via ctx.subagents.sendMessage"),
            (13, "D", "LG", "async", "commit(resumed, epoch+1) + delivered → running", "async · same id, epochReports reset"),
            (14, "R", "T", "sync", "dispatch_block(id, reason)", "sync · reason required"),
            (15, "D", "LG", "async", "commit(blocked)", "async · workerAlive untouched"),
            (16, "R", "T", "sync", "dispatch_send(id, text) → unblock", "sync"),
            (17, "D", "LG", "async", "delivered → commit(resumed) → running", "async · stays blocked if delivery fails"),
            (18, "D", "N", "async", "sweep every 10 s: four kinds of facts", "async · new report / no report yet / waiting / running — reads only"),
            (19, "N", "R", "async", "only when blocked is past its threshold: one ping tagged [sweep]", "async · every other fact just lands in the dynamic context"),
            (20, "R", "T", "sync", "dispatch_close(id, 'done')", "sync · the only way into a final state"),
            (21, "D", "LG", "async", "commit(closed(done)), pending messages dropped", "async · a live child is disposed too"),
            (22, "R", "T", "fail", "dispatch_send on a done ticket", "refused, nothing written: open a new one"),
        ],
        "life_notes": [
            "Every lane is the same ticket t-xxxx: waiting does not move it forward, blocked does not open a second one, unblocking returns to running without a new id — only dispatch_close writes done / dropped.",
            "waiting is a rest state, not a final one: workerAlive=true means it can be woken, =false means the worker ended (send cold-starts it), but it is still the same ticket.",
            "Neither the sweep (18-19) nor dispatch_report (1-2) changes status: every 10 s the sweep only reads four facts into the dynamic context, and only blocked past its threshold sends a [sweep] ping.",
            "22 is the only refused call: on done / dropped, dispatch_send always refuses and writes nothing; there is no reopen edge in 2.0.",
            "Statuses on the way: open → running → waiting → running → blocked → running → done. No reopen, because closed is closed.",
        ],
        "legend_head": "How to read this",
        "legend_items": [
            (INK, "-", "solid: synchronous, the caller waits"),
            (MUTED, (0, (6, 3)), "dashed: async / callback, no wait"),
            (RED, (0, (5, 3)), "red dashed: refused / failed branch"),
        ],
    },
}


# ---------------------------------------------------------------- 图一：一次派活
def draw_seq_open(lang):
    t = LANG[lang]
    W, H = 2600, 1900
    fig, ax = canvas(W, H, (26, 19.0))

    txt(ax, 48, H - 36, t["open_title"], fs=19, weight="bold")
    txt(ax, 48, H - 66, t["open_sub"], fs=10.0, color=MUTED)

    lanes = t["open_lanes"]
    n = len(lanes)
    bw = 190
    pitch = (W - 120 - bw) / (n - 1)
    xs = [60 + bw / 2 + i * pitch for i in range(n)]
    for (name, sub, fc, ec), x in zip(lanes, xs):
        _lane(ax, x, bw, name, sub, fc, ec, 1808, 300)

    pos = dict(zip(("R", "T", "D", "C", "L", "S", "W", "LG"), xs))

    # router / 票台之间的边界
    bx = xs[0] + 92
    path(ax, [(bx, 1740), (bx, 420)], color="#9aa7b3", lw=1.5, ls=(0, (6, 4)))
    txt(ax, bx + 12, 404, t["open_boundary"], fs=8.4, color=MUTED, max_w=900)

    y = 1700
    for num, a, b, kind, l1, l2 in t["open_rows"]:
        if num == 13:
            y -= 30
        _msg(ax, num, pos[a], pos[b], y, l1, l2, kind)
        y -= 86

    _legend(ax, 40, 60, W - 80, t["legend_items"], "\n".join(t["open_notes"]), t["legend_head"])

    finalize(fig)
    out = os.path.join(HERE, f"dispatcher-seq-open.{lang}.png")
    fig.savefig(out, dpi=100, facecolor=BG)
    plt.close(fig)
    print(f"[seq-open:{lang}] wrote {out}")


# ---------------------------------------------------------------- 图二：一张票的生命周期
def draw_seq_life(lang):
    t = LANG[lang]
    W, H = 2600, 2320
    fig, ax = canvas(W, H, (26, 23.2))

    txt(ax, 48, H - 36, t["life_title"], fs=19, weight="bold")
    txt(ax, 48, H - 66, t["life_sub"], fs=10.0, color=MUTED)

    lanes = t["life_lanes"]
    n = len(lanes)
    bw = 200
    pitch = (W - 120 - bw) / (n - 1)
    xs = [60 + bw / 2 + i * pitch for i in range(n)]
    for (name, sub, fc, ec), x in zip(lanes, xs):
        _lane(ax, x, bw, name, sub, fc, ec, 2228, 320)

    pos = dict(zip(("R", "T", "D", "S", "W", "LG", "N"), xs))

    y = 2110
    for num, a, b, kind, l1, l2 in t["life_rows"]:
        if num == 18:
            y -= 30
        _msg(ax, num, pos[a], pos[b], y, l1, l2, kind)
        y -= 82

    _legend(ax, 40, 60, W - 80, t["legend_items"], "\n".join(t["life_notes"]), t["legend_head"])

    finalize(fig)
    out = os.path.join(HERE, f"dispatcher-seq-lifecycle.{lang}.png")
    fig.savefig(out, dpi=100, facecolor=BG)
    plt.close(fig)
    print(f"[seq-life:{lang}] wrote {out}")


# ---------------------------------------------------------------- 自检
def check_no_removed_tools():
    """图里不许再出现 2.0 已经删掉的工具名。名字拆开拼，免得自己命中自己。"""
    gone = ["dispatch_" + "touch", "dispatch_" + "sweep", "dispatch_" + "poll"]
    drawn = []

    def walk(node):
        if isinstance(node, str):
            drawn.append(node)
        elif isinstance(node, (list, tuple)):
            for item in node:
                walk(item)
        elif isinstance(node, dict):
            for item in node.values():
                walk(item)

    walk(LANG)
    blob = "\n".join(drawn)
    bad = 0
    for g in gone:
        hit = g in blob
        print(f"CHECK={'FAIL' if hit else 'ok  '} 图里不出现 {g}")
        bad += 1 if hit else 0
    return bad



def main():
    which = sys.argv[1] if len(sys.argv) > 1 else "all"
    if which not in ("zh", "en", "all"):
        print("用法：python3 docs/sequences.py [zh|en|all]")
        return 2
    bad = check_no_removed_tools()
    for lang in (["zh", "en"] if which == "all" else [which]):
        draw_seq_open(lang)
        draw_seq_life(lang)
    for w in WARNINGS:
        print(f"[warn] {w}")
        bad += 1
    print(f"CHECK={'PASS' if bad == 0 else 'FAIL'} (warnings={len(WARNINGS)})")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(main())
