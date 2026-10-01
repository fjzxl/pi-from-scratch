# 初学者 7 天学习计划

这份计划面向第一次阅读 coding agent 源码的学习者。每天预留约 30–60 分钟；如果某个概念还没弄懂，可以重复当天内容，不必赶进度。学习目标不是背下所有代码，而是能说清楚一次任务如何从输入走到模型、工具和最终回复。

## 开始前

- 准备 Node.js **22.13 或更高版本**。
- 在项目根目录安装依赖并检查基础环境：

  ```bash
  npm install
  npm test
  npm run build
  ```

- 打算在本地运行教学网站（第 7 天的网站检查需要），再在 `web/` 目录执行一次 `npm install`；只用在线网站可跳过。
- 在线教学网站和 Trace 不需要 API Key，第一次可以先浏览网站。**第 3 天开始前**要按[新手入门指南](getting-started.md)配置 `.env`，用 `npm run dev` 跑通第一个任务——第 3 天的工具练习和第 6 天查看会话文件都以它为前提。
- 阅读第一、二章时建议直接在[在线教学网站](https://pi-from-scratch.vercel.app)上读：右侧编辑器会随阅读进度逐步补全对应的源码，读完一章，那一章的代码也就完整了。
- 练习文件放在临时目录或可随时恢复的练习仓库里。`read_file`、`write_file`、`edit` 和 `run_bash` 会实际访问文件或执行命令；项目没有把这些工具限制在工作区内。

## 第 1 天：先画出模块地图

**阅读**

1. [项目逻辑图](architecture.md)第 1 节。
2. [第一章：模块](ch01-modules.md)，先只看每个模块的职责。

**练习**

- 不看文档，画出 `tui.ts`、`cli.ts`、`agent.ts`、`llm.ts`、`tools.ts` 的关系。
- 用一句话分别说明 `cli.ts` 和 `agent.ts` 的工作有什么不同。

**自测**

- 能说明为什么 `cli.ts` 是拼装层。
- 能说明 TUI 不直接执行工具，工具也不直接修改 Context。

## 第 2 天：看懂 Context 和模型请求

**阅读**

1. [第二章：循环](ch02-loop.md)“怎么跟 LLM 说话”部分。
2. `src/llm.ts` 中的 `Model`、`Message`、`Context`、`ContentBlock` 和 `StreamEvent`。

**练习**

- 在纸上写出一轮调用中 user 消息、assistant 消息和 tool result 的结构。
- 阅读 `contextToOpenAIMessages()`，把 `tool_use` 和 `tool_result` 分别对应到发给 API 的哪种消息。
- 看 `test/llm.test.ts`，找出测试如何模拟 SSE，而不连接真实模型。

**自测**

- 能解释为什么内部消息格式需要转换成 OpenAI 格式。
- 能说明 SSE 的 `text_delta` 为什么可以逐段展示，而工具参数要等分片拼完后再处理。

## 第 3 天：理解工具如何工作

**准备**

- 确认已按入门指南配置模型，并至少用 `npm run dev` 跑通过一次对话——下面的练习都要通过和 Agent 的对话完成。

**阅读**

1. [第二章](ch02-loop.md)中 `read_file`、`write_file`、`edit` 和 `run_bash` 的部分。
2. `src/tools.ts` 中每个工具的 `parameters` 与 `execute`。

**练习**

- 用 `read_file` 读取一个无风险的小文件。
- 在临时文件上练习 `edit`：先读取内容，再用唯一匹配的 `old_string` 替换一小段。
- 找出 `run_bash` 的超时和输出限制，并确认当前系统实际使用的 shell。

**自测**

- 能区分“工具描述传给模型”和“工具函数在本地执行”。
- 能解释工具错误为什么会作为结果交回给模型，而不是让 Agent 立即崩溃。

## 第 4 天：跟一轮 Agent Loop

**阅读**

1. `src/agent.ts` 的 `runAgent()`。
2. [项目逻辑图](architecture.md)第 2、3 节。
3. 在教学网站 Trace 中回放“读取一个文件”的案例。

**练习**

- 画出“用户输入 → 模型请求 → 工具调用 → 工具结果 → 下一轮模型请求”的时序图。
- 对照 `AgentEvent` 和 `StreamEvent`，标出哪一层产生、哪一层消费。

**自测**

- 能解释为什么工具调用和结果都要写回 Context。
- 能说明有工具调用时，工具执行结束通常还不是整轮任务的结束。

## 第 5 天：看边界情况

**阅读**

1. [第二章](ch02-loop.md)的 max_tokens、abort、请求错误和 compaction 部分。
2. `test/agent.test.ts` 中的 compaction 切点测试，以及 Trace 中的 max_tokens 和 abort 案例。

**练习**

- 跟踪 abort 发生在模型请求期间和工具执行期间时，Context 分别如何收尾。
- 检查 compaction 切点为什么不能把 `tool_use` 和 `tool_result` 拆开。
- 思考按消息条数压缩可能漏掉什么情况（例如一条工具结果本身很长）。

**自测**

- 能解释为什么每个 `tool_call` 都需要对应结果。
- 能指出当前按消息数压缩是教学简化，不是精确 token 预算。

## 第 6 天：了解 CLI、会话和 TUI

**阅读**

1. `src/cli.ts` 中的 `main()`、`loadSession()` 和 `persistSession()`。
2. `src/tui.ts` 的输入、忙碌状态和中断处理。
3. `test/cli.test.ts` 和 `test/tui.test.ts`。

**练习**

- 查看 `~/.nanopi/session.jsonl` 的 JSONL 结构，确认每行保存一条消息。
- 找出会话在什么情况下追加、在 compaction 后什么情况下整体重写。
- 说出 `Ctrl+C` 如何从 TUI 经 CLI 的 `AbortController` 传到 Agent 和模型请求。

**自测**

- 能区分 TUI 的输入/打印职责和 CLI 的事件分发职责。
- 能说明为什么 API Key 不写进 Context 或会话文件。

## 第 7 天：做一个小改动并验证

从下面选一个练习，不必一次都做完；这天通常比前六天耗时，分两次完成也很正常：

### 入门练习：加一个工具测试

在 `test/agent.test.ts` 里定义一个简单的自定义 `AgentTool`，例如返回字符串长度；用模拟的 `StreamEvent` 验证 Agent 会执行工具并把结果写回 Context。只新增测试、不改动 `src/`，因此不影响教学网站的代码切片。

### 进阶练习：增加内置工具

在 `src/tools.ts` 增加一个小工具，例如统计文本行数。为参数补上 JSON Schema，在执行函数里检查参数，并在 `test/tools.test.ts` 中使用临时文件测试它。

**注意：** 新增工具会改变 `src/tools.ts` 的行数，`npm run check:slices` 会失败并提示 `Checkpoint xxx rewrites existing code`——这是切片失准的信号，不是你的代码错了。修复方法是按[项目逻辑图"行号即契约"](architecture.md#改动源码前必读行号即契约)一节的说明，重新对齐 `web/app/lesson-data.ts` 中的行号区间。这是整个计划里最难的一步，一时做不完也不影响前六天的收获。

源码修改后，在 `web/` 目录同步教学网站快照，再回到根目录检查切片：

```bash
# 在 web/ 目录生成教学网站源码快照
npm run generate:content
```

```bash
# 在项目根目录
npm test
npm run build
npm run check:slices
```

如果增删了源码行，还需要检查 `web/app/lesson-data.ts` 中的区间，并运行网站检查：

```bash
# 在 web/ 目录
npm test
npm run lint
```

**完成标准**

- 能描述你改了哪个模块、输入输出是什么。
- 至少有一个测试验证新行为。
- 项目测试、构建和相关切片检查通过。

## 继续学习

完成这周后，可以从[后续改进方向](future-improvements.md)中挑选一个小主题，例如工具参数校验、按 token 管理上下文，或让会话按项目区分。先写下当前行为和期望行为，再增加测试，最后修改实现，会更容易看清每一步的效果。

返回[项目首页](../README.md)。
