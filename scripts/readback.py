#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""readback.py — dsh 会话 transcript 读取器（会话接手协议 v1 配套）。

用法:
  python readback.py index  <session-id>                 # 轮次提纲（user/assistant/todo/turn，头80字）
  python readback.py read    <session-id> --from N --to M [--max-chars 30000]
                                                         # 按 seq 区间读 user/assistant 全文
  python readback.py search  <session-id> --q <关键词> [--max-hits 40]
                                                         # 全事件关键词检索（含 tool/result）
  python readback.py verify  <handoff-dir>               # 八节交接包齐备校验 + manifest 摘要行

安全边界（铁律）:
  - session-id 必须形如 session-<uuid>；仅允许在 %USERPROFILE%\\.dsh\\sessions\\ 下解析，
    realpath 越界即拒绝（禁路径穿越/跨根读取）。
  - verify 的目录必须形如 ...\\.handoff\\handoff-YYYYMMDD-HHMMSS 且真实存在。
  - 所有输出有界（防止撑爆接手会话的上下文）。
"""
import argparse
import glob
import hashlib
import json
import os
import re
import sys

try:
    import zstandard as zstd
except ImportError:
    print("[readback] 缺少依赖：pip install zstandard", file=sys.stderr)
    sys.exit(2)

DSH_SESSIONS = os.path.join(os.path.expanduser("~"), ".dsh", "sessions")
SID_RE = re.compile(r"^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
HANDOFF_DIR_RE = re.compile(r"handoff-\d{8}-\d{6}$")
SECTIONS = [
    "01-identity.md", "02-rules.md", "03-tasks.md", "04-facts.md",
    "05-baseline.md", "06-open.md", "07-next.md", "08-loss.md",
]
HEAD = 80


def resolve_session_file(sid: str) -> str:
    if not SID_RE.match(sid):
        print(f"[readback] 非法 session-id: {sid!r}", file=sys.stderr)
        sys.exit(2)
    hits = []
    for name in ("session.v4.jsonl.zstd", "session.jsonl.zstd"):
        hits.extend(glob.glob(os.path.join(DSH_SESSIONS, "*", sid, name)))
    if not hits:
        print(f"[readback] 未找到会话文件（检查 id）: {sid}", file=sys.stderr)
        sys.exit(3)
    real = os.path.realpath(hits[0])
    root = os.path.realpath(DSH_SESSIONS)
    if not real.startswith(root + os.sep):
        print("[readback] 路径越界拒绝", file=sys.stderr)
        sys.exit(2)
    return real


def load_events(sid: str):
    path = resolve_session_file(sid)
    raw = zstd.ZstdDecompressor().stream_reader(open(path, "rb")).read()
    evs = []
    for ln in raw.decode("utf-8", errors="replace").splitlines():
        try:
            evs.append(json.loads(ln))
        except Exception:
            pass
    return evs


def text_of(ev: dict) -> str:
    """user/assistant 消息 → 纯文本；其他事件 → 空。

    兼容两种落盘结构：
      - user/message:      data.content = [ {type:"text", ...}, ... ]
      - assistant/message: data.message.content = [ {type:"reasoning"|"text", ...} ]
    只取 type=="text" 的块（reasoning 内容不进入交接包）。
    """
    data = ev.get("data") or {}
    blocks = data.get("content")
    if not isinstance(blocks, list):
        msg = data.get("message")
        blocks = msg.get("content") if isinstance(msg, dict) else None
    parts = []
    for c in blocks or []:
        if isinstance(c, dict) and c.get("type") == "text" and c.get("text"):
            parts.append(str(c["text"]))
    return "\n".join(parts)


def one_line(s: str, n: int = HEAD) -> str:
    return re.sub(r"\s+", " ", s).strip()[:n]


def timestr(ev: dict) -> str:
    t = ev.get("time")
    if isinstance(t, (int, float)):
        import datetime
        return datetime.datetime.fromtimestamp(t / 1000).strftime("%m-%d %H:%M")
    return "?"


def cmd_index(sid: str, args) -> None:
    evs = load_events(sid)
    total = len(evs)
    if total == 0:
        print("[readback] 错误：文件存在但解析出 0 事件（transcript 可能损坏）——接手协议应判定移交失败",
              file=sys.stderr)
        sys.exit(3)
    # 统计
    types: dict = {}
    for e in evs:
        types[e.get("type", "?")] = types.get(e.get("type", "?"), 0) + 1
    print(f"[index] {sid} 共 {total} 事件")
    print("[index] 类型分布:", json.dumps(types, ensure_ascii=False))
    # 最后一次 todo 状态
    last_todo = None
    for e in evs:
        if e.get("type") == "todo/write":
            last_todo = e
    if last_todo:
        print("[index] 最后 todo 状态:",
              one_line(json.dumps(last_todo.get("data", {}), ensure_ascii=False), 600))
    # 提纲（有界：最多 500 行）
    lines = 0
    for e in evs:
        t = e.get("type", "?")
        if t == "turn/start":
            print(f"--- turn @{timestr(e)}")
        elif t == "user/message":
            print(f"U{e.get('seq')} {timestr(e)} | {one_line(text_of(e))}")
            lines += 1
        elif t == "assistant/message":
            print(f"A{e.get('seq')} {timestr(e)} | {one_line(text_of(e))}")
            lines += 1
        elif t == "tool/call":
            d = (e.get("data") or {})
            print(f"  T{e.get('seq')} {d.get('name', d.get('tool', '?'))}")
        if lines > 500:
            print("[index] （截断：超过 500 条消息提纲，用 read/search 定向读取）")
            break


def cmd_read(sid: str, args) -> None:
    evs = load_events(sid)
    lo, hi = args.from_seq, args.to_seq
    budget = args.max_chars
    printed = 0
    for e in evs:
        seq = e.get("seq")
        if not isinstance(seq, int) or seq < lo or seq > hi:
            continue
        t = e.get("type", "?")
        if t not in ("user/message", "assistant/message"):
            continue
        txt = text_of(e)
        if not txt:
            continue
        chunk = f"【{t.split('/')[0].upper()} seq={seq} {timestr(e)}】\n{txt}\n"
        if printed + len(chunk) > budget:
            remain = budget - printed
            if remain > 200:
                print(chunk[:remain] + "\n…（截断：缩小 --from/--to 或提高 --max-chars）")
            break
        print(chunk)
        printed += len(chunk)
    print(f"[read] 输出 {printed} 字符（预算 {budget}）")


def cmd_search(sid: str, args) -> None:
    evs = load_events(sid)
    q = args.query.lower()
    hits = 0
    for e in evs:
        seq = e.get("seq")
        t = e.get("type", "?")
        payload = text_of(e) or one_line(json.dumps(e.get("data", {}), ensure_ascii=False), 400)
        if q in payload.lower():
            print(f"HIT seq={seq} type={t} {timestr(e)} | {one_line(payload, 160)}")
            hits += 1
            if hits >= args.max_hits:
                print("[search] （命中数截断）")
                break
    print(f"[search] '{args.query}' 命中 {hits} 条")


def cmd_verify(handoff_dir: str, args) -> None:
    real = os.path.realpath(handoff_dir)
    if not os.path.isdir(real) or not HANDOFF_DIR_RE.search(os.path.basename(real)):
        print(f"[verify] 非法或不存在的 handoff 目录: {handoff_dir}", file=sys.stderr)
        sys.exit(3)
    missing, sizes = [], {}
    for name in SECTIONS:
        p = os.path.join(real, name)
        if not os.path.isfile(p) or os.path.getsize(p) == 0:
            missing.append(name)
        else:
            sizes[name] = os.path.getsize(p)
    h = hashlib.sha256()
    for name in SECTIONS:
        p = os.path.join(real, name)
        if os.path.isfile(p):
            h.update(open(p, "rb").read())
    digest = h.hexdigest()[:16]
    if missing:
        print(f"VERIFY-FAIL missing={','.join(missing)}")
        sys.exit(4)
    print(f"HANDOFF-MANIFEST: {real}|01..08 齐备|sha256={digest}")
    for name in SECTIONS:
        print(f"  {name}: {sizes.get(name, 0)} bytes")


def main():
    ap = argparse.ArgumentParser(description="dsh 会话 transcript 读取器（接手协议 v1）")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p1 = sub.add_parser("index"); p1.add_argument("sid")
    p2 = sub.add_parser("read"); p2.add_argument("sid")
    p2.add_argument("--from", dest="from_seq", type=int, default=0)
    p2.add_argument("--to", dest="to_seq", type=int, default=10**9)
    p2.add_argument("--max-chars", type=int, default=30000)
    p3 = sub.add_parser("search"); p3.add_argument("sid")
    p3.add_argument("--q", dest="query", required=True)
    p3.add_argument("--max-hits", type=int, default=40)
    p4 = sub.add_parser("verify"); p4.add_argument("dir")
    args = ap.parse_args()
    if args.cmd == "index":
        cmd_index(args.sid, args)
    elif args.cmd == "read":
        cmd_read(args.sid, args)
    elif args.cmd == "search":
        cmd_search(args.sid, args)
    elif args.cmd == "verify":
        cmd_verify(args.dir, args)


if __name__ == "__main__":
    main()
