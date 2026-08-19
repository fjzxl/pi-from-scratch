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
