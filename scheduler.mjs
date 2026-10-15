// 放学后排程求解器（零依赖，纯函数）
//
// 为什么不用大模型做排程：大模型擅长"理解需求、抽取任务、解释结果"，但时间分配是
// 组合优化问题——它算不准"总共 270 分钟、要放 8 件事、每段学习不超过 20 分钟、
// 娱乐不能相邻"这种约束，还会给出时间重叠或超时的表。所以：
//   大模型只负责「文字 → 任务清单」，精确排程交回本模块。
//
// 为什么先自己写而不是上 OR-Tools：本场景是单孩子、单天、10~20 个任务，规模极小。
// 本模块用「多起点贪心布局 + 局部搜索」就能拿到可解释、稳定的解，且保持
// "一个 node server.mjs 就能跑"的零依赖部署。任务规模上到几百个、或需要最优性证明时，
// 再换 OR-Tools CP-SAT（见 tools/README 里的对照说明），接口不变。
//
// ---------------------------------------------------------------------------
// 输入契约 PlanRequest
// ---------------------------------------------------------------------------
// {
//   requestId: string,                  // 回显用
//   horizon: { start: "16:00", end: "21:00" },   // 排程窗口（分钟精度）
//   preferences: {
//     focusLimitMinutes: 20,            // 连续学习段的时长上限
//     maxPlayBlockMinutes: 60,          // 单个娱乐块上限
//     walkBreakMinutes: 5,              // 学习段之间的活动休息
//     minRestBetweenPlay: 1,            // 相邻娱乐之间至少要有 1 个非娱乐块
//     walkBreaks: true,                 // 是否自动插入活动休息
//     snackTime: "17:00",               // 可选：点心锚点
//     dinnerWindow: ["18:00","19:00"],  // 可选：晚饭时间窗，由求解器挑一个点
//     windDownMinutes: 20               // 睡前洗漱时长，钉在窗口末尾
//   },
//   playGoalMinutes: 90,                // 期望的娱乐总量（不足会体现在评分里）
//   tasks: [{
//     id: "t1",
//     title: "完成数学练习册",
//     kind: "homework" | "play" | "rest" | "life",
//     minutes: 30,                      // 期望时长（求解器可压缩到 minMinutes）
//     minMinutes: 10,                   // 最少可接受时长（配合 splittable）
//     priority: 1..5,                   // 5 最重要；5 的任务不会被丢弃
//     splittable: true,                 // 是否允许切段（学习类默认 true）
//     fixed: false,                     // true = 时间锚点，不参与移动
//     window: { earliest, latest },     // 允许出现的时间窗
//     deadline: "17:30",                // 必须在此之前结束
//     prefer: { start, end },           // 孩子希望的时间段（软约束，用于加分）
//     locked: false                     // 锁定后求解器完全不改它
//   }]
// }
//
// ---------------------------------------------------------------------------
// 输出契约 PlanResult
// ---------------------------------------------------------------------------
// {
//   requestId, feasible, degraded, objective,
//   blocks: [{ id, sourceId, title, kind, start, end, minutes, splitIndex, preferenceHit, rationale }],
//   unscheduled: [{ id, title, reason, missingMinutes }],
//   metrics: { workPlanned, workScheduled, workUnscheduled, playPlanned, playScheduled, playShortfall, idleMinutes },
//   warnings: [string]
// }
//
// 评分（objective，越大越好）：
//   1000*安排成功 / 1000 + 3*作业完成分钟 + 1.5*娱乐分钟 + 尊重偏好 + 1*休息分钟 + 平衡项
// 也就是说：作业没排完先用娱乐分钟补洞（默认策略「先保证学习」），
// 只有连娱乐时间都不够时才会出现作业被丢弃。

const KIND_ORDER = ['homework', 'play', 'rest', 'life'];
const DEFAULT_FOCUS = 20;
const DEFAULT_REST_AFTER_WORK = 5;

