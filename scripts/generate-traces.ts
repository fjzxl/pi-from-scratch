// scripts/generate-traces.ts
// 离线 Trace 生成器 —— 教学网站的"单步调试"功能需要一份真实执行记录。
//
// 它做什么：在临时目录里用真实模型跑 6 个典型任务，把 runAgent() 产生的
//   AgentEvent 和每一步的 Context 全部录下来，输出成 web/app/trace-data.generated.ts。
//   浏览器只回放这份静态数据，不会连接模型 API。
//
// 为什么需要"校验"：模型不是每次都按预期行动（比如该调工具却不调）。
//   所以每个 case 结束后都要断言"确实发生了预期的事"，不满足就报错、拒绝写文件。
//   这样 trace 永远是可信的教学素材，而不是一份翻车的现场录像。
//
// ⚠ 维护命令（需要真实 API Key，新手阅读网站时不需要运行）：
//   NANOPI_API_KEY=... NANOPI_BASE_URL=... npm run generate:traces
//   只重跑某一个案例：追加 TRACE_CASE=read-file（其余案例沿用生成文件中已有的数据，不会被覆盖）
//
// 注意：本脚本用"内容匹配"（findLine）定位源码行号，而不是写死行号，
//   所以给 src/ 加注释不会让这里失效。

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAgent, type AgentEvent, type AgentTool } from '../src/agent.js'
import { builtinTools } from '../src/tools.js'
import type { Context, Model } from '../src/llm.js'
import type { TraceCase, TraceContext, TraceSource, TraceStep } from '../web/app/trace-types.js'

type SourceFile = TraceSource['file']

/** 一个 trace 案例的完整定义：跑什么任务、给什么工具、预期看到什么 */
type CaseSpec = {
  id: string
  number: string
  title: string
  summary: string
  outcome: string
  systemPrompt: string
  prompt: (workspace: string) => string
  prepare?: (workspace: string) => Promise<void>
  tools: (workspace: string) => AgentTool[]
  maxTokens?: number
  abortAfterMs?: number
}

/** 录下来的一步：一个 AgentEvent 事件 + 事件发生时的 Context 快照 */
type CapturedEvent = {
  event: AgentEvent
  context: Context
}

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, '..')
const outputPath = resolve(projectRoot, 'web/app/trace-data.generated.ts')

/** 缺少环境变量就直接报错退出——生成 trace 必须用真实模型，不能拿假数据糊弄 */
function requiredEnv(name: 'NANOPI_API_KEY' | 'NANOPI_BASE_URL'): string {
  const value = process.env[name]
  if (!value) throw new Error(`需要设置 ${name} 才能生成真实 trace。`)
  return value
}

const apiKey = requiredEnv('NANOPI_API_KEY')
const baseUrl = requiredEnv('NANOPI_BASE_URL').replace(/\/+$/, '')

// 读入源码全文，供 findLine 做内容匹配（不写死行号，加注释不会失效）
const sourceFiles = Object.fromEntries(
  await Promise.all(
    (['src/llm.ts', 'src/agent.ts', 'src/tools.ts', 'src/tui.ts', 'src/cli.ts'] as SourceFile[])
      .map(async (file) => [file, await readFile(resolve(projectRoot, file), 'utf8')]),
  ),
) as Record<SourceFile, string>

/** 深拷贝 Context：录的是"那一刻"的状态，不能和后续变化共享引用 */
function cloneContext(context: Context): TraceContext {
  return JSON.parse(JSON.stringify(context)) as TraceContext
}

/**
 * 按内容找源码行号。occurrence=0 取第一次出现，-1 取最后一次。
 * 用内容而不是行号定位，是为了让 trace 在源码加注释后依然有效。
 */
function findLine(file: SourceFile, needle: string, occurrence = 0): number {
  const matches = sourceFiles[file]
    .split('\n')
    .map((line, index) => ({ line, number: index + 1 }))
    .filter((entry) => entry.line.includes(needle))
  const match = occurrence < 0 ? matches.at(occurrence) : matches[occurrence]
  if (!match) throw new Error(`找不到 trace 源码位置：${file} / ${needle}`)
  return match.number
}

function source(file: SourceFile, needle: string, occurrence = 0): TraceSource {
  return { file, line: findLine(file, needle, occurrence) }
}

/** 把不可预测的临时目录路径替换成 /workspace，让 trace 数据稳定可复现 */
function normalizeText(value: string, workspace: string): string {
  return value.split(workspace).join('/workspace')
}

