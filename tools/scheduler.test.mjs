// 排程求解器测试：每个用例验证一条硬约束或一条目标函数行为，全部跑真代码。
import { solve, toMinutes, fromMinutes } from '../scheduler.mjs';

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail });
}
const sum = (blocks, predicate = () => true) => blocks.filter(predicate).reduce((total, block) => total + block.minutes, 0);
const byKind = (result, kind) => result.blocks.filter(block => block.kind === kind);
const onTimeline = (result, id) => sum(result.blocks.filter(block => block.sourceId === id));
const overlapsAny = blocks => {
  const sorted = [...blocks].sort((a, b) => a.startMinutes - b.startMinutes);
  for (let i = 1; i < sorted.length; i += 1) if (sorted[i].startMinutes < sorted[i - 1].startMinutes + sorted[i - 1].minutes) return true;
  return false;
};

const base = {
  horizon: { start: '16:00', end: '21:00' },
  preferences: { focusLimitMinutes: 20, walkBreakMinutes: 5, dinnerWindow: ['18:00', '19:00'], windDownMinutes: 20 },
  playGoalMinutes: 90,
};

// ---- 1. 基本布置：学习分段、娱乐不超单块上限、总时间不超窗口 ----
const basic = solve({
  ...base,
  tasks: [
    { id: 'w1', title: '完成数学练习册', kind: 'homework', minutes: 45, priority: 4 },
    { id: 'w2', title: '读语文课文', kind: 'homework', minutes: 20, priority: 3 },
    { id: 'p1', title: '玩 Minecraft', kind: 'play', minutes: 60, priority: 3, prefer: { start: '17:00', end: '19:00' } },
    { id: 'r1', title: '休息', kind: 'rest', minutes: 10, priority: 2 },
  ],
}, { budgetMs: 300 });

check('求解成功且校验通过', basic.validation.ok && basic.validation.errors.length === 0, JSON.stringify(basic.validation.errors));
check('没有时间重叠', !overlapsAny(basic.blocks));
check('全部安排在窗口内', basic.blocks.every(b => toMinutes(b.start) >= toMinutes('16:00') && toMinutes(b.end) <= toMinutes('21:00')));
check('学习段不超专注上限 20 分钟', byKind(basic, 'homework').every(b => b.minutes <= 20), JSON.stringify(byKind(basic, 'homework').map(b => b.minutes)));
check('45 分钟作业被拆成 3 段', byKind(basic, 'homework').filter(b => b.sourceId === 'w1').length === 3);
check('作业时长完整保留', onTimeline(basic, 'w1') === 45 && onTimeline(basic, 'w2') === 20);
check('单个娱乐块不超 60 分钟', byKind(basic, 'play').every(b => b.minutes <= 60));
check('没有相邻娱乐块', !basic.blocks.some((b, i) => i > 0 && b.kind === 'play' && basic.blocks[i - 1].kind === 'play'));
check('学习段落之间有休息', basic.blocks.some(b => b.kind === 'rest' && b.auto));

// ---- 2. 硬截止时间：必须在此之前结束 ----
const deadline = solve({
  ...base,
  tasks: [
    { id: 'w1', title: '完成数学练习册', kind: 'homework', minutes: 40, priority: 5, deadline: '17:00' },
    { id: 'p1', title: '玩游戏', kind: 'play', minutes: 60, priority: 2 },
  ],
}, { budgetMs: 300 });
check('截止时间被满足（17:00 前完成 40 分钟作业）', onTimeline(deadline, 'w1') === 40 && deadline.blocks.filter(b => b.sourceId === 'w1').every(b => toMinutes(b.end) <= toMinutes('17:00')), JSON.stringify(deadline.blocks.filter(b => b.sourceId === 'w1').map(b => `${b.start}-${b.end}`)));
check('截止时间同一次求解有记录', deadline.unscheduled.length === 0);

// ---- 3. 时间不够时：先保学习，娱乐被牺牲 ----
const tight = solve({
  ...base,
  horizon: { start: '20:00', end: '21:00' },
  preferences: { focusLimitMinutes: 20, walkBreakMinutes: 5, windDownMinutes: 0 },
  tasks: [
    { id: 'w1', title: '完成数学练习册', kind: 'homework', minutes: 40, priority: 5 },
    { id: 'p1', title: '玩游戏', kind: 'play', minutes: 60, priority: 1 },
  ],
}, { budgetMs: 300 });
check('时间紧张时作业被排进去', onTimeline(tight, 'w1') >= 30, `实际 ${onTimeline(tight, 'w1')}`);
check('时间紧张时娱乐被压缩或丢弃', onTimeline(tight, 'p1') < 60, `实际 ${onTimeline(tight, 'p1')}`);
check('总占用不超窗口', sum(tight.blocks) <= 60, `实际 ${sum(tight.blocks)}`);