const toMinutes = value => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
};
const fromMinutes = total => `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
const overlap = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;
const clampMinutes = (value, fallback) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.round(number));
};

function normalizeRequest(raw) {
  const start = toMinutes(raw?.horizon?.start);
  const end = toMinutes(raw?.horizon?.end);
  const warnings = [];
  if (start === null || end === null) throw new Error('horizon.start / horizon.end 必须是 HH:MM');
  if (end <= start) throw new Error('horizon.end 必须晚于 horizon.start');

  const prefs = raw?.preferences || {};
  const focusLimit = Math.max(5, Math.min(60, clampMinutes(prefs.focusLimitMinutes, DEFAULT_FOCUS)));
  const walkBreak = Math.max(0, Math.min(15, clampMinutes(prefs.walkBreakMinutes, DEFAULT_REST_AFTER_WORK)));
  const tasks = [];
  for (const item of Array.isArray(raw?.tasks) ? raw.tasks : []) {
    const minutes = clampMinutes(item?.minutes, 0);
    if (!item?.id || minutes <= 0) continue;
    const kind = KIND_ORDER.includes(item.kind) ? item.kind : 'life';
    const minMinutes = Math.max(0, Math.min(minutes, clampMinutes(item.minMinutes, Math.min(minutes, kind === 'homework' ? focusLimit : minutes))));
    const windowStart = toMinutes(item?.window?.earliest);
    const windowEnd = toMinutes(item?.window?.latest);
    const deadline = toMinutes(item?.deadline);
    const preferStart = toMinutes(item?.prefer?.start);
    const preferEnd = toMinutes(item?.prefer?.end);
    const fixed = item.fixed === true || item.locked === true;
    if (item.fixed === true && windowStart === null) warnings.push(`任务 ${item.id} 标了 fixed 但没给 window.earliest，已按普通任务处理`);
    tasks.push({
      id: String(item.id),
      title: String(item.title || item.id),
      kind,
      minutes,
      minMinutes,
      priority: Math.max(1, Math.min(5, clampMinutes(item.priority, 3))),
      splittable: item.splittable === true || (item.splittable === undefined && kind === 'homework'),
      anchored: fixed && windowStart !== null,
      locked: item.locked === true,
      earliest: windowStart ?? start,
      latest: windowEnd ?? end,
      deadline: deadline ?? null,
      prefer: preferStart !== null && preferEnd !== null && preferEnd > preferStart ? { start: preferStart, end: preferEnd } : null,
    });
  }
  // 点心/晚饭只作为"提醒"，不强行插块；真正的吃饭锚点由调用方作为 fixed 任务传进来，
  // 这样家长可以精确控制"18:30 钢琴课"这类硬约束。
  const dinnerStart = toMinutes(prefs.dinnerWindow?.[0]);
  const dinnerEnd = toMinutes(prefs.dinnerWindow?.[1]);
  const dinner = dinnerStart !== null && dinnerEnd !== null && dinnerEnd > dinnerStart ? { start: dinnerStart, end: dinnerEnd } : null;
  const snackTime = toMinutes(prefs.snackTime);

  return {
    requestId: raw?.requestId ? String(raw.requestId) : `plan-${start}-${end}`,
    start,
    end,
    horizon: end - start,
    focusLimit,
    walkBreak,
    maxPlayBlock: Math.max(10, Math.min(180, clampMinutes(prefs.maxPlayBlockMinutes, 60))),
    minRestBetweenPlay: Math.max(1, clampMinutes(prefs.minRestBetweenPlay, 1)),
    walkBreaks: prefs.walkBreaks !== false,
    windDown: Math.max(0, Math.min(60, clampMinutes(prefs.windDownMinutes, 20))),
    playGoal: Math.max(0, clampMinutes(raw?.playGoalMinutes, 60)),
    preferPlayAlign: prefs.preferPlayAlign !== false,
    dinner,
    snackTime,
    tasks,
    warnings,
  };
}

function buildWatch(kind, stepMinutes) {
  const watch = { [kind]: true };
  if (stepMinutes > 0) watch.rest = true;
  return watch;
}

// 连续学习段不超上限：把 homework 切成多段；其余类型只受"单个娱乐块上限"约束。
// 切法：先算段数，再把总时长尽量均分（大段在前），保证每段都在 [上限一半, 上限] 之间。
// 绝不能"切到剩多少算多少"，那样 45 分钟 + 上限 20 会切出 25 分钟的段（实测踩过）。
function splitHomework(minutes, focusLimit, walkBreak, item) {
  const events = [];
  const chunks = Math.max(1, Math.ceil(minutes / focusLimit));
  // 每段大小先定好（按能整段容纳的 5 分钟倍数），余数逐段加到前面的段上。
  // 这样既保证每段 ≤ 上限，总量也精确等于 minutes（两种取整方式都会踩坑，实测过）。
  const per = Math.floor(minutes / chunks / 5) * 5;
  let remainder = minutes - per * chunks;
  const sizes = [];
  for (let index = 0; index < chunks; index += 1) {
    const extra = remainder > 0 ? Math.min(5, remainder) : 0;
    remainder -= extra;
    sizes.push(Math.max(5, per + extra));
  }
  sizes.forEach((size, piece) => {
    events.push({ id: `${item.id}#${piece}`, sourceId: item.id, title: item.title, kind: 'homework', minutes: size, splitIndex: piece, splitCount: chunks, item });
    if (piece < chunks - 1 && walkBreak > 0) {
      // 注意 sourceId 必须是 null：自动休息属于"程序生成的安排"，
      // 带上任务 id 会被算进这个任务的时长（实测 45 分钟作业变成 55 分钟）。
      events.push({ id: `${item.id}#rest${piece + 1}`, sourceId: null, title: '起来活动一下', kind: 'rest', minutes: walkBreak, generated: true, auto: true, item });
    }
  });
  return events;
}

