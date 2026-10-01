# 新手入门指南

这份指南帮助你先跑通项目，再理解代码。你只需要会打开终端、编辑文本文件；阅读源码时，懂一点 JavaScript 会更轻松。

## 1. 先认识你要运行什么

本项目包含两个可以分别运行的部分：

| 部分 | 位置 | 用途 | 需要 API Key 吗？ |
| --- | --- | --- | --- |
| nano-pi | 根目录的 `src/` | 在终端中与模型对话，让它读文件、改代码、执行命令 | 需要 |
| 教学网站 | `web/` | 阅读文章、查看逐步补全的源码、回放离线 Trace | 不需要 |

如果只是想学习，先打开 [在线教学网站](https://pi-from-scratch.vercel.app) 即可。Trace 是预先记录的执行过程，点击单步、断点等控件是在回放数据。

## 2. 准备环境

安装 **Node.js 22.13 或更高版本**（同时满足 nano-pi 和教学网站的要求），以及用于下载项目的 Git。打开终端检查：

```sh
node --version
npm --version
git --version
```

下载项目：

```sh
git clone https://github.com/SaladDay/pi-from-scratch.git
cd pi-from-scratch
```

已经有项目文件时，直接在项目根目录打开终端即可。根目录包含 `package.json`、`src/`、`docs/` 和 `web/`。

以下命令会注明运行目录。根目录与 `web/` 有各自的 `package.json`，需要分别安装依赖。

## 3. 第一次运行 nano-pi

### 安装依赖

在**项目根目录**运行：

```sh
npm install
```

### 配置模型

使用支持 **OpenAI Chat Completions 兼容格式、流式输出和工具调用** 的 API。将根目录的 `.env.example` 复制为 `.env`，填写：

```dotenv
NANOPI_API_KEY=你的实际密钥
NANOPI_BASE_URL=https://api.openai.com/v1
NANOPI_MODEL=你的服务商支持的模型名
```

`NANOPI_BASE_URL` 是接口前缀，代码会自动在后面加 `/chat/completions`，不要在配置中再加这一段，也不要保留末尾的 `/`。如果使用其他服务商，请替换为它提供的 OpenAI 兼容地址。

`NANOPI_MODEL` 必须对应这个接口提供的模型；代码默认的 `glm-5.2` 不一定适用于你的服务商。`.env` 已被 Git 忽略。CLI 从**当前工作目录**读取它，终端中已有的同名环境变量优先。

也可以直接在终端设置配置。macOS、Linux 或 WSL：

```sh
export NANOPI_API_KEY="你的实际密钥"
export NANOPI_BASE_URL="https://api.openai.com/v1"
export NANOPI_MODEL="你的模型名"
```

Windows PowerShell：

```powershell
$env:NANOPI_API_KEY = "你的实际密钥"
$env:NANOPI_BASE_URL = "https://api.openai.com/v1"
$env:NANOPI_MODEL = "你的模型名"
```

### 启动并尝试一个任务

在项目根目录运行：

```sh
npm run dev
```

成功后终端显示 `>`，输入：

```text
请用 read_file 读取 package.json，然后解释 scripts 中各个命令的作用。
```

你会看到模型文字，以及类似下面的工具日志（具体顺序和文字由模型决定）：

```text
[tool: read_file] {"path":"package.json"}
[result: read_file] ...文件内容...
...模型的解释...
>
```

再试一个完整的读写任务：

```text
请在系统临时目录创建一个 nanopi-hello.txt，内容是 Hello nano-pi，再读取文件确认内容。
```

工具的相对路径以启动进程时的工作目录为基准。`run_bash` 名字虽然含 bash，实际使用 Node.js 的默认系统 shell：Unix 上通常是 `/bin/sh`，Windows 上通常是 `cmd.exe`。

运行时 Ctrl+C 会请求中断当前任务；空闲时 Ctrl+C 交给 readline 的默认行为处理。每次任务结束后会恢复 `>` 输入提示。在空提示符下按 Ctrl+D（或输入流结束）时，程序会打印 `[会话结束]` 后退出。

### 聊天记录在哪里？

CLI 启动时读取 `~/.nanopi/session.jsonl`，任务结束后追加新消息。上下文被压缩（compaction）后，文件会被整体重写为压缩后的内容，因此文件始终与当前对话状态一致。`~` 表示当前用户的主目录；Windows 上通常是 `C:\Users\你的用户名`。

这个会话文件由当前用户的 nano-pi 运行共享，不会按项目目录分开。需要从新对话开始时，先退出程序，将该文件重命名为备份，再启动。

## 4. 本地运行教学网站

从项目根目录进入 `web/`：

```sh
cd web
npm install
npm run dev
```

打开终端输出的 Local 地址，通常是 `http://localhost:3000`。网站不需要 `.env` 或模型 API Key。

Windows PowerShell 下，`web/package.json` 的 `dev` 脚本采用 Unix 环境变量写法，可以改用以下命令启动（仍在 `web/` 中）；`npm test` 已做跨平台处理，无需此处理，直接运行即可：

```powershell
npm run generate:content
$env:NODE_OPTIONS = "--max-old-space-size=1024"
npx next dev --webpack
```

生产构建与启动，在 `web/` 中运行：

```sh
npm run build
npm run start
```

网站的内容生成脚本读取文章和源码，生成 `web/app/content.generated.ts`。当前仓库忽略了 `docs/pi-from-scratch.md`；普通克隆缺少这个文件时，脚本会使用已提交的内容快照，并打印 `已更新源码快照；N/3 篇文章沿用已提交内容（父级教学源缺失）。`。这时修改 `src/` 和章节文档仍会正常同步到网站；只有大纲文章本身的改动无法体现（普通克隆里没有这个文件）。详见[项目逻辑图中的内容流程](architecture.md#4-教学网站的数据流程)。

## 5. 如何检查代码能正常工作

在**项目根目录**运行：

```sh
npm test
npm run build
```

- `npm test`：运行 Vitest 单元测试，模型请求使用模拟数据，不需要真实 API Key。
- `npm run build`：用 TypeScript 检查并编译核心代码，结果在 `dist/`。
- `npm run dev`：直接执行 TypeScript 入口，不需要先 build。
- `npm run check:slices`：改动 `src/` 后用于检查教学网站源码快照是否同步，以及渐进代码切片是否仍然对齐。运行前先在 `web/` 目录执行 `npm run generate:content`；如果增删了源码行，还要检查并调整 `web/app/lesson-data.ts` 中的行号区间。

`npm run generate:traces` 是维护离线案例的命令，会请求真实模型，需要在终端设置 `NANOPI_API_KEY` 和 `NANOPI_BASE_URL`，可选设置 `NANOPI_MODEL`；它不像 CLI 那样自动读取 `.env`。新手阅读网站时无需运行它。

## 6. 建议的阅读顺序

1. 看[项目逻辑图](architecture.md)，理解“用户输入 → 模型 → 工具 → 模型”的循环。
2. 读[第一章：模块](ch01-modules.md)，认识五个文件的职责。
3. 读[第二章：循环](ch02-loop.md)，跟着数据流理解实现。
4. 打开 `src/cli.ts`，找到输入回调和 `for await` 事件转发。
5. 打开 `src/agent.ts`，找到 `while (true)`，追踪消息怎样写回 Context。
6. 阅读 `src/llm.ts` 的消息转换与 SSE 解析，再看 `src/tools.ts` 和 `src/tui.ts`。
7. 在网站的 Trace 中回放一个案例，对照输入、事件和 Context 的变化。

需要按天安排、带动手练习和自测标准的版本，见[初学者 7 天学习计划](beginner-learning-plan.md)。

几个常用词：

| 名词 | 在这个项目中的意思 |
| --- | --- |
| LLM | 接收对话、生成文本或工具调用的大语言模型 |
| Context | 发给模型的上下文，由系统提示和消息数组组成 |
| Tool calling | 模型返回工具名和参数；真正执行工具的是本地代码 |
| SSE | HTTP 流式响应格式，用于逐段接收模型输出 |
| `async function*` / `yield` | 异步生成器逐个产生事件，调用方用 `for await` 消费 |
| AbortSignal | 将“中断任务”的信号传给模型请求和命令执行 |
| Compaction | 当消息达到阈值时，将旧对话总结为摘要并保留近期消息 |

## 7. 常见问题

| 现象 | 检查方法 |
| --- | --- |
| 找不到 `node` 或 `npm` | 安装 Node.js 后重新打开终端，检查版本 |
| 提示设置 `NANOPI_API_KEY` | 确认 `.env` 在当前工作目录，或检查终端环境变量 |
| API 401 / 403 | 检查密钥是否正确以及服务商账号是否有访问权限 |
| API 404 / model not found | 检查接口前缀与模型名，不要重复填写 `/chat/completions` |
| API 429 | 查看服务商的额度或速率限制，稍后重试 |
| 可以聊天但不调用工具 | 确认模型支持工具调用，并在任务中明确要读取哪个文件 |
| 文件找不到 | 检查启动目录，或在任务中提供文件的绝对路径 |
| `edit` 提示匹配多处或没有匹配 | 先读取文件，再使用包含足够上下文的精确原文 |
| 读取大文件只看到最后一部分 | 工具只展示最后 200 行，日志中的临时文件路径包含完整输出 |
| 网站没有同步刚改的源码 | 检查是否使用了已提交快照；参见第 4 节 |
| 局域网打开网站后交互失效 | 按 [web/README.md](../web/README.md) 设置 `NEXT_ALLOWED_DEV_ORIGINS` 后重启 |

返回[项目首页](../README.md)。
