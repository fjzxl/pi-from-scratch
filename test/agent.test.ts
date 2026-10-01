// test/agent.test.ts
// 测试 agent loop 的核心路径：纯文本回复、tool_call 执行后把结果放回到 Context、
// 未知 tool 报错、compaction 切点对齐轮次边界。
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { StreamEvent, Model, Context, Message } from '../src/llm.js'

const { mockStreamFn } = vi.hoisted(() => ({
  mockStreamFn: vi.fn(async function* (): AsyncGenerator<StreamEvent> {
    yield { type: 'done', stopReason: 'end_turn' }
  }),
}))

vi.mock('../src/llm.js', () => ({
  stream: mockStreamFn,
  buildAssistantMessage: (text: string, toolCalls: { id: string; name: string; args: unknown }[]) => {
    const content: unknown[] = []
    if (text) content.push({ type: 'text', text })
    for (const tc of toolCalls) content.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args })
    return { role: 'assistant', content }
  },
  buildToolResultMessage: (results: { tool_use_id: string; content: string }[]) => ({
    role: 'user',
    content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.tool_use_id, content: r.content })),
  }),
}))

import { runAgent, type AgentTool } from '../src/agent.js'

beforeEach(() => { mockStreamFn.mockClear() })

const model: Model = { apiKey: 'k', model: 'test' }

describe('runAgent', () => {
  it('纯文本回复：一轮就结束', async () => {
    mockStreamFn.mockImplementation(async function* (): AsyncGenerator<StreamEvent> {
      yield { type: 'text_delta', delta: 'Hello' }
      yield { type: 'done', stopReason: 'end_turn' }
    })

    const ctx: Context = { messages: [] }
    const events: { type: string; [k: string]: unknown }[] = []
    for await (const e of runAgent(model, ctx, [] as AgentTool[])) events.push(e)

    expect(events.find(e => e.type === 'assistant_text')).toEqual({ type: 'assistant_text', delta: 'Hello' })
    expect(events.at(-1)).toEqual({ type: 'turn_end', stopReason: 'end_turn' })
    expect(ctx.messages).toHaveLength(1)
  })

  it('tool_call → 执行 → 把结果放回到 Context → 下一轮纯文本', async () => {
    const echoTool: AgentTool = {
      name: 'echo',
      description: 'echo back',
      parameters: { type: 'object', properties: {} },
      execute: async (args: { text: string }) => `ECHO: ${args.text}`,
    }

    let round = 0
    mockStreamFn.mockImplementation(async function* (): AsyncGenerator<StreamEvent> {
      if (round === 0) {
        yield { type: 'tool_call', id: 't1', name: 'echo', args: { text: 'hi' } }
        yield { type: 'done', stopReason: 'tool_use' }
      } else {
        yield { type: 'text_delta', delta: 'Done' }
        yield { type: 'done', stopReason: 'end_turn' }
      }
      round++
    })

    const ctx: Context = { messages: [] }
    const events: { type: string; [k: string]: unknown }[] = []
    for await (const e of runAgent(model, ctx, [echoTool])) events.push(e)

    expect(events.map(e => e.type)).toEqual(['tool_call', 'tool_result', 'assistant_text', 'turn_end'])
    const tr = events.find(e => e.type === 'tool_result') as { result: string }
    expect(tr.result).toBe('ECHO: hi')
    // 3 条消息：assistant(tool_use) + user(tool_result) + assistant(text)
    expect(ctx.messages).toHaveLength(3)
  })

  it('未知 tool 名 → 把报错结果放回到 Context', async () => {
    let round = 0
    mockStreamFn.mockImplementation(async function* (): AsyncGenerator<StreamEvent> {
      if (round === 0) {
        yield { type: 'tool_call', id: 't1', name: 'nope', args: {} }
        yield { type: 'done', stopReason: 'tool_use' }
      } else {
        yield { type: 'text_delta', delta: 'ok' }
        yield { type: 'done', stopReason: 'end_turn' }
      }
      round++
    })

    const events: { type: string; [k: string]: unknown }[] = []
    for await (const e of runAgent(model, { messages: [] }, [] as AgentTool[])) events.push(e)

    const tr = events.find(e => e.type === 'tool_result') as { result: string }
    expect(tr.result).toContain('not found')
  })

  it('compaction：切点对齐轮次边界，不拆散 tool_use/tool_result', async () => {
    // 构造 50 条消息，让默认切点（50 - 20 = 30）正好落在 tool_result 上：
    // 29 条填充消息 + assistant(tool_use t1) + user(tool_result r1) + 19 条填充消息。
    // 若切点不对齐，压缩后 recent 会以孤儿 tool_result 开头，下一次请求 API 400。
    const messages: Message[] = []
    for (let i = 0; i < 29; i++) messages.push({ role: 'user', content: `m${i}` })
    messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'echo', input: {} }] })
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r1' }] })
    for (let i = 30; i < 49; i++) messages.push({ role: 'user', content: `m${i}` })

    let round = 0
    mockStreamFn.mockImplementation(async function* (): AsyncGenerator<StreamEvent> {
      if (round === 0) {
        yield { type: 'text_delta', delta: 'SUMMARY' }  // 第一次调用是压缩摘要请求
        yield { type: 'done', stopReason: 'end_turn' }
      } else {
        yield { type: 'text_delta', delta: 'ok' }
        yield { type: 'done', stopReason: 'end_turn' }
      }
      round++
    })

    const ctx: Context = { messages }
    const events: { type: string; [k: string]: unknown }[] = []
    for await (const e of runAgent(model, ctx, [] as AgentTool[])) events.push(e)

    expect(events.at(-1)).toEqual({ type: 'turn_end', stopReason: 'end_turn' })

    // 摘要请求的输入（old 侧）必须包含完整的 tool_use/tool_result 配对
    const summaryCall = mockStreamFn.mock.calls[0] as unknown as [unknown, Context]
    const summaryInput = summaryCall[1].messages[0].content as string
    expect(summaryInput).toContain('tool_use')
    expect(summaryInput).toContain('"tool_use_id":"t1"')

    // 压缩后的 recent 以 m30 开头，而不是被切出来的孤儿 tool_result
    expect(ctx.messages[0].content).toBe('[context summary]\nSUMMARY')
    expect(ctx.messages[1]).toEqual({ role: 'user', content: 'm30' })
  })
})