function buildSequence(item, focusLimit, walkBreak, maxPlayBlock) {
  const events = [];
  if (item.kind === 'homework') return splitHomework(item.minutes, focusLimit, walkBreak, item);
  let remaining = item.minutes;
  let piece = 0;
  while (remaining > 0) {
    const size = item.kind === 'play' ? Math.min(maxPlayBlock, remaining) : remaining;
    events.push({ id: `${item.id}#${piece}`, sourceId: item.id, title: item.title, kind: item.kind, minutes: size, splitIndex: piece, splitCount: item.kind === 'play' ? Math.ceil(item.minutes / maxPlayBlock) : 1, item });
    remaining -= size;
    piece += 1;
  }
  return events;
}

// 注意：这里统一只接收"任务"对象。事件对象请用 event.item 取出任务后再判断。
const isFixedItem = item => Boolean(item && (item.anchored || item.locked));
const isFixedEvent = event => isFixedItem(event && event.item);

// 尝试把顺序里的每个事件依次放进空档。约束：窗口、截止时间、相邻娱乐、固定锚点不可动。
function layout(context, order, { suffix = '' } = {}) {
  const { start, end, maxPlayBlock } = context;
  const fixed = context.tasks.filter(isFixedItem);
  const blocks = [];
  const dropped = [];
  let cursor = start;
  let playRun = 0;

  const busySpans = () => [
    ...fixed.map(item => ({ start: item.earliest, end: Math.min(item.earliest + item.minutes, end), item })),
    ...blocks.map(block => ({ start: block.start, end: block.end })),
  ];

  const nextFree = (from, duration, item) => {
    let probe = from;
    for (let guard = 0; guard < 40; guard += 1) {
      const spans = busySpans().sort((a, b) => a.start - b.start);
      const hit = spans.find(span => overlap(probe, probe + duration, span.start, span.end));
      if (!hit) return probe;
      probe = hit.end;
    }
    return null;
  };

  // 把一个事件放到时间轴上。关键：先判断"最少时长是否还有可能放下"，
  // 不可能就立即返回 null 让上层丢弃该任务——否则收缩循环会在原地打转（实测过死循环）。
  const place = (event, item) => {
    const minAllowed = Math.max(1, Math.min(item.minMinutes, event.minutes));
    const latestAllowed = () => {
      let bound = end;
      if (item.latest !== null) bound = Math.min(bound, item.latest);
      if (item.deadline !== null) bound = Math.min(bound, item.deadline);
      return bound;
    };
    const fits = (time, size) => time !== null && time + size <= latestAllowed();
    // 最早时间（时间窗下界）必须遵守：从 max(cursor, item.earliest) 开始找空档。
    const from = Math.max(cursor, item.earliest);

    let at = nextFree(from, event.minutes, item);
    let duration = event.minutes;
    // 当前位置连"最少时长"都放不下（例如已经越过截止时间）：试着往后挪一格，仍不行就放弃。
    if (!fits(at, minAllowed)) {
      at = nextFree(at === null ? from : at + 1, minAllowed, item);
      if (!fits(at, minAllowed)) return null;
      duration = minAllowed;
    }
    // 从当前位置往后找能放下当前时长的空档；放不下就按 5 分钟一档缩短，直到最少时长。
    let probe = at;
    while (!fits(probe, duration) && duration > minAllowed) {
      duration = Math.max(minAllowed, duration - 5);
      const next = nextFree(probe, duration, item);
      if (next === null) return null;
      probe = next;
    }
    if (!fits(probe, duration)) return null;
    return {
      id: `${event.id}${suffix}`,
      sourceId: event.sourceId,
      title: event.title,
      kind: event.kind,
      start: probe,
      end: probe + duration,
      minutes: duration,
      splitIndex: event.splitIndex,
      splitCount: event.splitCount,
      generated: event.generated === true,
      auto: event.auto === true,
      item,
    };
  };

  for (const event of order) {
    const item = event.item;
    if (isFixedItem(item)) continue; // 固定锚点从不参与布局，只当作障碍物
    if (event.kind === 'play') {
      if (playRun >= 1) {
        // 相邻娱乐规则：中间必须有非娱乐块。这里插一段短休息当间隔；实在插不进就丢弃这件娱乐。
        const fillerMinutes = Math.max(5, context.walkBreak);
        const fillerStart = nextFree(cursor, fillerMinutes, item);
        const fillerFits = fillerStart !== null
          && fillerStart + fillerMinutes <= end
          && (item.deadline === null || fillerStart + fillerMinutes <= item.deadline);
        if (fillerFits) {
          blocks.push({ id: `filler-${blocks.length}${suffix}`, sourceId: null, title: '休息一下，换换脑子', kind: 'rest', start: fillerStart, end: fillerStart + fillerMinutes, minutes: fillerMinutes, generated: true, auto: true, filler: true, item });
          cursor = fillerStart + fillerMinutes;
          playRun = 0;
        } else {
          dropped.push({ item, event, reason: '相邻娱乐需要间隔，当前没有空间' });
          continue;
        }
      }
      if (event.minutes > maxPlayBlock) event = { ...event, minutes: maxPlayBlock };
    }
    const placed = place(event, item);
    if (!placed) {
      dropped.push({ item, event, reason: item.deadline !== null ? '窗口内无法在截止时间前完成' : '排程窗口内放不下' });
      continue;
    }
    blocks.push(placed);
    cursor = placed.end;
    playRun = placed.kind === 'play' ? playRun + 1 : 0;
  }

  blocks.sort((a, b) => a.start - b.start);
  return { blocks, dropped };
}

