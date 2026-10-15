# 排程接口契约（MVP）

这份文档定义"任务清单 → 时间分配表"的输入输出格式。**大模型不参与这里**：它只负责把孩子的原话变成任务清单，时间分配由 `scheduler.mjs` 求解。

## 为什么不让大模型排时间

| 能力 | 大模型 | 求解器 |
| --- | --- | --- |
| 听懂"英语4项作业复p23页…"并拆成任务 | ✅ 强 | ❌ 做不了 |
| 判断"看课外书是娱乐、读课文是学习" | ✅ 强 | ❌ 做不了 |
| 给出 16:00–21:00 内不重叠的时间表 | ⚠️ 会算错、会给出重叠或超时 | ✅ 保证不重叠、不超时 |
| 满足"8点前必须完成""18:30 钢琴课不能动" | ⚠️ 经常漏 | ✅ 硬约束，可验证 |
| 每段学习不超过 20 分钟、娱乐不相邻 | ⚠️ 时好时坏 | ✅ 确定性输出 |
| 速度 / 费用 | 1–2 秒、按 token 计费 | 3–60 ms、零成本 |
| 可复现、可测试 | ❌ 同一输入结果会漂 | ✅ 纯函数，24 项断言覆盖 |

结论：**模型理解需求，求解器分配时间。** 模型偶尔排错一张表，孩子一天就乱了；求解器的输出可以写单元测试。

## 接入点

```
POST /api/plan
Content-Type: application/json
{ "request": <PlanRequest>, "budgetMs": 500 }   // budgetMs 可选，局部搜索的时间预算
→ 200 <PlanResult>
→ 400 { "error": "排程参数有问题：…" }
```

求解全程在本机完成，不调用任何外部 API，不消耗额度。

## PlanRequest（输入）

```jsonc
{
  "requestId": "plan-1712...",
  "horizon": { "start": "16:00", "end": "21:00" },   // 必填，排程窗口
  "preferences": {
    "focusLimitMinutes": 20,      // 连续学习段上限（默认 20）
    "walkBreakMinutes": 5,        // 学习段之间的活动休息（默认 5）
    "maxPlayBlockMinutes": 60,    // 单个娱乐块上限（默认 60）
    "minRestBetweenPlay": 1,      // 相邻娱乐之间至少隔几个非娱乐块（默认 1）
    "windDownMinutes": 20,        // 预留的睡前时间（默认 20）
    "snackTime": "17:00",         // 可选，点心时间提示
    "dinnerWindow": ["18:00", "19:00"]   // 可选，晚饭时间窗
  },
  "playGoalMinutes": 90,          // 期望娱乐总量；不足会体现在评分里，不会硬塞
  "tasks": [
    {
      "id": "t2",
      "title": "数学：口算两页",
      "kind": "homework",         // homework | play | rest | life
      "minutes": 25,              // 期望时长
      "minMinutes": 10,           // 可压缩到的下限（默认 homework 为专注上限）
      "priority": 5,              // 1–5，越大越重要；时间不够时先保大的
      "splittable": true,         // 能否切段（学习类默认 true）
      "deadline": "17:30",        // 可选，必须在此之前结束（硬约束）
      "window": { "earliest": "19:00", "latest": "20:00" },  // 可选，允许出现的时间窗
      "prefer": { "start": "17:00", "end": "19:00" },        // 可选，孩子希望的时段（软约束，加分）
      "fixed": true               // true = 时间锚点，如"18:30 钢琴课"，求解器绝不移动、也不许被占用
    }
  ]
}
```

关于 `fixed` 的约定：**固定安排由调用方声明**，求解器只当作不可移动的障碍物。
晚饭和睡前洗漱不是内置规则——页面把它们作为 `fixed` 任务传进来（晚饭在窗口中间、洗漱贴在睡前），
所以"哪天不看电视、要 19:30 吃饭"这种调整不需要改求解器。

## PlanResult（输出）

