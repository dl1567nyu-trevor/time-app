# 放学啦 · 时间小计划（本地 AI 识别原型）

本地网页通过 Node.js 服务端做任务抽取：默认调用 DeepSeek Chat Completions API，也可以切换为 OpenAI Responses API，或者切换到**完全跑在本机的本地模型**（llama.cpp + Vulkan GPU 加速），让孩子的输入不离开这台电脑。API 密钥只保存在服务端 `.env`，不会放进网页源码。模型返回任务后，页面仍会让用户校对学科、任务类别和时长；识别可以打字也可以**语音输入**；接口不可用时会回退到浏览器内置识别规则。

## 启动

### 方式一：双击启动（推荐，本机已配置好）

在访达里双击 **`启动.command`**。脚本会自动找到 Node、启动服务、并打开浏览器页面。

- 想停止服务：关闭那个终端窗口，或按 `Control + C`。
- 如果服务已经在运行，重复双击会直接打开页面，不会重复启动。

### 方式二：命令行启动

1. 安装 Node.js 18 或更新版本（本机已装 `Node v24.21.0` 到 `~/.local/node`，新开终端即可直接用 `node`）。
2. 在 DeepSeek 开放平台创建 API 密钥，并确认 API 账户可用。
3. 将 `.env.example` 复制为 `.env`，保留 `AI_PROVIDER=deepseek`，把 `DEEPSEEK_API_KEY` 改成自己的密钥。不要把 `.env` 分享或提交到 Git。
4. 在项目目录运行 `npm start`（或 `node server.mjs`）。
5. 打开终端显示的本地地址，默认是 `http://127.0.0.1:4173`。请使用这个地址访问网页；直接双击 `index.html` 会走本地识别回退。

> 本机 Node 的安装位置与查找逻辑见 `shared/node-path.sh`：优先用 `~/.local/node/bin/node`，找不到时依次回退到 Homebrew、nvm 以及其他应用内置的运行时，所以即使 `~/.local/node` 被删除，启动脚本仍会尽力找到可用的 Node。

默认模型是 `deepseek-flash`，可在 `.env` 中设置 `DEEPSEEK_MODEL`。DeepSeek 模式使用 JSON Output（DeepSeek 只支持 `json_object`，不支持 `json_schema`，所以必须保留服务端结构校验），并在服务端校验返回结构。切换 OpenAI 时设置 `AI_PROVIDER=openai`、`OPENAI_API_KEY` 和可选的 `OPENAI_MODEL`。服务只监听本机回环地址，适合个人本地原型，不是公开部署配置。

### 速度：默认已关闭思考模式

DeepSeek 的思考模式**默认开启**，而 `reasoning_effort` 只控制思考"深度"、不等于关闭——所以只设 `low` 仍然会白等一大段思维链。本任务是抽取和归类，不需要多步推理，代码默认带上 `thinking: { type: 'disabled' }`。实测同一句话：

| | 输出 token | 其中思考 | 长输入 | 整条链路耗时 |
| --- | --- | --- | --- | --- |
| 思考模式（旧默认） | 1558 | 1460 | 曾出现 `finish=length`、JSON 为空 | 短 5.8–6.5 s / 长 14.7 s |
| **关闭思考（现默认）** | **95** | **0** | 正常返回 10+ 条任务 | **短 0.8–1.1 s / 长 2.0–2.3 s** |

也就是**约 6 倍提速，且质量不退化**，同时省掉 90% 以上的输出 token（＝省费用）。需要模型"想清楚"时，在 `.env` 里设 `DEEPSEEK_THINKING=enabled` 即可恢复。

提示词缓存也在起作用：服务端提示词固定不变，实测每次请求有 384/592 的 prompt token 命中缓存（`prompt_cache_hit_tokens`），这部分不计费也更快，所以**不要随便改动系统提示词的措辞**。

