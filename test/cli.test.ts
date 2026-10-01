// test/cli.test.ts
// 测试 session 持久化的核心 round-trip。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { loadSession, persistSession, loadDotEnv } from '../src/cli.js'
import type { Message } from '../src/llm.js'

let tmpFile: string

beforeEach(() => { tmpFile = path.join(os.tmpdir(), `nanopi-session-${Date.now()}.jsonl`) })
afterEach(async () => { await fs.rm(tmpFile, { force: true }) })

describe('session persistence', () => {
  it('persist → load round-trip', async () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]
    await persistSession(messages, tmpFile)
    expect(await loadSession(tmpFile)).toEqual(messages)
  })

  it('compaction 缩短消息数组后，持久化整体重写而不是丢消息', async () => {
    await loadSession(tmpFile)  // 同步模块内持久化进度（与 CLI 启动行为一致）
    const messages: Message[] = []
    for (let i = 0; i < 50; i++) messages.push({ role: 'user', content: `m${i}` })
    await persistSession(messages, tmpFile)

    // 模拟 compaction：context.messages 被替换成更短的数组（摘要 + 保留 20 条），本轮又新增 1 条
    const compacted: Message[] = [
      { role: 'user', content: '[context summary]\n旧对话的摘要' },
      ...messages.slice(-20),
      { role: 'assistant', content: '压缩后新增的回复' },
    ]
    await persistSession(compacted, tmpFile)
    // 文件必须与压缩后的数组完全一致：无丢失、无重复、无错位
    expect(await loadSession(tmpFile)).toEqual(compacted)

    // 压缩后的下一轮继续追加：只写新增消息，之前的内容不动
    const nextTurn: Message[] = [...compacted, { role: 'user', content: '下一轮输入' }]
    await persistSession(nextTurn, tmpFile)
    expect(await loadSession(tmpFile)).toEqual(nextTurn)
  })

  it('compaction 后数组又长回旧长度时，不错位追加', async () => {
    await loadSession(tmpFile)
    const messages: Message[] = []
    for (let i = 0; i < 50; i++) messages.push({ role: 'user', content: `old-${i}` })
    await persistSession(messages, tmpFile)

    // 压缩成 21 条后，同一个长轮次里又追加 30 条：轮末长度 51 >= 旧的已持久化计数 50，
    // 旧实现会从下标 50 开始追加，把错位内容写进文件。
    const compactedAndGrown: Message[] = [
      { role: 'user', content: '[context summary]\n旧对话的摘要' },
      ...messages.slice(-20),
    ]
    for (let i = 0; i < 30; i++) compactedAndGrown.push({ role: 'assistant', content: `new-${i}` })
    await persistSession(compactedAndGrown, tmpFile)
    expect(await loadSession(tmpFile)).toEqual(compactedAndGrown)
  })
})

describe('loadDotEnv', () => {
  const KEY = 'NANOPI_TEST_DOTENV'

  afterEach(() => { delete process.env[KEY] })

  it('从 .env 文件读取变量', async () => {
    await fs.writeFile(tmpFile, `${KEY}=from-dotenv\n`, 'utf-8')
    loadDotEnv(tmpFile)
    expect(process.env[KEY]).toBe('from-dotenv')
  })

  it('不覆盖已存在的环境变量', async () => {
    process.env[KEY] = 'from-shell'
    await fs.writeFile(tmpFile, `${KEY}=from-dotenv\n`, 'utf-8')
    loadDotEnv(tmpFile)
    expect(process.env[KEY]).toBe('from-shell')
  })

  it('.env 不存在时静默跳过', () => {
    expect(() => loadDotEnv(path.join(os.tmpdir(), 'nanopi-no-such-file.env'))).not.toThrow()
  })
})
