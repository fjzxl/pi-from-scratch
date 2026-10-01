// src/llm.ts
// LLM 通信层 —— 对上层只暴露一件事：传入 Context，吐出四种 StreamEvent 事件流。
// 教学版只支持 OpenAI 兼容格式（GLM、DeepSeek、Ollama 等均兼容）。

// ===== 类型 =====

/** 模型配置：去哪调（baseUrl）、调哪个模型（model）、用什么凭证（apiKey） */
export type Model = {
  apiKey: string
  model: string          // 模型名，如 "gpt-4o" 或 "glm-5.2"
  baseUrl?: string       // OpenAI 兼容接口前缀，默认 https://api.openai.com/v1
  maxTokens?: number     // 单次回复的最大 token 数；不设则由 API 决定默认值（cli.ts 设为 4096）
}

/**
 * content block：一条消息由若干"内容块"组成，不只文字。
 * 模型发起的工具调用（tool_use）和工具的执行结果（tool_result）也都是内容块。
 * 注意：tool_result 放在 ContentBlock 里再塞进 user message，
 * pi 里它是独立的 ToolResultMessage 类型，nanopi 简化为统一结构。
 */
export type ContentBlock =
  | { type: 'text'; text: string }                                          // 普通文字
  | { type: 'tool_use'; id: string; name: string; input: unknown }          // 模型的工具调用（在 assistant 消息里）
  | { type: 'tool_result'; tool_use_id: string; content: string }           // 工具结果（放在 user 消息里回给模型）

/** 消息：user / assistant 共用同一结构。content 是纯文本或内容块数组 */
export type Message = {
  role: 'user' | 'assistant'   // system 不放这里，它在 Context.systemPrompt 单独存放
  content: string | ContentBlock[]
}

/** Context：纯 JSON，可 stringify 落盘；保存对话状态，不包含 Model 的 API 密钥 */
export type Context = {
  systemPrompt?: string
  messages: Message[]
}

/** 流事件：llm 模块对外的统一输出。上层用 for await 逐个消费，不用关心底层 SSE */
export type StreamEvent =
  | { type: 'text_delta'; delta: string }                                                  // 模型吐出的一小段文字
  | { type: 'tool_call'; id: string; name: string; args: unknown }                         // 一次完整的工具调用（参数已拼好）
  | { type: 'done'; stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'aborted' }       // 本轮结束及原因
  | { type: 'error'; error: Error }                                                        // 请求失败

/** 传给 LLM 的工具"说明书"：模型靠它决定调哪个工具、填什么参数；execute 不给模型，留在本地执行 */
export type ToolDef = {
  name: string
  description: string
  parameters: object  // JSON Schema，描述参数的形状
}

// ===== 辅助函数 =====

/**
 * 把 nanopi Context 转成 OpenAI messages 格式：systemPrompt → role:system，
 * assistant 的 tool_use 块 → tool_calls 字段，tool_result 块 → 独立的 role:tool 消息。
 * 纯转换函数，不含网络逻辑。
 */
export function contextToOpenAIMessages(context: Context): object[] {
  const messages: object[] = []
  if (context.systemPrompt) messages.push({ role: 'system', content: context.systemPrompt })  // system 永远放在最前面

  for (const msg of context.messages) {
    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role, content: msg.content })  // 纯文本消息原样透传
      continue
    }

    const blocks = msg.content
    if (msg.role === 'assistant') {
      const toolCalls: object[] = []
      let text = ''
      for (const b of blocks) {
        if (b.type === 'text') text += b.text  // 文本块拼成 content 字符串
        else if (b.type === 'tool_use') {
          toolCalls.push({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } })  // arguments 必须是 JSON 字符串
        }
      }
      // OpenAI 要求 assistant 消息必须有 content（非 null）或 tool_calls。
      // 纯 tool_call 时 content 为 null；两者皆空（如 abort/error 后的无内容轮次）用空串占位，避免 API 400。
      const content = text || (toolCalls.length ? null : '')
      messages.push({ role: 'assistant', content, tool_calls: toolCalls.length ? toolCalls : undefined })
    } else {
      // user message 里的 tool_result block → OpenAI 要求独立的 role:tool 消息
      for (const b of blocks) {
        if (b.type === 'tool_result') {
          messages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: b.content })
        } else if (b.type === 'text') {
          messages.push({ role: 'user', content: b.text })
        }
      }
    }
  }
  return messages
}

/** OpenAI SSE chunk 的最小类型：只声明我们用到的字段，其余字段直接忽略 */
type OpenAIChunk = {
  choices: Array<{
    delta?: {
      content?: string
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>
    }
    finish_reason?: string
  }>
}

/** 解析一行 SSE data：提取文本增量、把 tool_call 分片累积进缓冲区、记录结束原因 */
function handleSSELine(
  data: string,
  toolCallBuffers: Map<number, { id: string; name: string; argsBuf: string }>,
): { textDelta: string | null; stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | null } {
  let chunk: OpenAIChunk
  try { chunk = JSON.parse(data) as OpenAIChunk } catch { return { textDelta: null, stopReason: null } }  // 坏行跳过：流式解析必须容错

  const choice = chunk.choices[0]
  if (!choice) return { textDelta: null, stopReason: null }

  let textDelta: string | null = null
  let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | null = null

  if (choice.delta?.content) textDelta = choice.delta.content

  // tool_call 是分片推送的：每片只带一小段 arguments 字符串，按 index 累积拼接
  if (choice.delta?.tool_calls) {
    for (const tc of choice.delta.tool_calls) {
      const idx = tc.index ?? 0
      if (!toolCallBuffers.has(idx)) {
        toolCallBuffers.set(idx, { id: tc.id ?? `call_${idx}`, name: '', argsBuf: '' })
      }
      const entry = toolCallBuffers.get(idx)!
      if (tc.id) entry.id = tc.id
      if (tc.function?.name) entry.name = tc.function.name
      if (tc.function?.arguments) entry.argsBuf += tc.function.arguments
    }
  }

  // finish_reason 映射：tool_calls → tool_use，length → max_tokens，stop → end_turn（默认值）
  if (choice.finish_reason === 'tool_calls') stopReason = 'tool_use'
  else if (choice.finish_reason === 'length') stopReason = 'max_tokens'

  return { textDelta, stopReason }
}