/** 同上，但作用在任意 JSON 值上（消息数组、事件对象等） */
function normalizeValue<T>(value: T, workspace: string): T {
  return JSON.parse(normalizeText(JSON.stringify(value), workspace)) as T
}

/** 判断一条消息是"工具结果"还是"模型回复"，用来决定界面上怎么描述这一步 */
function messageKind(message: unknown): 'tool_result' | 'assistant' | 'other' {
  if (!message || typeof message !== 'object') return 'other'
  const item = message as { role?: string; content?: unknown }
  if (item.role === 'assistant') return 'assistant'
  if (item.role === 'user' && Array.isArray(item.content)) {
    const hasResult = item.content.some((block) => (
      block && typeof block === 'object' && (block as { type?: string }).type === 'tool_result'
    ))
    if (hasResult) return 'tool_result'
  }
  return 'other'
}

/** Context 变化的来源行：写回 tool_result 还是写回 assistant message */
function contextStepSource(context: TraceContext): TraceSource {
  const latest = context.messages.at(-1)
  if (messageKind(latest) === 'tool_result') {
    return source('src/agent.ts', 'context.messages.push(buildToolResultMessage(results))', -1)
  }
  return source('src/agent.ts', 'context.messages.push(buildAssistantMessage(text, toolCalls))', -1)
}

/** 每个 AgentEvent 对应 agent.ts 里的哪一行——回放时高亮它 */
function eventSource(event: AgentEvent): TraceSource {
  switch (event.type) {
    case 'assistant_text':
      return source('src/agent.ts', "yield { type: 'assistant_text', delta: ev.delta }")
    case 'tool_call':
      return source('src/agent.ts', "yield { type: 'tool_call', id: ev.id")
    case 'tool_result':
      return source('src/agent.ts', "yield { type: 'tool_result', id:", 0)
    case 'turn_end':
      if (event.stopReason === 'aborted') return source('src/agent.ts', "yield { type: 'turn_end', stopReason: 'aborted' }")
      if (event.stopReason === 'error') return source('src/agent.ts', "yield { type: 'turn_end', stopReason: 'error' }")
      return source('src/agent.ts', "yield { type: 'turn_end', stopReason: reason }")
  }
}

function eventCopy(event: AgentEvent): Record<string, unknown> {
  return JSON.parse(JSON.stringify(event)) as Record<string, unknown>
}

function eventPresentation(event: AgentEvent): Pick<TraceStep, 'label' | 'detail' | 'kind'> {
  switch (event.type) {
    case 'assistant_text':
      return {
        label: '模型流式输出文本',
        detail: 'stream() 产生 text_delta，agent 将它转成 assistant_text 发给界面。',
        kind: 'stream',
      }
    case 'tool_call':
      return {
        label: `模型调用 ${event.name}`,
        detail: 'agent 收集工具名和参数，同时发出 tool_call 事件。',
        kind: 'tool',
      }
    case 'tool_result':
      return {
        label: `${event.name} 返回结果`,
        detail: '工具已经执行完，结果先作为 AgentEvent 发出，随后写回 Context。',
        kind: event.result.startsWith('error:') ? 'error' : 'tool',
      }
    case 'turn_end':
      return {
        label: `本轮结束：${event.stopReason}`,
        detail: event.stopReason === 'aborted'
          ? '中断信号抵达当前任务，agent 清理未完成的数据后结束。'
          : event.stopReason === 'max_tokens'
            ? '模型碰到输出上限，agent 保留已收到的文本并结束本轮。'
            : event.stopReason === 'error'
              ? '请求失败，agent 发出错误事件并停止循环。'
              : '这一轮没有新的 tool_call，Agent Loop 正常退出。',
        kind: event.stopReason === 'error' ? 'error' : 'end',
      }
  }
}

/**
 * 合并连续的 assistant_text 事件。
 * 模型是流式输出的，一个句子会变成几十个 text_delta；全部保留会让 trace 变成"点一下走一个字"。
 * 这里把它们合成一条完整文本，回放时才有"一句话逐渐写出来"的观感。
 */
function coalesceTextEvents(events: CapturedEvent[]): CapturedEvent[] {
  const result: CapturedEvent[] = []
  for (const captured of events) {
    const previous = result.at(-1)
    if (captured.event.type === 'assistant_text' && previous?.event.type === 'assistant_text') {
      previous.event = { type: 'assistant_text', delta: previous.event.delta + captured.event.delta }
      previous.context = captured.context
    } else {
      result.push(captured)
    }
  }
  return result
}