暂时没做流式输出（streaming）：实测首屏只从 1.5–2.1 秒提前到 0.7–1.2 秒，而整体已经是 1–2 秒量级，收益不足以抵消实现复杂度。若以后要再压，可考虑：① 简单输入先用浏览器内置解析器秒出结果、AI 结果到了再覆盖；② 输入停顿 600 ms 后自动识别，省掉一次点击。若孩子一次输入很多任务被提示“输入内容较多”，可调大 `.env` 里的 `DEEPSEEK_MAX_TOKENS`，或把任务分成两三次识别。模型偶发返回空内容或格式错误时，服务会自动重试一次（本地模型不重试，避免让孩子多等一倍时间）。

## 排程：大模型理解需求，求解器分配时间

> 想知道"为什么这么设计"、完整实测数据与选型对比，看 [docs/technical-report.md](docs/technical-report.md)（技术报告）。

排程**不交给大模型**。大模型只做"听懂孩子的话 → 任务清单"，时间分配由 [scheduler.mjs](scheduler.mjs) 在本机用「多起点贪心 + 局部搜索」求解：

```powershell
npm run ai:check        # 本地模型校准（可选）
npm run plan:test       # 排程求解器 24 项约束断言
```

- 输入/输出 JSON 契约、约束清单、评分公式、换 OR-Tools 的时机：见 [docs/schedule-contract.md](docs/schedule-contract.md)
- 求解是纯计算：**3–60 ms，零 API 额度**，同一输入永远给同一张表，可以写单元测试
- 硬约束（求解器自检，`validation.ok` 会报错）：不重叠、不超窗口、不动固定安排、不越过截止时间、两段娱乐不相邻
- 软约束（体现在评分里）：作业优先、优先级高的先保、娱乐尽量满足目标量、尊重孩子的偏好时段、休息适度

页面上的用法没变：说一句话 → 校对 → 生成安排。但"生成安排"这一步现在会带上 `priority / deadline / splittable`（由模型读出、正则兜底），并把晚饭、睡前洗漱、以及你用弹窗里"这个时间不能动"加进来的事项作为**固定锚点**一起交给求解器。填不下的任务不会被静默丢弃，会带着原因显示在提示里。

### 为什么不用 OR-Tools / Timefold

对比过，结论是先不用，理由是可验证的而不是感觉：