/** 流结束时调用：把拼完整的 tool_calls 按 index 顺序整理出来；arguments 解析失败回退为空对象 */
function flushToolCalls(
  toolCallBuffers: Map<number, { id: string; name: string; argsBuf: string }>,
): { id: string; name: string; args: unknown }[] {
  const calls: { id: string; name: string; args: unknown }[] = []
  for (const [, tc] of [...toolCallBuffers].sort((a, b) => a[0] - b[0])) {
    let args: unknown = {}
    if (tc.argsBuf) {
      try { args = JSON.parse(tc.argsBuf) } catch { args = {} }
    }
    calls.push({ id: tc.id, name: tc.name, args })
  }
  return calls
}

// ===== stream 函数 =====

/**
 * 调用 OpenAI Chat Completions API（streaming），返回统一事件流。
 * 这是个异步生成器：调用方 for await 逐个收事件，"打字机"效果就来自这里。
 *
 * @param model    模型配置
 * @param context  对话上下文（本函数只读它，不做修改）
 * @param opts     tools（工具说明书）+ abort signal（中断信号）
 */
export async function* stream(
  model: Model,
  context: Context,
  opts: { tools?: ToolDef[]; signal?: AbortSignal } = {},
): AsyncGenerator<StreamEvent> {
  const url = `${model.baseUrl ?? 'https://api.openai.com/v1'}/chat/completions`  // baseUrl 只填接口前缀，不重复包含此路径
  const messages = contextToOpenAIMessages(context)

  const body: Record<string, unknown> = { model: model.model, stream: true, messages }  // stream: true 开启 SSE 流式响应
  if (model.maxTokens) body.max_tokens = model.maxTokens
  if (opts.tools?.length) {
    body.tools = opts.tools.map(t => ({  // 把工具"说明书"交给模型，它才可能返回 tool_calls
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
  }

  // 发请求（signal 传进去后，Ctrl+C 能直接中断这个 fetch）
  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${model.apiKey}` },
      body: JSON.stringify(body),
      signal: opts.signal,
    })
  } catch (e) {
    if (opts.signal?.aborted) { yield { type: 'done', stopReason: 'aborted' }; return }
    yield { type: 'error', error: e as Error }; return
  }

  if (!response.ok || !response.body) {  // 4xx/5xx 或空响应：读出错误正文，包装成 error 事件
    const text = await response.text().catch(() => 'unknown error')
    yield { type: 'error', error: new Error(`API ${response.status}: ${text}`) }; return
  }

  // 网络块不等于一整行 SSE：buf 保留半行，TextDecoder 的 stream 模式保留跨块的 UTF-8 字符
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let stopReason: 'end_turn' | 'tool_use' | 'max_tokens' = 'end_turn'
  const toolCallBuffers = new Map<number, { id: string; name: string; argsBuf: string }>()

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })  // 网络块可能只有半行，先拼进 buf 再按行切

      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('data: ')) continue  // SSE 里还有空行等，只认 data: 开头的
        const data = line.slice(6)
        if (data === '[DONE]') continue  // OpenAI 的结束标记

        const result = handleSSELine(data, toolCallBuffers)
        if (result.textDelta) yield { type: 'text_delta', delta: result.textDelta }  // 收到一点就立刻吐给上层
        if (result.stopReason) stopReason = result.stopReason
      }
    }
  } catch (e) {
    if (opts.signal?.aborted) { yield { type: 'done', stopReason: 'aborted' }; return }
    yield { type: 'error', error: e as Error }; return
  }

  // 流结束才发出工具调用：参数 JSON 可能分成多个片段，不能收到半截就执行
  for (const tc of flushToolCalls(toolCallBuffers)) {
    yield { type: 'tool_call', id: tc.id, name: tc.name, args: tc.args }
  }
  yield { type: 'done', stopReason: opts.signal?.aborted ? 'aborted' : stopReason }
}

// ===== message 构建辅助函数 =====

/** 把本轮收到的文本 + tool_calls 组装成一条 assistant message，用于写回 Context */
export function buildAssistantMessage(
  text: string,
  toolCalls: { id: string; name: string; args: unknown }[],
): Message {
  const content: ContentBlock[] = []
  if (text) content.push({ type: 'text', text })
  for (const tc of toolCalls) {
    content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args })
  }
  return { role: 'assistant', content }
}

/** 把工具结果包装成 user message；tool_use_id 必须与模型的 tool_call.id 一一对应 */
export function buildToolResultMessage(
  results: { tool_use_id: string; content: string }[],
): Message {
  return {
    role: 'user',
    content: results.map(r => ({
      type: 'tool_result' as const,
      tool_use_id: r.tool_use_id,
      content: r.content,
    })),
  }
}
