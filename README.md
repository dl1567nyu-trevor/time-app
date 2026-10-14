# 放学啦 · 时间小计划（本地 AI 识别原型）

本地网页通过 Node.js 服务端调用 DeepSeek Chat Completions API 做任务抽取，也可以切换为 OpenAI Responses API。API 密钥只保存在服务端 `.env`，不会放进网页源码。模型返回任务后，页面仍会让用户校对学科、任务类别和时长；接口不可用时会回退到浏览器内置识别规则。

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

默认模型是 `deepseek-flash`，可在 `.env` 中设置 `DEEPSEEK_MODEL`。DeepSeek 模式使用 JSON Output，并在服务端校验返回结构。切换 OpenAI 时设置 `AI_PROVIDER=openai`、`OPENAI_API_KEY` 和可选的 `OPENAI_MODEL`。服务只监听本机回环地址，适合个人本地原型，不是公开部署配置。

`deepseek-flash` 会先输出思维链，思维链同样占用 `max_tokens`，额度不足时会返回空内容。服务默认给 8000 tokens 并只要求 `low` 思维深度；若孩子一次输入很多任务被提示“输入内容较多”，可调大 `.env` 里的 `DEEPSEEK_MAX_TOKENS`，或把任务分成两三次识别。模型偶发返回空内容或格式错误时，服务会自动重试一次。

## 数据说明

点击“识别任务”后，输入的任务文字会发送到本机服务，再由服务转发给模型服务处理。不要输入孩子姓名、学校、住址等身份信息。模型识别可能出错，生成计划前请检查并修改结果。此示例不存储识别请求日志；模型平台的数据处理仍按对应账户和服务政策执行。
