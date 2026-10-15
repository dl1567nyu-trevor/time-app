"""CP-SAT 排程基线（可选，用来和 Node 求解器对照）

用法：
    python tools/ortools_plan.py            # 跑内置对照用例
    python tools/ortools_plan.py plan.json  # 跑自己的 PlanRequest

依赖：pip install ortools
它和 scheduler.mjs 使用同一份 JSON 契约（见 docs/schedule-contract.md），
所以前端和接口都不用改就能在两者之间切换。

注意：这是"对照基线"，不是默认实现。本项目的默认求解器是零依赖的
scheduler.mjs（多起点贪心 + 局部搜索）。什么时候值得换过来，见契约文档最后一节。
"""

import json
import sys
from ortools.sat.python import cp_model

PLACEHOLDER_SUBJECTS = {"", "无", "空"}


def to_minutes(text):
    hour, minute = str(text).split(":")
    return int(hour) * 60 + int(minute)


def from_minutes(total):
    return f"{total // 60 % 24:02d}:{total % 60:02d}"


def split_homework(minutes, focus_limit, walk_break):
    """和 scheduler.mjs 保持一致的切分：段数先定，余数给前面的段，每段 ≤ 上限。"""
    chunks = max(1, -(-minutes // focus_limit))
    per = (minutes // chunks // 5) * 5
    remainder = minutes - per * chunks
    events = []
    for index in range(chunks):
        extra = min(5, remainder) if remainder > 0 else 0
        remainder -= extra
        size = max(5, per + extra)
        events.append({"kind": "homework", "minutes": size, "piece": index})
        if index < chunks - 1 and walk_break > 0:
            events.append({"kind": "rest", "minutes": walk_break, "piece": index, "auto": True})
    return events


def solve_request(request, time_limit=10.0, workers=8):
    """用 CP-SAT 排程：时间离散成分钟，用布尔变量表示"某事件在某分钟开始"。"""
    start = to_minutes(request["horizon"]["start"])
    end = to_minutes(request["horizon"]["end"])
    prefs = request.get("preferences", {})
    focus_limit = int(prefs.get("focusLimitMinutes", 20))
    walk_break = int(prefs.get("walkBreakMinutes", 5))
    max_play_block = int(prefs.get("maxPlayBlockMinutes", 60))
    play_goal = int(request.get("playGoalMinutes", 0))

    model = cp_model.CpModel()
    index_of = {}
    starts = {}
    ends = {}
    intervals = {}
    events = []
    event_item = {}

    def add_event(event_id, kind, minutes, earliest, latest, item):
        index_of[event_id] = len(events)
        slot = len(events)
        events.append(event_id)
        event_item[slot] = item
        starts[slot] = model.NewIntVar(earliest, max(earliest, latest - minutes), f"s{slot}")
        ends[slot] = model.NewIntVar(earliest + minutes, max(earliest + minutes, latest), f"e{slot}")
        intervals[slot] = model.NewIntervalVar(starts[slot], minutes, ends[slot], f"i{slot}")
        return slot

    fixed_spans = []
    for item in request["tasks"]:
        if item.get("fixed"):
            at = to_minutes(item.get("window", {}).get("earliest", from_minutes(start)))
            fixed_spans.append((at, at + int(item["minutes"]), item))
            slot = add_event(f"fixed:{item['id']}", item["kind"], int(item["minutes"]), at, at + int(item["minutes"]), item)
            model.Add(starts[slot] == at)

    flexible = [item for item in request["tasks"] if not item.get("fixed")]
    play_slots = []
    homework_by_item = {}
    rest_slots = []

    for item in flexible:
        earliest = to_minutes(item.get("window", {}).get("earliest", from_minutes(start)))
        latest = to_minutes(item.get("window", {}).get("latest", from_minutes(end)))
        if item.get("deadline"):
            latest = min(latest, to_minutes(item["deadline"]))
        minutes = int(item["minutes"])
        kind = item["kind"]
        if kind == "homework":
            pieces = split_homework(minutes, focus_limit, walk_break)
            slots = []
            for piece in pieces:
                if piece.get("auto"):
                    rest_slots.append(add_event(f"rest:{item['id']}:{piece['piece']}", "rest", piece["minutes"], earliest, latest, item))
                    continue
                slots.append(add_event(f"{item['id']}#{piece['piece']}", "homework", piece["minutes"], earliest, latest, item))
            homework_by_item[item["id"]] = slots
        elif kind == "play":
            remaining = minutes
            piece = 0
            while remaining > 0:
                size = min(max_play_block, remaining)
                play_slots.append(add_event(f"{item['id']}#{piece}", "play", size, earliest, latest, item))
                remaining -= size
                piece += 1
        else:
            add_event(item["id"], kind, minutes, earliest, latest, item)

    # 硬约束一：所有块互不重叠
    model.AddNoOverlap(list(intervals.values()))

    # 目标：作业分钟数（按优先级加权）+ 娱乐分钟
    terms = []
    for item in flexible:
        if item["kind"] != "homework":
            continue
        weight = 3 + int(item.get("priority", 3)) * 2
        for slot in homework_by_item.get(item["id"], []):
            terms.append(intervals[slot].SizeExpr() * weight)
    for slot in play_slots:
        terms.append(intervals[slot].SizeExpr() * 3)
    model.Maximize(sum(terms))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = time_limit
    solver.parameters.num_search_workers = workers
    status = solver.Solve(model)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return {"status": solver.StatusName(status), "blocks": [], "objective": None}

    blocks = []
    for slot, event_id in enumerate(events):
        item = event_item.get(slot) or {}
        blocks.append({
            "id": event_id,
            "title": item.get("title", event_id),
            "kind": item.get("kind", "life"),
            "start": from_minutes(solver.Value(starts[slot])),
            "end": from_minutes(solver.Value(ends[slot])),
            "minutes": solver.Value(ends[slot]) - solver.Value(starts[slot]),
        })
    blocks.sort(key=lambda block: block["start"])
    return {
        "status": solver.StatusName(status),
        "objective": round(solver.ObjectiveValue(), 2),
        "wallTimeSeconds": round(solver.WallTime(), 4),
        "blocks": blocks,
    }


DEMO = {
    "requestId": "ortools-demo",
    "horizon": {"start": "16:00", "end": "21:00"},
    "preferences": {"focusLimitMinutes": 20, "walkBreakMinutes": 5, "maxPlayBlockMinutes": 60},
    "playGoalMinutes": 90,
    "tasks": [
        {"id": "t0", "title": "英语：复p23~24页", "kind": "homework", "minutes": 20, "priority": 4},
        {"id": "t1", "title": "英语：2背p26", "kind": "homework", "minutes": 15, "priority": 4},
        {"id": "t2", "title": "数学：口算两页", "kind": "homework", "minutes": 25, "priority": 5, "deadline": "17:30"},
        {"id": "t3", "title": "玩 Minecraft", "kind": "play", "minutes": 30, "priority": 2},
        {"id": "t4", "title": "看课外书", "kind": "play", "minutes": 30, "priority": 1},
        {"id": "a0", "title": "钢琴课", "kind": "life", "minutes": 45, "priority": 5, "fixed": True, "window": {"earliest": "18:30"}},
    ],
}

if __name__ == "__main__":
    payload = json.load(open(sys.argv[1], encoding="utf-8")) if len(sys.argv) > 1 else DEMO
    result = solve_request(payload)
    print(f"状态: {result['status']}  目标值: {result.get('objective')}  求解耗时: {result.get('wallTimeSeconds')} s")
    for block in result["blocks"]:
        print(f"  {block['start']}-{block['end']} {block['minutes']:>3}min {block['kind']:<8} {block['title']}")
