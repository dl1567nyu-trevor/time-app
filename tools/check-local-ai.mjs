// 本地模型校准：对同一个本地模型跑一组真实孩子输入，打印识别结果和耗时。
//
// 用法（先启动本地模型和应用服务）：
//   node tools/check-local-ai.mjs
//   node tools/check-local-ai.mjs --url http://127.0.0.1:4173
//
// 换一个 gguf 模型后跑一遍，就能看出这个模型值不值得用：学科是否填错、
// 连写的多项作业有没有拆开、显式说的时长有没有被采纳。

const args = process.argv.slice(2);
const urlIndex = args.indexOf('--url');
const base = urlIndex >= 0 ? args[urlIndex + 1] : (process.env.APP_URL || 'http://127.0.0.1:4173');

const cases = [
  {
    name: '连写的多项英语作业（最难的一类）',
    text: '英语有4项作业，复p23~24页 2背p26 3完成p23~29页，听读p28~30页。数学口算两页。',
    checks: [
      { label: '英语作业拆成 4 条', ok: ts => ts.filter(t => t.subject === '英语').length === 4 },
      { label: '标题保留页码', ok: ts => ts.filter(t => /p\d/.test(t.title)).length >= 3 },
      { label: '全部归为 homework', ok: ts => ts.every(t => t.kind === 'homework') },
    ],
  },
  {
    name: '明显有学科和显式时长',
    text: '数学预习第40-41页20分钟，语文背古诗15分钟，户外运动40分钟。',
    checks: [
      { label: '数学=20 分钟', ok: ts => ts.some(t => t.subject === '数学' && t.minutes === 20) },
      { label: '语文=15 分钟', ok: ts => ts.some(t => t.subject === '语文' && t.minutes === 15) },
      { label: '运动归为 play', ok: ts => ts.some(t => t.kind === 'play' && t.minutes === 40) },
    ],
  },
  {
    name: '娱乐与休息',
    text: '我想玩半小时 Minecraft，看一会儿课外书，休息10分钟，然后洗澡刷牙。',
    checks: [
      { label: 'Minecraft 是 play', ok: ts => ts.some(t => /Minecraft/i.test(t.title) && t.kind === 'play') },
      { label: '看课外书是 play', ok: ts => ts.some(t => /课外书/.test(t.title) && t.kind === 'play') },
      { label: '休息是 rest', ok: ts => ts.some(t => t.kind === 'rest') },
      { label: '学习类任务没有凭空多出来', ok: ts => ts.filter(t => t.kind === 'homework').length <= 1 },
    ],
  },
];

// 所有用例都适用的通用检查：娱乐/休息/生活类任务不该有学科。
// 小模型很爱在这里出错（把"玩 Minecraft"标成音乐、"洗澡刷牙"标成信息技术），前端虽然能改，但错得越多越费家长时间。
const commonChecks = [
  { label: '娱乐/休息/生活类任务没有乱填学科', ok: ts => ts.filter(t => t.kind !== 'homework').every(t => !t.subject) },
];

const results = [];
for (const testCase of cases) {
  const started = Date.now();
  let status = 0, tasks = [], error = null;
  try {
    const response = await fetch(`${base}/api/recognize-tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: testCase.text }),
      signal: AbortSignal.timeout(180_000),
    });
    status = response.status;
    const data = await response.json();
    if (data.error) error = data.error;
    tasks = data.tasks || [];
  } catch (caught) {
    error = caught.message;
  }
  results.push({ ...testCase, checks: [...testCase.checks, ...commonChecks], ms: Date.now() - started, status, tasks, error });
}

const lines = [];
for (const result of results) {
  lines.push('');
  lines.push(`▌${result.name}   ${result.ms} ms   status=${result.status}   ${result.tasks.length} 条任务`);
  lines.push(`   输入：${result.text}`);
  if (result.error) lines.push(`   ⚠️ 接口返回错误：${result.error}`);
  for (const task of result.tasks) {
    lines.push(`   · [${task.kind}] ${task.minutes} 分钟  subject="${task.subject}"  ${task.title}`);
  }
  for (const check of result.checks) {
    const pass = result.tasks.length > 0 && check.ok(result.tasks);
    lines.push(`   ${pass ? '✅' : '❌'} ${check.label}`);
  }
}

const total = results.reduce((sum, result) => sum + result.ms, 0);
const failed = results.flatMap(result => result.checks.map(check => ({ result, check })))
  .filter(({ result, check }) => !(result.tasks.length > 0 && check.ok(result.tasks)));
lines.push('');
lines.push(`合计 ${results.length} 次识别，平均 ${Math.round(total / results.length)} ms/次；${failed.length ? `${failed.length} 项检查未通过` : '全部检查通过'}`);
lines.push('提示：学科填错、多项作业被合并、显式时长被忽略，都属于小模型的常见失败，换更大的模型或继续用云端模型更稳。');
console.log(lines.join('\n'));
process.exit(failed.length ? 1 : 0);