// 检查是否踩到固定锚点、重叠、相邻娱乐——求解器自己产出的表必须过这一关。
function validate(context, blocks) {
  const errors = [];
  const sorted = [...blocks].sort((a, b) => a.start - b.start);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].start < sorted[index - 1].end) errors.push(`时间重叠：${sorted[index - 1].title} 与 ${sorted[index].title}`);
  }
  if (sorted.length && (sorted[0].start < context.start || sorted[sorted.length - 1].end > context.end)) errors.push('计划超出租期窗口');
  for (const item of context.tasks.filter(isFixedItem)) {
    const anchorEnd = Math.min(item.earliest + item.minutes, context.end);
    for (const block of sorted) {
      if (overlap(block.start, block.end, item.earliest, anchorEnd)) errors.push(`固定安排被占用：${item.title}`);
    }
  }
  let playRun = 0;
  for (const block of sorted) playRun = block.kind === 'play' ? playRun + 1 : 0;
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index].kind === 'play' && sorted[index - 1].kind === 'play') errors.push('出现相邻的两段娱乐');
  }
  for (const block of sorted) {
    const item = block.item;
    if (!item) continue;
    if (block.start < item.earliest) errors.push(`${item.title} 早于允许最早时间`);
    if (block.end > item.latest) errors.push(`${item.title} 晚于允许最晚时间`);
    if (item.deadline !== null && block.end > item.deadline) errors.push(`${item.title} 超过截止时间`);
  }
  return { ok: errors.length === 0, errors };
}