/**
 * 把录制的事件流变成 TraceLab 能回放的步骤列表。
 *
 * 产出两类交替出现的步骤：
 *   - context 步骤：Context 消息变多的那一刻（写回 assistant 或 tool_result）
 *   - event  步骤：一个 AgentEvent（模型输出 / 调工具 / 工具结果 / 回合结束）
 * 开头的 input 步骤是特例，代表"用户输入进入 Context"这个起点。
 */
function buildSteps(initial: TraceContext, captured: CapturedEvent[], finalContext: TraceContext): TraceStep[] {
  const steps: TraceStep[] = [{
    id: 'input',
    label: '用户消息进入 Context',
    detail: 'CLI 先把这一轮输入追加到 messages，随后把 Context 交给 runAgent()。',
    kind: 'input',
    source: source('src/cli.ts', "context.messages.push({ role: 'user', content: text })"),
    context: initial,
  }]

  let visibleMessages = initial.messages.length
  let index = 1

  for (const item of coalesceTextEvents(captured)) {
    if (item.context.messages.length > visibleMessages) {
      const context = cloneContext(item.context)
      steps.push({
        id: `context-${index++}`,
        label: messageKind(context.messages.at(-1)) === 'tool_result'
          ? 'tool_result 写回 Context'
          : 'assistant message 写回 Context',
        detail: '这次修改会进入下一轮请求，也会被 session 持久化。',
        kind: 'context',
        source: contextStepSource(context),
        context,
      })
      visibleMessages = item.context.messages.length
    }

    const presentation = eventPresentation(item.event)
    steps.push({
      id: `event-${index++}`,
      ...presentation,
      source: eventSource(item.event),
      event: eventCopy(item.event),
      context: cloneContext(item.context),
    })
  }

  if (finalContext.messages.length > visibleMessages) {
    steps.push({
      id: `context-${index++}`,
      label: messageKind(finalContext.messages.at(-1)) === 'tool_result'
        ? 'tool_result 写回 Context'
        : 'assistant message 写回 Context',
      detail: '循环退出前，最后一条消息已经放回 Context。',
      kind: 'context',
      source: contextStepSource(finalContext),
      context: finalContext,
    })
  }

  return steps
}

/** 从内置工具里挑几个组成 case 的工具集（教学案例不需要给模型全部工具） */
function pickTools(...names: string[]): AgentTool[] {
  const all = builtinTools()
  return names.map((name) => {
    const tool = all.find((candidate) => candidate.name === name)
    if (!tool) throw new Error(`内置工具不存在：${name}`)
    return tool
  })
}

