#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""worker / ticket 生命周期图 —— 中英双语，同一套布局，只切文案表。

用法：
    python3 worker-ticket-lifecycle-i18n.py zh   -> worker-ticket-lifecycle.zh.png
    python3 worker-ticket-lifecycle-i18n.py en   -> worker-ticket-lifecycle.en.png

v3（2026-11-02）相对 v2 的改动：
  - 全图不再出现美元符号，指纹改纯文本（修复 mathtext 把它当公式起始的转义残渣）。
  - 右侧「巡检层」改名「巡检」，内部流程改为自上而下：
    取票 -> 菱形判定 -> worker-gone / silent -> 节流 -> 推送摘要。
  - 删除「工具可见性」框、「原『卡住提醒』已并入本层」标签、底注里与票生命周期
    无关的段落。
"""
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch, Polygon

LANG = (sys.argv[1] if len(sys.argv) > 1 else "zh").strip().lower()
if LANG not in ("zh", "en"):
    raise SystemExit("usage: worker-ticket-lifecycle-i18n.py [zh|en]")

if LANG == "zh":
    plt.rcParams["font.sans-serif"] = ["Noto Sans CJK SC", "DejaVu Sans"]
else:
    plt.rcParams["font.sans-serif"] = ["DejaVu Sans"]
plt.rcParams["font.family"] = "sans-serif"
plt.rcParams["axes.unicode_minus"] = False

# ======================================================================
# 文案表
# ======================================================================
TEXTS = {
    "zh": {
        "title": "Worker / Ticket 生命周期",
        "subtitle": "M = 主会话（一个 session）· W = 小鱼 / subagent（独立 session）· "
                    "T = 票（~/.dsh/dispatcher/tickets.jsonl）",
        "lane_m": "M · 主 agent", "lane_m_sub": "主会话，一个人一个 session",
        "lane_w": "W · worker / 小鱼", "lane_w_sub": "subagent 起的独立 session，可能先死",
        "lane_t": "T · ticket 票", "lane_t_sub": "id / goal / owner / status",

        "m1": "dispatch_open(goal)",
        "m2": "subagent(...)\n起一个 W 会话",
        "m3": "dispatch_touch\n或自己推进",
        "m4": "被 send_message\n唤醒，读票",
        "m5": "dispatch_close",
        "w1": "W 会话创建\norigin=subagent",
        "w2": "干活：读文件 / 跑命令",
        "w3": "dispatch_report\n往票里写进展",
        "w4": "send_message 喊 M",
        "w5": "W 结束（可能比 M 先死）",
        "t1": "status = open\nowner = W",
        "t2": "status = running",
        "t3": "票里 + 一条 report",
        "t4": "status = done / dropped",
        "t5": "归档 archived",

        "a1": "① 建票", "a2": "② 起 W", "a3": "③ 推 running",
        "a4": "④ 写报告", "a5": "⑤ 唤醒 M", "a6": "⑥ close = 收尾",
        "wait_w": "等 W 交付",
        "crash_w": "W 崩 /\n被 interrupt",
        "forgot_close": "W 结束，M 忘了 close",
        "m_replaced": "M 会话被换掉\n/new · host restart",
        "any_time": "任何时候",

        "card_cd": "C / D · 孤儿票\nW 的报告没人收\n票不会自己变状态",
        "card_ab": "A / B · 僵尸票\nT 停在 running，没人认领",
        "gate": "sweep 复活闸门\n仅 done 后又有新 input",

        "authority_title": "判定权",
        "authority_body": "票的终点只看两件事：\nW 交付完成，\nM 调了 dispatch_close。\n\n"
                          "M 的会话还在不在，\n都不改变票的状态。",
        "legend_normal": "正常主流程",
        "legend_bad": "异常 / 卡死 / 孤儿",
        "legend_terminal": "票的终态",

        "sweep_title": "巡检 · 僵尸票",
        "sweep_sub": "每 5 分钟一轮：只查出来提醒 M，不改票状态",
        "cycle_label": "5min",
        "sweep_pick": "每轮取 status = open / running 的票\n"
                      "waiting / blocked 是人守着，不算",
        "sweep_diamond": "owner 是 uuid 形态的\nagent id 吗？",
        "sweep_yes": "是", "sweep_no": "否",
        "gw_title": "worker-gone",
        "gw_body": "AgentRegistry 能按\nagent id 查存活\n（get / list，\nkey = agent.session.id）\n查不到 ⇒ 僵尸",
        "sl_title": "silent",
        "sl_body": "owner 不是 uuid\n（多是「重启小鱼」这种短标签）\n查不了存活，退化成超时：\n"
                   "20 分钟没动静算疑似，\n新建票 2 分钟宽限",
        "thr_title": "节流：指纹没变就不重推",
        "thr_fp": "报告条数 ｜ 最后活动时间 ｜ 状态",
        "thr_note": "故意不用 updatedAt：投递报告会刷新它，会重复推",
        "push_title": "只在检出僵尸时，给 M 发一条摘要",
        "push_body": "票号 · 多久没动 · 未读报告数 · goal 前 40 字\n"
                     "最多列 3 张，多的只说「另有 N 张」\n"
                     "没检出 → 完全静默，一个字都不发",
        "note1": "注：sweep 定时器在 cordis.patch.yml 里从 sweepMinutes 0 改回 5（每 5 分钟一轮）；"
                 "复活闸门不变——只认 status=done 之后又冒出来的新 input。",
        "note2": "巡检每轮只把「不会自己再动的票」查出来提醒 M，不替 M 收尾；"
                 "W 可能比 M 先死，M 挂了票也不会自己变状态。",
    },
    "en": {
        "title": "Worker / Ticket Lifecycle",
        "subtitle": "M = main session (one conversation) · W = worker / subagent session · "
                    "T = ticket (~/.dsh/dispatcher/tickets.jsonl)",
        "lane_m": "M · main agent", "lane_m_sub": "the main session, one per conversation",
        "lane_w": "W · worker / subagent", "lane_w_sub": "its own session, started by subagent, may die first",
        "lane_t": "T · ticket", "lane_t_sub": "id / goal / owner / status",

        "m1": "dispatch_open(goal)",
        "m2": "subagent(...)\nstarts a W session",
        "m3": "dispatch_touch\nor self-advance",
        "m4": "woken by send_message,\nreads the ticket",
        "m5": "dispatch_close",
        "w1": "W session created\norigin=subagent",
        "w2": "work: read files,\nrun commands",
        "w3": "dispatch_report\nwrites progress to the ticket",
        "w4": "send_message pings M",
        "w5": "W ends (may die before M)",
        "t1": "status = open\nowner = W",
        "t2": "status = running",
        "t3": "ticket gains one report",
        "t4": "status = done / dropped",
        "t5": "archived",

        "a1": "1 open ticket", "a2": "2 spawn W", "a3": "3 set running",
        "a4": "4 write report", "a5": "5 wake M", "a6": "6 close = wrap up",
        "wait_w": "waiting for W",
        "crash_w": "W crashes /\ninterrupted",
        "forgot_close": "W finished,\nM forgot to close",
        "m_replaced": "M session replaced\n/new · host restart",
        "any_time": "at any time",

        "card_cd": "C / D · orphan ticket\nnobody collects W's report\nthe ticket never changes state",
        "card_ab": "A / B · zombie ticket\nstuck in running, no one owns it",
        "gate": "sweep resurrection gate\nonly on new input after done",

        "authority_title": "Who ends a ticket",
        "authority_body": "A ticket ends on two things only:\nW has delivered,\nand M called dispatch_close.\n\n"
                          "Whether M's session is still\nalive does not affect the ticket.",
        "legend_normal": "normal path",
        "legend_bad": "failure / stalled / orphaned",
        "legend_terminal": "terminal state",

        "sweep_title": "Sweep · zombie tickets",
        "sweep_sub": "every 5 min: detect only, never changes ticket state",
        "cycle_label": "5min",
        "sweep_pick": "each round: tickets with status = open / running\n"
                      "waiting / blocked are held by a human, so they are skipped",
        "sweep_diamond": "Is owner a uuid-shaped\nagent id?",
        "sweep_yes": "yes", "sweep_no": "no",
        "gw_title": "worker-gone",
        "gw_body": "AgentRegistry can query\nliveness by agent id\n(get / list,\nkey = agent.session.id)\nno entry = zombie",
        "sl_title": "silent",
        "sl_body": "owner is not a uuid\n(usually a short label\nsuch as \"restart the fish\")\n"
                   "liveness is not queryable,\nso it falls back to a timeout:\n"
                   "20 min idle = suspect,\n2 min grace for a new ticket",
        "thr_title": "Throttle: unchanged fingerprint, no re-push",
        "thr_fp": "report count | last activity | status",
        "thr_note": "updatedAt is deliberately unused: delivering a report\nrefreshes it and would re-push",
        "push_title": "Only on a detected zombie: one summary for M",
        "push_body": "ticket id · time since last activity · unread reports · first 40 chars of goal\n"
                     "at most 3 tickets; the rest collapse into \"N more\"\n"
                     "nothing detected = complete silence",
        "note1": "Note: the sweep timer is set back to 5 minutes (sweepMinutes 0 -> 5) in cordis.patch.yml; "
                 "the resurrection gate is unchanged — only new input after status=done revives a ticket.",
        "note2": "Each sweep round only surfaces tickets that will not move again and reports them to M; "
                 "it never closes them for M. W may die before M, and a dead M does not change ticket state either.",
    },
}
T = TEXTS[LANG]

# 个别文案长度差异大，单独收字号
FS = {"zh": {"gw_body": 9.2, "sl_body": 9.2, "thr_fp": 10.5, "push_body": 9.2,
             "note1": 10.5, "note2": 10.5, "sweep_pick": 10.0,
             "m4": 12.0, "w2": 11.5, "w3": 11.5, "t4": 12.5, "t3": 12.0},
      "en": {"gw_body": 8.8, "sl_body": 8.6, "thr_fp": 10.5, "push_body": 9.0,
             "note1": 10.2, "note2": 10.2, "sweep_pick": 9.8,
             "m4": 10.4, "w2": 11.4, "w3": 10.4, "t4": 11.6, "t3": 11.4,
             "w4": 10.6}}[LANG]


def t(key):
    return T[key]


def fs(key, default):
    return FS.get(key, default)


# ======================================================================
# 画布与配色
# ======================================================================
W, H = 2240, 1160
INK = "#111827"
SUB = "#4b5563"

C_M_BG, C_M_ED = "#e3eefc", "#2563eb"
C_W_BG, C_W_ED = "#dcf6e6", "#16a34a"
C_T_BG, C_T_ED = "#ece9fe", "#7c3aed"
C_OK_BG, C_OK_ED = "#bbf7d0", "#15803d"
C_ARC_BG, C_ARC_ED = "#e5e7eb", "#6b7280"
C_BAD_BG, C_BAD_ED = "#fde2e2", "#dc2626"
C_NOTE_BG, C_NOTE_ED = "#fef9c3", "#f59e0b"
C_SW_BG, C_SW_ED = "#fff7ed", "#ea580c"
C_SW_SUB = "#c2410c"

fig = plt.figure(figsize=(W / 100, H / 100), dpi=100)
ax = fig.add_axes([0, 0, 1, 1])
ax.set_xlim(0, W)
ax.set_ylim(0, H)
ax.axis("off")
ax.set_facecolor("white")

DASH = (0, (6, 4))
DOT = (0, (4, 3))


def box(cx, cy, w, h, text, bg, ed, fs_=12.5, bold=False, ls="-", lw=1.8, tc=INK,
        z=3, alpha=1.0, ls_sp=1.45):
    p = FancyBboxPatch((cx - w / 2, cy - h / 2), w, h,
                       boxstyle="round,pad=0,rounding_size=10",
                       linewidth=lw, edgecolor=ed, facecolor=bg, linestyle=ls,
                       zorder=z, alpha=alpha)
    ax.add_patch(p)
    if text:
        ax.text(cx, cy, text, ha="center", va="center", fontsize=fs_, color=tc,
                fontweight="bold" if bold else "normal", zorder=z + 1,
                linespacing=ls_sp)
    return p


SEGS = []


def arrow(pts, color="#334155", ls="-", lw=1.9, z=4, head=16):
    for k in range(len(pts) - 1):
        SEGS.append((pts[k], pts[k + 1]))
    if len(pts) > 2:
        ax.plot([p[0] for p in pts[:-1]], [p[1] for p in pts[:-1]], color=color,
                linestyle=ls, linewidth=lw, zorder=z, solid_capstyle="round")
    ax.add_patch(FancyArrowPatch(pts[-2], pts[-1], arrowstyle="-|>", mutation_scale=head,
                                 color=color, linestyle=ls, linewidth=lw, zorder=z,
                                 shrinkA=0, shrinkB=0))


def seg(pts, color, ls, lw=2.0, z=4):
    for k in range(len(pts) - 1):
        SEGS.append((pts[k], pts[k + 1]))
    ax.plot([p[0] for p in pts], [p[1] for p in pts], color=color, linestyle=ls,
            linewidth=lw, zorder=z, solid_capstyle="round")


def tag(x, y, text, fs_=11, color=SUB, ha="center", va="center", rot=0, bold=False, z=6):
    ax.text(x, y, text, fontsize=fs_, color=color, ha=ha, va=va, rotation=rot,
            fontweight="bold" if bold else "normal", zorder=z)


def diamond(cx, cy, w, h, text, bg, ed, fs_=11, tc=INK, lw=1.9, z=3):
    pts = [(cx, cy + h / 2), (cx + w / 2, cy), (cx, cy - h / 2), (cx - w / 2, cy)]
    ax.add_patch(Polygon(pts, closed=True, facecolor=bg, edgecolor=ed,
                         linewidth=lw, zorder=z, joinstyle="round"))
    ax.text(cx, cy, text, ha="center", va="center", fontsize=fs_, color=tc,
            zorder=z + 1, linespacing=1.55)
    return pts


def cycle(cx, cy, r, color, lw=3.0, label="", label_fs=9.0):
    """带箭头的小循环圈，表示「每轮重来」。"""
    th = np.linspace(np.deg2rad(40), np.deg2rad(328), 220)
    ax.plot(cx + r * np.cos(th), cy + r * np.sin(th), color=color, lw=lw,
            zorder=6, solid_capstyle="round")
    a = np.deg2rad(328)
    d = (-np.sin(a), np.cos(a))
    n = (-np.cos(a), -np.sin(a))
    base = (cx + r * np.cos(a), cy + r * np.sin(a))
    sz = 10
    ax.add_patch(Polygon([(base[0] + d[0] * sz, base[1] + d[1] * sz),
                          (base[0] + n[0] * sz * 0.6, base[1] + n[1] * sz * 0.6),
                          (base[0] - n[0] * sz * 0.6, base[1] - n[1] * sz * 0.6)],
                         closed=True, facecolor=color, edgecolor=color, zorder=7))
    if label:
        ax.text(cx, cy - 1, label, ha="center", va="center", fontsize=label_fs,
                color=color, fontweight="bold", zorder=7)


# ======================================================================
# 标题
# ======================================================================
tag(40, 1122, t("title"), fs_=25, color=INK, ha="left", bold=True)
tag(40, 1088, t("subtitle"), fs_=12.0, color=SUB, ha="left")

# ======================================================================
# 三条泳道
# ======================================================================
lanes = [
    (40, 430, C_M_BG, C_M_ED, t("lane_m"), t("lane_m_sub")),
    (460, 850, C_W_BG, C_W_ED, t("lane_w"), t("lane_w_sub")),
    (880, 1240, C_T_BG, C_T_ED, t("lane_t"), t("lane_t_sub")),
]
for x0, x1, bg, ed, name, sub in lanes:
    ax.add_patch(FancyBboxPatch((x0, 100), x1 - x0, 975,
                                boxstyle="round,pad=0,rounding_size=14",
                                facecolor=bg, edgecolor=ed, linewidth=1.4,
                                alpha=0.45, zorder=0.5))
    tag((x0 + x1) / 2, 1046, name, fs_=15, color=ed, bold=True)
    tag((x0 + x1) / 2, 1022, sub, fs_=10.2, color=SUB)

# ---------- 行坐标 ----------
MX, WX, TX = 235, 655, 1060
NW, NH = 220, 72

m1, m2, m3, m4, m5 = 970, 855, 745, 470, 375
w1, w2, w3, w4, w5 = 855, 660, 565, 470, 300
t1, t2, t3, t4, t5 = 970, 745, 660, 375, 290

# ---------- 节点 ----------
box(MX, m1, NW, NH, t("m1"), C_M_BG, C_M_ED, bold=True)
box(MX, m2, NW, NH, t("m2"), C_M_BG, C_M_ED, fs_=12.0)
box(MX, m3, NW, NH, t("m3"), C_M_BG, C_M_ED)
box(MX, m4, NW, NH, t("m4"), C_M_BG, C_M_ED, fs_=fs("m4", 12.0), bold=True)
box(MX, m5, NW, NH, t("m5"), C_M_BG, C_M_ED, bold=True)

box(WX, w1, NW, NH, t("w1"), C_W_BG, C_W_ED)
box(WX, w2, NW, NH, t("w2"), C_W_BG, C_W_ED, fs_=fs("w2", 11.5))
box(WX, w3, NW, 68, t("w3"), C_W_BG, C_W_ED, fs_=fs("w3", 11.5))
box(WX, w4, NW, NH, t("w4"), C_W_BG, C_W_ED, fs_=fs("w4", 12.5), bold=True)
box(WX, w5, NW, 64, t("w5"), C_W_BG, C_W_ED, fs_=11.5)

box(TX, t1, NW, NH, t("t1"), C_T_BG, C_T_ED, bold=True)
box(TX, t2, NW, NH, t("t2"), C_T_BG, C_T_ED, bold=True)
box(TX, t3, NW, NH, t("t3"), C_T_BG, C_T_ED, fs_=fs("t3", 12))
box(TX, t4, NW, NH, t("t4"), C_OK_BG, C_OK_ED, fs_=fs("t4", 12.5), bold=True)
box(TX, t5, NW, 70, t("t5"), C_ARC_BG, C_ARC_ED, fs_=12)

# ---------- 列内时间箭头 ----------
arrow([(MX, m1 - NH / 2), (MX, m2 + NH / 2)])
arrow([(MX, m2 - NH / 2), (MX, m3 + NH / 2)])
arrow([(MX, m3 - NH / 2), (MX, m4 + NH / 2)])
tag(MX + 20, 615, t("wait_w"), fs_=10.5, color="#64748b", ha="left")
arrow([(MX, m4 - NH / 2), (MX, m5 + NH / 2)])

arrow([(WX, w1 - NH / 2), (WX, w2 + NH / 2)])
arrow([(WX, w2 - NH / 2), (WX, w3 + 34)])
arrow([(WX, w3 - 34), (WX, w4 + NH / 2)])
arrow([(WX, w4 - NH / 2), (WX, w5 + 32)])

arrow([(TX, t1 - NH / 2), (TX, t2 + NH / 2)], color=C_T_ED)
arrow([(TX, t2 - NH / 2), (TX, t3 + NH / 2)], color=C_T_ED)
arrow([(TX, t3 - NH / 2), (TX, t4 + NH / 2)], color=C_T_ED)
arrow([(TX, t4 - NH / 2), (TX, t5 + 35)], color=C_T_ED)

# ---------- 跨泳道箭头 ----------
arrow([(MX + NW / 2, m1), (TX - NW / 2 - 4, t1)], color="#2563eb", lw=2.2)
tag((MX + NW / 2 + TX - NW / 2) / 2, m1 + 20, t("a1"), fs_=11.5, color="#2563eb", bold=True)

arrow([(MX + NW / 2, m2), (WX - NW / 2 - 4, w1)], color="#2563eb", lw=2.2)
tag((MX + NW / 2 + WX - NW / 2) / 2, m2 + 20, t("a2"), fs_=11.5, color="#2563eb", bold=True)

arrow([(MX + NW / 2, m3), (TX - NW / 2 - 4, t2)], color="#2563eb", lw=2.2)
tag(855, m3 + 20, t("a3"), fs_=11.2, color="#2563eb", bold=True)

arrow([(WX + NW / 2, w2), (TX - NW / 2 - 4, t3)], color="#16a34a", lw=2.2)
tag((WX + NW / 2 + TX - NW / 2) / 2, w2 + 20, t("a4"), fs_=11.5, color="#16a34a", bold=True)

arrow([(WX - NW / 2, w4), (MX + NW / 2 + 4, m4)], color="#16a34a", lw=2.2)
tag(378, w4 + 52, t("a5"), fs_=11.5, color="#16a34a", bold=True)

arrow([(MX + NW / 2, m5), (TX - NW / 2 - 4, t4)], color="#2563eb", lw=2.2)
tag(560, m5 + 30, t("a6"), fs_=10.6, color="#2563eb", bold=True)

# ---------- 异常结局卡 ----------
box(MX, 175, 350, 92, t("card_cd"), C_BAD_BG, C_BAD_ED, fs_=11.2, ls=DASH, lw=2.2)
box(WX, 180, 300, 96, t("card_ab"), C_BAD_BG, C_BAD_ED, fs_=11.5, ls=DASH, lw=2.2)
box(TX, 175, 300, 84, t("gate"), C_ARC_BG, C_ARC_ED, fs_=10.5, ls=DOT)
arrow([(TX, t5 - 35), (TX, 217)], color=C_ARC_ED, ls=DOT, lw=1.6)

# A：W 崩 / 被 interrupt（竖线在 5、6 处断开）
seg([(WX - NW / 2, w2), (470, w2)], C_BAD_ED, DASH)
seg([(470, w2), (470, 484)], C_BAD_ED, DASH)
seg([(470, 456), (470, 390)], C_BAD_ED, DASH)
seg([(470, 360), (470, 180)], C_BAD_ED, DASH)
arrow([(470, 180), (WX - 150 - 4, 180)], color=C_BAD_ED, ls=DASH, lw=2.0)
tag(508, 558, t("crash_w"), fs_=9.6, color=C_BAD_ED, rot=90, bold=True)

# B：W 正常结束但 M 忘了关
arrow([(WX, w5 - 32), (WX, 228)], color=C_BAD_ED, ls=DASH, lw=2.0)
tag(672, 250, t("forgot_close"), fs_=10.5, color=C_BAD_ED, ha="left", bold=True)

# C / D：M 会话重建
box(MX, 285, 220, 58, t("m_replaced"), C_BAD_BG, C_BAD_ED, fs_=10.5, ls=DASH, lw=2.0)
seg([(MX - 35, m4 - NH / 2), (90, m4 - NH / 2), (90, 285)], C_BAD_ED, DASH)
arrow([(90, 285), (MX - 110 - 4, 285)], color=C_BAD_ED, ls=DASH, lw=2.0)
tag(74, 372, t("any_time"), fs_=10.5, color=C_BAD_ED, rot=90, bold=True)
arrow([(MX, 256), (MX, 223)], color=C_BAD_ED, ls=DASH, lw=2.0)

# ======================================================================
# 中列：判定权 + 图例
# ======================================================================
box(1415, 690, 300, 300, "", C_NOTE_BG, C_NOTE_ED, lw=2.6)
tag(1415, 800, t("authority_title"), fs_=15, color="#b45309", bold=True)
ax.text(1415, 672, t("authority_body"),
        ha="center", va="center", fontsize=11.8, color="#7c2d12",
        linespacing=1.62, zorder=5)

box(1415, 430, 300, 140, "", "white", "#cbd5e1", lw=1.2)
ax.plot([1290, 1335], [465, 465], color="#2563eb", lw=2.2, zorder=5)
tag(1342, 465, t("legend_normal"), fs_=11, color=SUB, ha="left")
ax.plot([1290, 1335], [430, 430], color=C_BAD_ED, lw=2.0, ls=DASH, zorder=5)
tag(1342, 430, t("legend_bad"), fs_=11, color=SUB, ha="left")
ax.add_patch(FancyBboxPatch((1290, 386), 45, 18, boxstyle="round,pad=0,rounding_size=4",
                            facecolor=C_OK_BG, edgecolor=C_OK_ED, lw=1.4, zorder=5))
tag(1342, 395, t("legend_terminal"), fs_=11, color=SUB, ha="left")

# ======================================================================
# 右侧：巡检（自上而下）
# ======================================================================
BX0, BX1 = 1600, 2200
BY0, BY1 = 120, 1060
CX = (BX0 + BX1) / 2

ax.add_patch(FancyBboxPatch((BX0, BY0), BX1 - BX0, BY1 - BY0,
                            boxstyle="round,pad=0,rounding_size=14",
                            facecolor=C_SW_BG, edgecolor=C_SW_ED,
                            linewidth=1.6, alpha=0.55, zorder=0.6))

tag(CX, 1032, t("sweep_title"), fs_=15, color=C_SW_SUB, bold=True)
tag(CX, 1002, t("sweep_sub"), fs_=10.2, color="#9a3412")
cycle(2152, 1024, 24, C_SW_ED, lw=2.6, label=t("cycle_label"), label_fs=8.4)

# 1 取票
box(CX, 930, 530, 78, t("sweep_pick"), C_SW_BG, C_SW_ED,
    fs_=fs("sweep_pick", 10.0), lw=1.6, ls_sp=1.5)
arrow([(CX, 993), (CX, 971)], color=C_SW_ED, lw=1.8, head=12)
arrow([(CX, 891), (CX, 862)], color=C_SW_ED, lw=1.8, head=13)

# 2 菱形
diamond(CX, 800, 350, 118, t("sweep_diamond"), "#ffedd5", C_SW_ED, fs_=10.5, lw=1.8)

# 3 两档
GW_X, SL_X, BR_Y, BR_W, BR_H = 1748, 2052, 600, 248, 172
box(GW_X, BR_Y, BR_W, BR_H, "", "#fee2e2", C_BAD_ED, lw=1.6)
tag(GW_X, BR_Y + BR_H / 2 - 22, t("gw_title"), fs_=10.5, color=C_BAD_ED, bold=True)
ax.text(GW_X, BR_Y - 18, t("gw_body"),
        ha="center", va="center", fontsize=fs("gw_body", 9.2), color="#7f1d1d",
        linespacing=1.62, zorder=5)

box(SL_X, BR_Y, BR_W, BR_H, "", "#fef3c7", C_NOTE_ED, lw=1.6)
tag(SL_X, BR_Y + BR_H / 2 - 22, t("sl_title"), fs_=10.5, color="#b45309", bold=True)
ax.text(SL_X, BR_Y - 20, t("sl_body"),
        ha="center", va="center", fontsize=fs("sl_body", 9.2), color="#78350f",
        linespacing=1.58, zorder=5)

seg([(CX, 741), (CX, 714)], C_SW_ED, "-", lw=1.7)
seg([(GW_X, 714), (SL_X, 714)], C_SW_ED, "-", lw=1.7)
arrow([(GW_X, 714), (GW_X, 688)], color=C_SW_ED, lw=1.7, head=13)
arrow([(SL_X, 714), (SL_X, 688)], color=C_SW_ED, lw=1.7, head=13)
tag(GW_X + 58, 728, t("sweep_yes"), fs_=10, color=C_SW_SUB, bold=True, z=7)
tag(SL_X - 58, 728, t("sweep_no"), fs_=10, color=C_SW_SUB, bold=True, z=7)

# 4 汇合 -> 节流
seg([(GW_X, BR_Y - BR_H / 2), (GW_X, 492)], C_SW_ED, "-", lw=1.7)
seg([(SL_X, BR_Y - BR_H / 2), (SL_X, 492)], C_SW_ED, "-", lw=1.7)
seg([(GW_X, 492), (SL_X, 492)], C_SW_ED, "-", lw=1.7)
arrow([(CX, 492), (CX, 481)], color=C_SW_ED, lw=1.8, head=13)

box(CX, 410, 530, 142, "", "#ffedd5", C_SW_ED, lw=1.7)
tag(CX, 458, t("thr_title"), fs_=11, color=C_SW_SUB, bold=True)
ax.text(CX, 418, t("thr_fp"), ha="center", va="center",
        fontsize=fs("thr_fp", 10.5), color="#7c2d12", zorder=5)
ax.text(CX, 378, t("thr_note"), ha="center", va="center",
        fontsize=9.2, color="#9a3412", zorder=5)

# 5 推送
arrow([(CX, 339), (CX, 314)], color=C_SW_ED, lw=1.8, head=13)
box(CX, 238, 530, 152, "", "#dcfce7", C_OK_ED, lw=1.7)
tag(CX, 286, t("push_title"), fs_=11, color="#15803d", bold=True)
ax.text(CX, 226, t("push_body"), ha="center", va="center",
        fontsize=fs("push_body", 9.2), color="#14532d", linespacing=1.62, zorder=5)

# ======================================================================
# 底部注
# ======================================================================
ax.text(40, 78, t("note1"), ha="left", va="center", fontsize=fs("note1", 10.5),
        color="#6b7280", zorder=6)
ax.text(40, 56, t("note2"), ha="left", va="center", fontsize=fs("note2", 10.5),
        color="#6b7280", zorder=6)

# ======================================================================
# 输出
# ======================================================================
import os

# 默认写到脚本自己所在目录（docs/），副本或被拷走也能直接重画；FIGS_DIR 可覆盖。
OUT_DIR = os.environ.get("FIGS_DIR") or os.path.dirname(os.path.abspath(__file__))
out = os.path.join(OUT_DIR, "worker-ticket-lifecycle.%s.png" % LANG)
fig.savefig(out, dpi=100, facecolor="white", edgecolor="none")
print("saved", out, "font:", plt.rcParams["font.sans-serif"][0])

# ======================================================================
# 自检：文字是否越出所属框 / 互相压叠（CHECK=1 时打印）
# ======================================================================
if os.environ.get("CHECK"):
    fig.canvas.draw()
    rend = fig.canvas.get_renderer()
    inv = ax.transData.inverted()

    def dbox(artist):
        bb = artist.get_window_extent(rend)
        (x0, y0) = inv.transform((bb.x0, bb.y0))
        (x1, y1) = inv.transform((bb.x1, bb.y1))
        return min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)

    rects = []
    for pt in ax.patches:
        if isinstance(pt, FancyBboxPatch) and pt.get_zorder() < 5 and pt.get_width() > 60:
            rects.append((*dbox(pt), pt.get_facecolor()))

    texts = []
    for tx in ax.texts:
        if not tx.get_text().strip():
            continue
        texts.append((tx.get_text().replace("\n", " / ")[:34], *dbox(tx)))

    bad = 0
    for label, x0, y0, x1, y1 in texts:
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        best = None
        for rx0, ry0, rx1, ry1, fc in rects:
            if rx0 <= cx <= rx1 and ry0 <= cy <= ry1:
                area = (rx1 - rx0) * (ry1 - ry0)
                if best is None or area < best[0]:
                    best = (area, rx0, ry0, rx1, ry1)
        if best:
            _, rx0, ry0, rx1, ry1 = best
            if x0 < rx0 - 1 or x1 > rx1 + 1 or y0 < ry0 - 1 or y1 > ry1 + 1:
                bad += 1
                print("OVERFLOW %-36s text=%.0f..%.0f box=%.0f..%.0f  |  y %.0f..%.0f box %.0f..%.0f"
                      % (label, x0, x1, rx0, rx1, y0, y1, ry0, ry1))

    for i in range(len(texts)):
        for j in range(i + 1, len(texts)):
            a, b = texts[i], texts[j]
            ox = min(a[3], b[3]) - max(a[1], b[1])
            oy = min(a[4], b[4]) - max(a[2], b[2])
            if ox > 2 and oy > 2:
                bad += 1
                print("TEXT-OVERLAP %-30s <> %-30s (%.0fx%.0f)" % (a[0], b[0], ox, oy))

    pts = []
    for (a0, b0) in SEGS:
        for f in np.linspace(0.02, 0.98, 40):
            pts.append((a0[0] + (b0[0] - a0[0]) * f, a0[1] + (b0[1] - a0[1]) * f))
    for label, x0, y0, x1, y1 in texts:
        hit = sum(1 for (px, py) in pts if x0 + 1 < px < x1 - 1 and y0 + 1 < py < y1 - 1)
        if hit >= 3:
            bad += 1
            print("ARROW-CROSSES-TEXT %-34s hits=%d" % (label, hit))

    for label, x0, y0, x1, y1 in texts:
        if x0 < 0 or y0 < 0 or x1 > W or y1 > H:
            bad += 1
            print("OUT-OF-CANVAS", label)

    print("check done: texts=%d segs=%d boxes=%d issues=%d" % (len(texts), len(SEGS), len(rects), bad))