const preferenceRatio = (block, item) => {
  if (!item.prefer || item.kind !== 'play') return 0;
  const span = Math.min(block.end, item.prefer.end) - Math.max(block.start, item.prefer.start);
  return span <= 0 ? 0 : Math.min(1, span / block.minutes);
};

function scoreOf(context, blocks, dropped) {
  const planned = new Map();
  const scheduled = new Map();
  for (const item of context.tasks) {
    if (item.anchored) continue;
    planned.set(item.id, (planned.get(item.id) || 0) + item.minutes);
  }
  let respect = 0;
  let restMinutes = 0;
  for (const block of blocks) {
    if (block.sourceId && block.countsTowardSource !== false) scheduled.set(block.sourceId, (scheduled.get(block.sourceId) || 0) + block.minutes);
    if (block.kind === 'rest') restMinutes += block.minutes;
    respect += block.minutes * preferenceRatio(block, block.item);
  }
  let workPlanned = 0, workScheduled = 0, playPlanned = 0, playScheduled = 0, workUnscheduled = 0, workValue = 0;
  for (const item of context.tasks) {
    const want = planned.get(item.id) || 0;
    const got = Math.min(scheduled.get(item.id) || 0, want);
    if (item.kind === 'homework') {
      workPlanned += want;
      workScheduled += got;
      workUnscheduled += want - got;
      // 优先级越高，每分钟越值钱——时间不够时求解器自然先保重要的。
      workValue += got * (3 + item.priority * 2);
    } else if (item.kind === 'play') {
      playPlanned += want;
      playScheduled += got;
    }
  }
  let preferenceMiss = 0;
  for (const item of context.tasks) {
    if (item.kind !== 'play' || !item.prefer) continue;
    const want = planned.get(item.id) || 0;
    const got = Math.min(scheduled.get(item.id) || 0, want);
    const inWindow = blocks
      .filter(block => block.sourceId === item.id)
      .reduce((sum, block) => sum + (Math.min(block.end, item.prefer.end) - Math.max(block.start, item.prefer.start) > 0 ? block.minutes * preferenceRatio(block, block.item) : 0), 0);
    preferenceMiss += Math.max(0, got - inWindow);
  }
  // 休息必须"适度"：最多算学习时长的 20%（上限 20 分钟）。超出部分按 4 倍罚回去，
  // 否则求解器会为了多拿休息分不停切碎作业——这是实测踩到的坑。
  const restAllowance = Math.min(workScheduled * 0.2, 20);
  const restBonus = Math.min(restMinutes, restAllowance) - Math.max(0, restMinutes - restAllowance) * 4;
  const playShortfall = Math.max(0, context.playGoal - playScheduled);
  const objective =
    2 * workScheduled
    + workValue
    + 1.5 * playScheduled
    + respect
    - 8 * workUnscheduled
    - 1.5 * playShortfall
    - 3 * preferenceMiss
    + restBonus;
  return {
    objective: Math.round(objective * 100) / 100,
    metrics: {
      workPlanned, workScheduled, workUnscheduled,
      playPlanned, playScheduled, playShortfall,
      preferenceMiss: Math.round(preferenceMiss),
      respectMinutes: Math.round(respect),
      restMinutes,
    },
    droppedCount: dropped.length,
  };
}