// 6 个教学案例，覆盖 Agent Loop 的每一条分支。
// 编号即网站上的展示顺序，从最简单的"一轮就结束"到最复杂的"被 Ctrl+C 打断"。
const cases: CaseSpec[] = [
  {
    // 分支：stopReason=end_turn，循环只跑一轮。理解 Agent Loop 的起点。
    id: 'plain-text',
    number: '01',
    title: '没有 tool_call',
    summary: '模型只返回文本，循环一轮结束。',
    outcome: '一条 assistant message，随后 end_turn。',
    systemPrompt: '你是 nanopi 的教学演示模型。严格按用户要求回答，答案保持一句话。',
    prompt: () => '只回答这一句：没有 tool_call，Agent Loop 就会结束。',
    tools: () => [],
  },
  {
    // 分支：最典型的工具往返。模型调 read_file → 结果写回 Context → 第二轮纯文本收尾。
    id: 'read-file',
    number: '02',
    title: '读取一个文件',
    summary: '模型调用 read_file，把结果放回 Context，再完成回答。',
    outcome: '一次工具往返，两轮 LLM 请求。',
    systemPrompt: '你是 nanopi 的教学演示模型。必须使用提供的工具完成任务，工具返回后用一句话回答。',
    prepare: async (workspace) => {
      await writeFile(join(workspace, 'hello.txt'), 'alpha\nbeta\ngamma\n', 'utf8')
    },
    prompt: (workspace) => `使用 read_file 读取 ${join(workspace, 'hello.txt')}，告诉我第一行。不要猜。`,
    tools: () => pickTools('read_file'),
  },
  {
    // 分支：多工具串行。一轮里连续 edit + read_file，展示工具结果如何驱动下一次调用。
    id: 'edit-and-check',
    number: '03',
    title: '修改并验证',
    summary: '模型先编辑文件，再读回来确认修改。',
    outcome: 'edit 和 read_file 串成一条多工具路径。',
    systemPrompt: '你是 nanopi 的教学演示模型。严格按用户指定的工具顺序执行，完成后只报告最终值。',
    prepare: async (workspace) => {
      await writeFile(join(workspace, 'config.ts'), 'export const retries = 2\n', 'utf8')
    },
    prompt: (workspace) => {
      const path = join(workspace, 'config.ts')
      return `先用 edit 把 ${path} 里的 retries = 2 改成 retries = 3，再用 read_file 读取同一文件确认。`
    },
    tools: () => pickTools('edit', 'read_file'),
  },
  {
    // 分支：工具抛异常。agent 不崩溃，而是把错误文本喂回 Context 让模型自己纠错。
    id: 'tool-error',
    number: '04',
    title: '工具执行失败',
    summary: '工具抛出错误，agent 把错误结果交还给模型。',
    outcome: '错误成为 tool_result，模型仍能正常收尾。',
    systemPrompt: '你是 nanopi 的教学演示模型。必须调用唯一可用的工具；失败后用一句话说明失败原因。',
    prompt: () => '查询离线包索引中 nanopi 的最新版本。',
    tools: () => [{
      name: 'lookup_package',
      description: '查询离线包索引。这个教学工具会稳定返回索引不可用错误。',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      execute: async () => { throw new Error('offline registry unavailable') },
    }],
  },
  {
    // 分支：max_tokens 截断。输出撞上限，本轮直接结束，不执行任何工具。
    id: 'max-tokens',
    number: '05',
    title: '撞上 max_tokens',
    summary: '让长回答耗尽输出预算，观察截断后的结束事件。',
    outcome: '本轮没有工具调用，直接以 max_tokens 结束。',
    systemPrompt: '你是 nanopi 的教学演示模型。直接输出正文，不写标题，不省略内容。',
    prompt: () => '请用至少两千个汉字解释 Agent Loop 为什么需要 Context。',
    tools: () => [],
    maxTokens: 512,
  },
  {
    // 分支：用户按 Ctrl+C。abortAfterMs=20 让中断发生在请求刚发出的瞬间。
    id: 'abort-request',
    number: '06',
    title: '等待时按下 Ctrl+C',
    summary: '请求刚发出就触发 AbortController，观察信号怎样结束本轮。',
    outcome: 'fetch 停止，agent 发出 aborted。',
    systemPrompt: '你是 nanopi 的教学演示模型。回答要完整。',
    prompt: () => '请详细列出一个 coding agent 从接收任务到完成任务的全部过程。',
    tools: () => [],
    abortAfterMs: 20,
  },
]

/**
 * 跑一个案例并录成 TraceCase：新建临时工作区 → 真实调用 runAgent → 边跑边录 → 校验 → 清理。
 * 案例输入文件放在独立临时目录，并提示模型只操作这些文件；这不是沙箱，文件工具仍能访问进程有权限访问的其他路径。
 */
async function runCase(spec: CaseSpec): Promise<TraceCase> {
  const workspace = await mkdtemp(join(tmpdir(), `nanopi-trace-${spec.id}-`))
  try {
    await spec.prepare?.(workspace)
    const prompt = spec.prompt(workspace)
    const context: Context = {
      systemPrompt: spec.systemPrompt,
      messages: [{ role: 'user', content: prompt }],
    }
    const initial = cloneContext(context)
    const model: Model = {
      apiKey,
      baseUrl,
      model: 'glm-5.2',
      maxTokens: spec.maxTokens ?? 512,
    }
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), spec.abortAfterMs ?? 60_000)
    const captured: CapturedEvent[] = []

    try {
      for await (const event of runAgent(model, context, spec.tools(workspace), controller.signal)) {
        captured.push({ event, context: cloneContext(context) as Context })
      }
    } finally {
      clearTimeout(timeout)
    }

    const errorEvent = captured.find(({ event }) => (
      event.type === 'turn_end' && event.stopReason === 'error'
    ))
    if (errorEvent) {
      const message = captured
        .flatMap(({ event }) => event.type === 'assistant_text' ? [event.delta] : [])
        .join('')
        .replace(/\s+/g, ' ')
        .slice(0, 280)
      throw new Error(`${spec.id}: 模型请求失败，拒绝写入 trace。${message}`)
    }

    const eventTypes = captured.map(({ event }) => event.type)
    const toolNames = captured.flatMap(({ event }) => (
      event.type === 'tool_call' ? [event.name] : []
    ))
    const stopReason = captured.findLast(({ event }) => event.type === 'turn_end')?.event
    if (spec.id === 'read-file' && !toolNames.includes('read_file')) {
      throw new Error('read-file: GLM-5.2 没有调用 read_file')
    }
    if (spec.id === 'edit-and-check' && (!toolNames.includes('edit') || !toolNames.includes('read_file'))) {
      throw new Error('edit-and-check: GLM-5.2 没有完成 edit + read_file')
    }
    if (spec.id === 'tool-error' && (!eventTypes.includes('tool_call') || !eventTypes.includes('tool_result'))) {
      throw new Error('tool-error: 缺少工具失败往返')
    }
    if (spec.id === 'max-tokens' && (stopReason?.type !== 'turn_end' || stopReason.stopReason !== 'max_tokens')) {
      throw new Error('max-tokens: 没有以 max_tokens 结束')
    }
    if (spec.id === 'abort-request' && (stopReason?.type !== 'turn_end' || stopReason.stopReason !== 'aborted')) {
      throw new Error('abort-request: 没有以 aborted 结束')
    }

    const normalizedInitial = normalizeValue(initial, workspace)
    const normalizedCaptured = normalizeValue(captured, workspace)
    const normalizedFinal = normalizeValue(cloneContext(context), workspace)

    return {
      id: spec.id,
      number: spec.number,
      title: spec.title,
      summary: spec.summary,
      prompt: normalizeText(prompt, workspace),
      model: 'glm-5.2',
      outcome: spec.outcome,
      steps: buildSteps(normalizedInitial, normalizedCaptured, normalizedFinal),
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
}