```jsonc
{
  "requestId": "plan-1712...",
  "feasible": true,          // 没有作业被丢弃
  "degraded": false,         // true = 有任务没排进，需要家长介入
  "solver": { "name": "greedy+local-search", "strategy": "deadline", "candidates": 8, "rounds": 3, "elapsedMs": 4 },
  "objective": 1290.5,       // 评分，越大越好（仅用于比较方案，不是绝对值）
  "blocks": [
    {
      "id": "t2#0", "sourceId": "t2",
      "title": "数学：口算两页", "kind": "homework",
      "start": "16:00", "end": "16:20", "minutes": 20,
      "startMinutes": 960,             // 便于程序排序
      "splitIndex": 0, "splitCount": 2, // 分段信息；1/1 表示未拆
      "auto": false,                    // true = 程序自动插入的休息
      "fixed": false,                   // true = 固定安排
      "countsTowardSource": true,       // false = 自动块，不计入原任务时长
      "preferenceHit": 1,               // 0–1，落在孩子希望时段的比例
      "rationale": "排在截止时间前"
    }
  ],
  "unscheduled": [ { "id": "t5", "title": "英语朗读", "reason": "在 17:00 前只排进 10 分钟", "missingMinutes": 5 } ],
  "metrics": {
    "workPlanned": 105, "workScheduled": 105, "workUnscheduled": 0,
    "playPlanned": 60, "playScheduled": 60, "playShortfall": 30,
    "preferenceMiss": 0, "respectMinutes": 30, "restMinutes": 10,
    "horizonMinutes": 300, "busyMinutes": 225, "idleMinutes": 75,
    "homeworkDroppedMinutes": 0
  },
  "validation": { "ok": true, "errors": [] },   // 求解器自检：重叠、超窗、占用固定安排、相邻娱乐、时间窗
  "warnings": ["窗口内还有 75 分钟空档"]
}
```

**调用方必须检查 `validation.ok` 和 `unscheduled`**：求解器会自我校验，但前端仍应把没排进的任务显式展示出来，而不是静默丢掉。

## 约束一览（按优先级）

硬约束（违反即视为 bug，`validation` 会报错）：
1. 块与块不重叠、全部落在 `horizon` 内；
2. `fixed` 任务的时间不被移动、不被占用；
3. 遵守 `window.earliest / window.latest` 和 `deadline`；
4. 同一任务的分段互不重叠（由 1 保证）；
5. 相邻两段娱乐之间必须隔一个非娱乐块。

软约束（体现在 `objective` 里）：
6. 作业尽量全部排进，**优先级高的先保**（每分钟得分 `3 + priority × 2`）；
7. 娱乐尽量达到 `playGoalMinutes`；
8. 儿童偏好时段尽量满足（`prefer`）；
9. 休息总量适度：只按学习时长的 20%（上限 20 分钟）计分，超出按 4 倍扣分——**这条是实测踩坑后加的**，否则求解器会为了多拿休息分把作业切碎成"做 10 分钟休 5 分钟"。

目标函数（简化形式）：

```
objective = 2×作业分钟 + Σ(作业分钟 × (3 + priority×2)) + 1.5×娱乐分钟
          + 偏好命中分钟 − 8×未排分钟 − 1.5×娱乐缺口 − 3×偏好落空
          + 适度休息奖励
```

## 算法

1. **多起点贪心**：生成 7 种候选顺序（按截止时间、按优先级、孩子优先、生活优先、休息优先、学娱交错、偏好优先），各自贪心布局，取评分最高者。
2. **局部搜索**：交换相邻两项、轮换顺序，接受更优解，直到 `budgetMs` 用尽（默认 400 ms）。
3. **分段**：学习任务先算段数、再均分（余数给前面的段），保证每段 ≤ 专注上限且总量精确。
4. **可行性先行**：放置前先判断"最少时长是否还有可能放下"，不可能就直接记为未排——这一条修掉了一个真实的死循环 bug。

规模参考：16 个任务约 12 ms；本场景（单孩子、单天、10–20 个任务）远在舒适区内。

## 想换成 OR-Tools 怎么办

`tools/ortools_plan.py` 是同一套契约的 CP-SAT 基线实现。什么时候值得换：

- 任务上到几百个（比如整周的排程），贪心+局部搜索的近似会明显变差；
- 需要"最优性证明"或"证明无解"；
- 想加更复杂的约束（多资源、跨天、软约束权重自动调参）。

换的时候只改 `server.mjs` 里 `/api/plan` 的实现，前端和其它接口完全不用动——这就是先把 JSON 契约定下来的意义。

**当前不换的理由**：本机 Python 3.13 有 OR-Tools 的 `cp313` wheel（22.8 MB）可以装，但 Node 方案零依赖、无需额外运行时；在 10–20 个任务的规模下两者结果一致，而 Node 方案还能保持"一个 `node server.mjs` 就跑起来"的部署简单性。