function orderCandidates(context) {
  const flexible = context.tasks.filter(item => !isFixedItem(item));
  const sequences = new Map();
  const add = (label, items, options = {}) => {
    const order = [];
    for (const item of items) order.push(...buildSequence(item, options.focusLimit ?? context.focusLimit, options.walkBreak ?? context.walkBreak, options.maxPlayBlock ?? context.maxPlayBlock));
    sequences.set(label, order);
  };
  const byDeadline = [...flexible].sort((a, b) => ((a.deadline ?? a.latest) - (b.deadline ?? b.latest)) || (b.priority - a.priority));
  const byPriority = [...flexible].sort((a, b) => (b.priority - a.priority) || ((a.deadline ?? a.latest) - (b.deadline ?? b.latest)));
  const kindOf = kind => flexible.filter(item => item.kind === kind);
  const homework = byDeadline.filter(item => item.kind === 'homework');
  const play = byDeadline.filter(item => item.kind === 'play');
  const rest = byDeadline.filter(item => item.kind === 'rest');
  const life = byDeadline.filter(item => item.kind === 'life');

  add('deadline', byDeadline);
  add('priority', byPriority);
  add('kids-first', [...kindOf('play'), ...homework, ...rest, ...life]);
  add('life-first', [...life, ...homework, ...play, ...rest]);
  add('rest-first', [...rest, ...homework, ...play, ...life]);
  add('interleaved', interleave(homework, play, rest, life));
  // 偏好时间窗的任务优先排，避免被前面的任务挤走
  const preferred = [...flexible].sort((a, b) => (b.prefer ? 1 : 0) - (a.prefer ? 1 : 0) || (b.priority - a.priority));
  add('prefer-first', preferred);
  return sequences;
}

// 学习段之间插娱乐：把娱乐均匀分到学习段之间，天然满足"娱乐不相邻"。
function interleave(homework, play, rest, life) {
  const result = [];
  const workChunks = [];
  for (const item of homework) {
    let remaining = item.minutes;
    while (remaining > 0) {
      const size = Math.min(20, remaining);
      workChunks.push({ item, size });
      remaining -= size;
    }
  }
  const queue = [...play];
  workChunks.forEach((chunk, index) => {
    result.push(chunk.item);
    if (queue.length && (index % 2 === 1)) result.push(queue.shift());
  });
  result.push(...queue, ...rest, ...life);
  return [...new Set(result)];
}