const requestedCase = process.env.TRACE_CASE
const selectedCases = requestedCase ? cases.filter((spec) => spec.id === requestedCase) : cases
if (!selectedCases.length) throw new Error(`未知 TRACE_CASE：${requestedCase}`)

const traceCases: TraceCase[] = []
for (const spec of selectedCases) {
  process.stdout.write(`生成 ${spec.number} ${spec.title}... `)
  traceCases.push(await runCase(spec))
  process.stdout.write('完成\n')
}

// 合并写回：TRACE_CASE 只重跑部分案例时，其余案例沿用生成文件里已有的数据，
// 否则单案例重跑会把其他案例从 trace-data.generated.ts 里整个删掉。
const partial = selectedCases.length < cases.length
const existingRaw = partial ? await readFile(outputPath, 'utf8').catch(() => null) : null
// 边界 = 分号 + 空行 + 下一个 export。用 \r?\n 兼容 LF/CRLF 检出差异；
// JSON 字符串里的换行是转义的两字符 \n，不会被真实空行误伤（trace 数据嵌有源码摘录）
const parseExport = (name: string): unknown => {
  if (!existingRaw) return null
  const start = existingRaw.indexOf(`export const ${name}`)
  if (start < 0) return null
  const boundary = /;\r?\n\r?\n(?=export const )/g
  boundary.lastIndex = start + 1
  const hit = boundary.exec(existingRaw)
  const segment = existingRaw.slice(start, hit ? hit.index + 1 : undefined)
  const match = segment.match(/= ([\s\S]*);\s*$/)
  if (!match) return null
  try { return JSON.parse(match[1]) } catch { return null }
}
const oldCases = (parseExport('traceCases') as TraceCase[] | null) ?? []
const oldMeta = parseExport('traceMeta') as { model: string; generatedAt: string; liveGenerated: boolean } | null

const newById = new Map(traceCases.map((c) => [c.id, c]))
const oldById = new Map(oldCases.map((c) => [c.id, c]))
const mergedCases = cases
  .map((spec) => newById.get(spec.id) ?? oldById.get(spec.id))
  .filter((c): c is TraceCase => Boolean(c))

// 部分重跑时保留旧的 traceMeta：generatedAt 描述的是整份数据的生成时间，不能被单案例刷新
const meta = partial && oldMeta ? oldMeta : {
  model: 'glm-5.2',
  generatedAt: new Date().toISOString(),
  liveGenerated: true,
}

const output = `// Generated by ../../scripts/generate-traces.ts. Do not edit by hand.\n` +
  `import type { TraceCase, TraceMeta } from "./trace-types";\n\n` +
  `export const traceMeta: TraceMeta = ${JSON.stringify(meta, null, 2)};\n\n` +
  `export const traceCases: TraceCase[] = ${JSON.stringify(mergedCases, null, 2)};\n`

await writeFile(outputPath, output, 'utf8')
console.log(`已写入 ${mergedCases.length} 个离线 trace（本次重新生成 ${traceCases.length} 个）。`)