// ---- 4. 固定安排（18:30 钢琴课）不可被占用 ----
const anchored = solve({
  ...base,
  tasks: [
    { id: 'piano', title: '钢琴课', kind: 'life', minutes: 45, priority: 5, fixed: true, window: { earliest: '18:30' } },
    { id: 'w1', title: '完成数学练习册', kind: 'homework', minutes: 45, priority: 4 },
    { id: 'p1', title: '玩 Minecraft', kind: 'play', minutes: 45, priority: 3 },
  ],
}, { budgetMs: 300 });
const piano = anchored.blocks.find(b => b.sourceId === 'piano');
const clashes = anchored.blocks.filter(b => b.sourceId !== 'piano' && toMinutes(b.start) < toMinutes(piano.end) && toMinutes(piano.start) < toMinutes(b.end));
check('固定安排的起止时间被保留', piano.start === '18:30' && piano.minutes === 45, `${piano.start}-${piano.end}`);
check('没有任务与固定安排重叠', clashes.length === 0, JSON.stringify(clashes.map(b => b.title)));
check('固定安排不会重复出现', anchored.blocks.filter(b => b.sourceId === 'piano').length === 1);

// ---- 5. 孩子偏好：希望在 17:00-18:00 玩 ----
const prefer = solve({
  ...base,
  tasks: [
    { id: 'w1', title: '完成数学练习册', kind: 'homework', minutes: 60, priority: 4 },
    { id: 'w2', title: '读课文', kind: 'homework', minutes: 40, priority: 3 },
    { id: 'p1', title: '玩 Minecraft', kind: 'play', minutes: 45, priority: 3, prefer: { start: '16:00', end: '17:00' } },
  ],
}, { budgetMs: 300 });
const playBlocks = byKind(prefer, 'play');
const inWindow = playBlocks.filter(b => toMinutes(b.start) < toMinutes('17:00')).reduce((total, b) => total + b.minutes, 0);
check('娱乐被优先放在孩子希望的时段', inWindow >= 30, `窗内 ${inWindow} 分钟，共 ${sum(playBlocks)} 分钟，位置 ${playBlocks.map(b => b.start).join(',')}`);

// ---- 6. 时间窗
const windowed = solve({
  ...base,
  tasks: [
    { id: 'w1', title: '数学作业', kind: 'homework', minutes: 40, priority: 4, window: { earliest: '19:00' } },
    { id: 'p1', title: '玩游戏', kind: 'play', minutes: 30, priority: 3 },
  ],
}, { budgetMs: 300 });
check('任务不早于允许最早时间', windowed.blocks.filter(b => b.sourceId === 'w1').every(b => toMinutes(b.start) >= toMinutes('19:00')), JSON.stringify(windowed.blocks.filter(b => b.sourceId === 'w1').map(b => b.start)));

// ---- 7. 界面传入的既有计划也能排（兼容旧数据）----
const legacy = solve({
  horizon: { start: '17:00', end: '20:00' },
  preferences: { focusLimitMinutes: 20 },
  tasks: [
    { id: 'a', title: '语文作业', kind: 'homework', minutes: 30 },
    { id: 'b', title: '看课外书', kind: 'play', minutes: 30 },
    { id: 'c', title: '休息', kind: 'rest', minutes: 10 },
  ],
}, { budgetMs: 200 });
check('缺省字段也能排（priority/splittable 未给）', legacy.validation.ok && legacy.blocks.length >= 3, JSON.stringify(legacy.warnings));

// ---- 8. 求解器速度 ----
const many = solve({
  ...base,
  tasks: Array.from({ length: 16 }, (_, i) => ({
    id: `t${i}`,
    title: `任务${i}`,
    kind: i % 4 === 0 ? 'play' : 'homework',
    minutes: 20 + (i % 3) * 10,
    priority: (i % 5) + 1,
    prefer: i % 4 === 0 ? { start: '17:00', end: '19:00' } : undefined,
  })),
}, { budgetMs: 400 });
check('16 个任务在 1 秒内求解完', many.solver.elapsedMs < 1000, `耗时 ${many.solver.elapsedMs} ms`);
check('16 个任务的结果通过校验', many.validation.ok, JSON.stringify(many.validation.errors));

// ---- 9. 输入校验 ----
let threw = false;
try { solve({ horizon: { start: 'bad', end: '21:00' }, tasks: [] }); } catch { threw = true; }
check('非法时间格式会报错而不是静默出错', threw);
const empty = solve({ horizon: { start: '16:00', end: '17:00' }, tasks: [] });
check('空任务清单返回空计划且不崩', empty.blocks.length === 0 && empty.feasible);

console.log(checks.map(c => `${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.ok || !c.detail ? '' : `\n        ${c.detail}`}`).join('\n'));
const failed = checks.filter(c => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} 通过`);
if (failed) {
  console.log('\n失败用例的完整结果：');
  console.log(JSON.stringify({ basic: basic.blocks.map(b => `${b.start}-${b.end} ${b.kind} ${b.title}${b.auto ? '(自动)' : ''}`), tight: tight.blocks.map(b => `${b.start}-${b.end} ${b.kind} ${b.title}`) }, null, 2));
}
process.exit(failed ? 1 : 0);