function solve(rawRequest, options = {}) {
  const startedAt = Date.now();
  const context = normalizeRequest(rawRequest);
  const budgetMs = Math.max(20, clampMinutes(options.budgetMs, 400));
  const candidates = orderCandidates(context);
  const evaluated = [];
  for (const [label, order] of candidates) {
    const result = layout(context, order, { suffix: label === 'deadline' ? '' : `#${label}` });
    const score = scoreOf(context, result.blocks, result.dropped);
    evaluated.push({ label, order, ...result, ...score });
  }
  evaluated.sort((a, b) => b.objective - a.objective);
  let best = evaluated[0];

  const scoreOfOrder = order => {
    const result = layout(context, order);
    return { ...result, ...scoreOf(context, result.blocks, result.dropped) };
  };

  // 局部搜索：交换相邻两项 + 轮换，接受更优解。规模小，几百毫秒足够跑很多轮。
  let improved = true;
  let rounds = 0;
  while (improved && Date.now() - startedAt < budgetMs && rounds < 24) {
    improved = false;
    rounds += 1;
    const order = best.order;
    for (let index = 0; index + 1 < order.length; index += 1) {
      const swapped = [...order];
      [swapped[index], swapped[index + 1]] = [swapped[index + 1], swapped[index]];
      const candidate = scoreOfOrder(swapped);
      if (candidate.objective > best.objective + 1e-9) {
        best = { label: `${best.label}-swap`, order: swapped, ...candidate };
        improved = true;
      }
      if (Date.now() - startedAt >= budgetMs) break;
    }
    if (Date.now() - startedAt >= budgetMs) break;
    // 轮换（把后半段挪到前面）
    const pivot = Math.max(1, Math.floor(order.length / 2));
    const rotated = [...order.slice(pivot), ...order.slice(0, pivot)];
    const rotatedResult = scoreOfOrder(rotated);
    if (rotatedResult.objective > best.objective + 1e-9) {
      best = { label: `${best.label}-rotate`, order: rotated, ...rotatedResult };
      improved = true;
    }
  }

  const blocks = best.blocks.map(block => ({
    id: block.id,
    sourceId: block.sourceId,
    title: block.title,
    kind: block.kind,
    start: fromMinutes(block.start),
    end: fromMinutes(block.end),
    minutes: block.minutes,
    startMinutes: block.start,
    splitIndex: block.splitIndex,
    splitCount: block.splitCount,
    auto: block.auto === true,
    fixed: block.item ? isFixedEvent(block.item) : false,
    preferenceHit: block.item ? preferenceRatio(block, block.item) : 0,
    rationale: block.item?.deadline !== null && block.item && block.end === block.item.deadline
      ? '排在截止时间前'
      : block.kind === 'homework' ? '学习时段，段长受专注上限约束' : block.kind === 'play' ? '娱乐时段' : '休息/生活安排',
  }));

  const anchors = context.tasks.filter(isFixedItem).map(item => ({
    id: item.id,
    sourceId: item.id,
    title: item.title,
    kind: item.kind,
    start: fromMinutes(item.earliest),
    end: fromMinutes(Math.min(item.earliest + item.minutes, context.end)),
    minutes: item.minutes,
    startMinutes: item.earliest,
    fixed: true,
    auto: false,
    preferenceHit: 0,
    rationale: '固定安排，求解器不移动',
  }));

  const allBlocks = [...blocks, ...anchors].sort((a, b) => a.startMinutes - b.startMinutes);
  const validation = validate(context, allBlocks);
  const scheduledBySource = new Map();
  for (const block of allBlocks) {
    if (!block.sourceId || block.countsTowardSource === false) continue;
    scheduledBySource.set(block.sourceId, (scheduledBySource.get(block.sourceId) || 0) + block.minutes);
  }
  const unscheduled = [];
  for (const item of context.tasks) {
    if (isFixedItem(item)) continue;
    const want = item.minutes;
    const got = Math.min(scheduledBySource.get(item.id) || 0, want);
    if (got >= want) continue;
    const reason = item.deadline !== null
      ? `在 ${fromMinutes(item.deadline)} 前只排进 ${got} 分钟`
      : `窗口内只排进 ${got} 分钟`;
    unscheduled.push({ id: item.id, title: item.title, kind: item.kind, reason, missingMinutes: want - got });
  }
  const busy = allBlocks.reduce((sum, block) => sum + block.minutes, 0);
  const idle = Math.max(0, context.horizon - busy);
  const workUnscheduled = unscheduled.filter(item => item.kind === 'homework').reduce((sum, item) => sum + item.missingMinutes, 0);
  const warnings = [...context.warnings];
  if (!validation.ok) warnings.push(...validation.errors.map(error => `内部校验：${error}`));
  if (idle > 0) warnings.push(`窗口内还有 ${idle} 分钟空档`);

  return {
    requestId: context.requestId,
    feasible: workUnscheduled === 0,
    degraded: workUnscheduled > 0,
    solver: { name: 'greedy+local-search', strategy: best.label, candidates: evaluated.length, rounds, elapsedMs: Date.now() - startedAt },
    objective: best.objective,
    blocks: allBlocks,
    unscheduled,
    metrics: {
      ...best.metrics,
      horizonMinutes: context.horizon,
      busyMinutes: busy,
      idleMinutes: idle,
      homeworkDroppedMinutes: workUnscheduled,
    },
    validation,
    warnings,
  };
}

export { solve, normalizeRequest, layout, validate, scoreOf, fromMinutes, toMinutes };