| | [OR-Tools](https://developers.google.com/optimization) CP-SAT（基线已写在 `tools/ortools_plan.py`） | 本项目 Node 求解器 |
| --- | --- | --- |
| 本机可行性 | Python 有 `cp313` wheel（22.8 MB），需装 pip 包 | ✅ 零依赖，仍是"一个 `node server.mjs` 就跑" |
| 同一份输入（6 个任务） | OPTIMAL，12.9 ms | 校验通过，**3 ms** |
| 娱乐不相邻 | ❌ 需额外建模，默认会把两段娱乐贴在一起 | ✅ 原生保证 |
| 最小段长（防切碎） | ❌ 会切出 5 分钟的碎片 | ✅ 每段 ≥ 专注上限一半 |
| 结果质量 | 作业 60/60、娱乐 60 分钟，但浪费 25 分钟空档 | 作业 60/60、娱乐 60 分钟，排得更紧 |
| 何时值得换 | 任务上到几百个、跨天排程、需要最优性证明 | 单孩子单天 10–20 个任务远在舒适区 |

Timefold / OptaPlanner 是 Java 生态（本机没有 JDK，需要额外运行时），[Timefold](https://github.com/TimefoldAI/timefold-solver) 1.8k star、OptaPlanner 已转入维护，都不适合这个规模。契约已经定死，真要换只需改 `server.mjs` 里 `/api/plan` 的实现，前端和接口不动。

## 语音输入

输入框下面的 **🎤 说话输入** 用浏览器自带的语音识别（Web Speech API）把话转成文字，实时显示“听到：…”，定稿后追加到输入框，**不会自动提交**，孩子说完可以看一眼再点“识别任务”。同一轮里的多句话之间会自动加逗号，重复回传的识别结果不会重复写入。

- 需要 Chrome 或 Edge（Firefox 不支持这个 API）；页面必须通过 `http://127.0.0.1:4173` 访问，直接双击 `index.html` 拿不到麦克风权限。
- 第一次使用浏览器会问麦克风权限；拒绝了会提示怎么在地址栏重新打开。
- ⚠️ **语音这件事不能算"本地"**：Chrome/Edge 的中文识别把音频送到浏览器厂商的服务器处理，只有识别后的文字会在本机被本地模型处理。如果连音频也不许出本机，需要另起一条本地转写链路（`whisper.cpp`、`faster-whisper` 或 `SenseVoice` 起一个 HTTP 转写接口，再由 Node 服务代理），本仓库没有内置。

## 本地模型（可选，只建议为了隐私/断网时用）

> **先看这一句**：如果你要的是速度，就用 DeepSeek 云端，不要上本地模型。云端实测 1–2 s/次，本机推理 10–33 s/次，快慢差 5–15 倍；本地方案的价值只在于"输入不离开这台电脑"和"断网也能用"。

不需要联网、不需要 API 密钥，输入全程不出本机。已在本机验证可用：Intel Arc 130T 核显走 Vulkan 后端（`KHR_coopmat` 矩阵核心），4B 模型预填充约 357 tok/s、生成约 17 tok/s。

### 三步跑起来

```powershell
npm run ai:local        # 1. 启动本地模型服务（llama.cpp，默认端口 8080，窗口保持开着）
npm run start:local     # 2. 启动网页服务并强制使用本地模型（等价于 node server.mjs --local）
npm run ai:check        # 3.（可选）跑校准用例，看看当前模型是否靠谱
```

网页右上角的状态点会显示当前用的是“本地模型 / DeepSeek / OpenAI”：绿点表示就绪，红点表示本地模型没启动或云端没配密钥，点一下可以重新检测。

### 模型怎么选

本机实测（同一套输入、5 个用例）：

| 模型 | 大小 | 速度 | 质量 |
| --- | --- | --- | --- |
| Qwen3-0.6B Q8_0 | 610 MB | 9–15 s/次 | ❌ 不可用：学科被填成 `play`/`homework`，连写作业合并成 1 条 |
| Qwen3-1.7B Q8_0 | 1.7 GB | 9–14 s/次 | ⚠️ 不稳定：4 项英语作业能拆对，但会给娱乐/休息任务乱填学科（Minecraft→音乐） |
| Qwen3-4B Q4_K_M | 2.4 GB | 11–33 s/次 | ✅ 推荐：学科、分类、时长分档全部正确，页码能保留 |

云端 `deepseek-flash`（已关闭思考模式）同样输入是 **1–2 s/次**，质量最好。**所以本地模型的代价是慢 5–15 倍并且更易出错，换来的是隐私和离线可用**——按孩子的隐私要求来选，而不是按速度选。只想要速度就用云端，不要为了速度上本地模型。

### 两个必须知道的坑

1. **思维链会吃掉全部 token**：Qwen3 这类混合推理模型默认先写一大段思考，4B 模型实测 70 秒、1024 tokens 全用在思考上，最终 JSON 为空、接口报“输入内容较多”。服务端已经在本地请求里带上 `chat_template_kwargs: { enable_thinking: false }`，从 70 秒降到 12 秒。换别的推理型模型时如果又出现空结果，先看这个开关。
2. **小模型会照抄提示词里的例子**：提示词里给具体范例（比如 `"复p23-24页"`）会让 1.7B/4B 把范例内容混进结果、甚至编出原话里没有的书名。本地提示词只讲规则和字段写法，不给可直接抄的例子。

### 模型文件放哪里

放到 `tools\models\`，`tools\start-local-ai.ps1` 会按 `Qwen3-4B-Q4_K_M.gguf` → `Qwen3-1.7B-Q4_K_M.gguf` → `Qwen3-0.6B-Q4_K_M.gguf` 的顺序自动挑第一个存在的，也可以用 `-Model` 指定任意 gguf 路径。脚本参数：`-Model`、`-Port`、`-Ctx`、`-Cpu`（强制 CPU 推理）。

本机实测的下载源（国内直连 Hugging Face 会超时，用这两个镜像）：

- 模型（ModelScope，实测 5.5–6.3 MB/s）：`https://modelscope.cn/models/Qwen/Qwen3-4B-GGUF/resolve/master/Qwen3-4B-Q4_K_M.gguf`
- 推理引擎（llama.cpp 官方 Windows Vulkan 预编译包，GitHub 直连只有 19 KB/s，走代理约 1 MB/s）：`https://ghfast.top/https://github.com/ggml-org/llama.cpp/releases/download/b11429/llama-b11429-bin-win-vulkan-x64.zip`

`llama-server` 的接口是 OpenAI 兼容的，所以换成 Ollama、LM Studio、vLLM 时只要改 `.env` 里的 `LOCAL_AI_BASE_URL` 和 `LOCAL_AI_MODEL` 就能接上，不用改代码。

### 相关配置（`.env`）

```ini
AI_PROVIDER=local
LOCAL_AI_BASE_URL=http://127.0.0.1:8080/v1
LOCAL_AI_MODEL=local
LOCAL_AI_TIMEOUT_MS=120000
LOCAL_AI_MAX_TOKENS=1024
```

本地模式不需要 API 密钥。服务端还会对本地结果做归一化：把占位学科（“空字符串”“无”之类）和填错的 kind 值清空，并裁短过长的 `source`，让校对表干净一些。

## 部署到 GitHub 之前必须知道的事

这个项目现在是**"本地服务 + 浏览器网页"**两个部分，而 GitHub Pages 只能托管**静态文件**，它不会运行 `server.mjs`。所以"传到 GitHub"有两种完全不同的做法：

| | 现在（本机） | 传到 GitHub Pages（静态） |
| --- | --- | --- |
| 谁调用模型 API | Node 服务（密钥在服务端 `.env`） | 只能用浏览器直接调 |
| **API 密钥** | **不出现在网页里** | **必须写进网页源码，任何人都能看到并盗用** |
| 孩子输入的去向 | 你的电脑 → 模型服务 | 访客浏览器 → 模型服务（你不经手） |
| 结果结构校验、`subject` 纠错、裁剪 | 服务端有 | 没有，模型返回什么就是什么 |
| 语音输入 | 需要 `http://127.0.0.1` 或 HTTPS | HTTPS 满足，可直接用 |
| 数据存储 | 各浏览器 `localStorage` | 同样是各浏览器 `localStorage` |
| 谁的孩子在用 | 只有你 | 全网任何人 |

**结论：不要把这个仓库开成 GitHub Pages 直接对外用。** 主要理由不是技术，而是两条：

1. **密钥会被盗**：静态页面里的 API 密钥等于公开。要么把密钥删掉、改为让每个访客自己填自己的密钥（存 localStorage），要么把服务端部署到能保密的平台（Vercel / Cloudflare Workers / 自有服务器），让网页只调你自己的后端。
2. **这个项目会引导填孩子的信息**：页面本身就是给孩子记录作业、学校作息用的，公开托管意味着陌生人会把真实姓名、学校、住址输进去，再经你的密钥发到模型服务。原设计特意提示"不要输入身份信息"，公开部署会削弱这层保护。

**推荐做法：GitHub 当代码仓库用（可选公开 + 写清 License），需要分享时让别人 `git clone` 后在本机 `npm start`。** 如果确实想要一个联网可访问的版本，最小改造是：删掉页面里所有密钥逻辑 → 加一个"填入你自己的 DeepSeek Key"的输入框（只存本地）→ 加隐私提示与输入长度限制 → 部署到 GitHub Pages。需要的话可以按这个方案改。

## 数据说明

点击“识别任务”后，输入的任务文字会发送到本机服务，再由服务转发给配置的模型服务处理。使用 `AI_PROVIDER=local` 时，文字只会到本机的 `llama-server`，不出这台电脑；使用云端模型时，请勿输入孩子姓名、学校、住址等身份信息。语音输入的文字由浏览器语音识别产生（音频会经浏览器厂商服务器），本机只接收识别后的文字。模型识别可能出错，生成计划前请检查并修改结果。此示例不存储识别请求日志；模型平台的数据处理仍按对应账户和服务政策执行。
