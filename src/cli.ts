// src/cli.ts
// 拼装层 —— 把 llm / agent / tui / tools 粘起来，是唯一入口。
// session 持久化：每轮结束追加新消息到 ~/.nanopi/session.jsonl（当前用户共享，不按项目分开）；
// compaction 会缩短消息数组，persistSession 检测到错位后整体重写文件（见下方对齐校验）。
// 环境变量：除 export 外也支持从 .env 文件读取（Node 20.12+ 内置 loadEnvFile，零依赖）。

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { pathToFileURL } from 'node:url'
import { runAgent } from './agent.js'
import { Tui } from './tui.js'
import { builtinTools } from './tools.js'
import type { Model, Context, Message } from './llm.js'

const SESSION_DIR = path.join(os.homedir(), '.nanopi')
const SESSION_FILE = path.join(SESSION_DIR, 'session.jsonl')  // JSONL：一行一条消息，追加写入不用先读整个文件

/** 固定 system prompt */
const SYSTEM_PROMPT = '你是一个编码助手。用提供的工具读写文件和执行命令来完成任务。先阅读再修改，修改后可运行命令验证。'

// 持久化进度：persistedCount 是已写入的消息条数，lastPersisted 是最后一条已写入消息的引用。
// 这是 CLI 进程级状态（非 agent 状态——agent 本身无状态，context 就是状态）。
let persistedCount = 0
let lastPersisted: Message | undefined

async function main() {
  loadDotEnv()  // 从当前工作目录读 .env，再取配置；终端已有的环境变量优先
  const apiKey = process.env.NANOPI_API_KEY
  if (!apiKey) {
    console.error('请设置 NANOPI_API_KEY 环境变量（或在 .env 文件中配置）')
    process.exit(1)
  }

  const model: Model = {
    apiKey,
    model: process.env.NANOPI_MODEL ?? 'glm-5.2',
    baseUrl: process.env.NANOPI_BASE_URL ?? 'https://api.openai.com/v1',
    maxTokens: 4096,
  }

  // 初始化 context：system prompt 用专用字段，messages 从 session 文件加载
  const context: Context = {
    systemPrompt: SYSTEM_PROMPT,
    messages: await loadSession(),
  }

  const tools = builtinTools()  // 四个内置工具：read_file / write_file / edit / run_bash
  const tui = new Tui()         // 终端界面：负责读输入、打印输出

  // 每轮：用户输入 → runAgent → 事件转发到 TUI → 持久化
  tui.onPrompt(async (text) => {
    try {
      context.messages.push({ role: 'user', content: text })  // 先记录输入，模型才能在 Context 中看到任务

      tui.setBusy(true)  // 锁定输入，agent 干活期间不响应新 prompt
      const ctrl = new AbortController()  // 本轮的中断开关，Ctrl+C 经它中断请求和工具
      tui.onAbort(() => ctrl.abort())  // 每轮新建 AbortController，需重新注册回调指向新的 controller

      for await (const ev of runAgent(model, context, tools, ctrl.signal)) {  // 逐个消费事件，不必等整个任务完成
        switch (ev.type) {
          case 'assistant_text': tui.printText(ev.delta); break
          case 'tool_call': tui.printToolCall(ev.name, ev.args); break
          case 'tool_result': tui.printToolResult(ev.name, ev.result); break
          case 'turn_end':
            if (ev.stopReason === 'max_tokens') tui.printText('\n[output truncated by max_tokens]')
            if (ev.stopReason === 'error') tui.printText('\n[error occurred]')
            tui.printTurnEnd()
            break
        }
      }

      await persistSession(context.messages)  // 保存 Agent 更新后的消息；不把 Model 中的密钥写入会话
    } catch (e) {
      console.error(`\n[error] ${(e as Error).message}`)
    } finally {
      tui.setBusy(false)
    }
  })

  tui.start()

}

/** 启动时加载历史 messages，恢复上次对话（导出供测试） */
export async function loadSession(file: string = SESSION_FILE): Promise<Message[]> {
  try {
    const data = await fs.readFile(file, 'utf-8')
    const lines = data.trim().split('\n').filter(Boolean)
    // 逐行容错：跳过损坏行而非丢弃全部历史（进程崩溃可能写出半行 JSON）
    const messages = lines.flatMap(line => {
      try { return [JSON.parse(line) as Message] } catch { return [] }
    })
    persistedCount = messages.length  // 已加载的不重复写
    lastPersisted = messages[messages.length - 1]
    return messages
  } catch {
    persistedCount = 0  // 文件不存在，从空开始
    lastPersisted = undefined
    return []
  }
}

/** 持久化 messages 到 session 文件（导出供测试）。
 *  常规路径是追加：只写 persistedCount 之后的新增消息。
 *  compaction 会整体替换 context.messages（数组变短、下标偏移），按计数追加会丢消息或写错位置，
 *  所以用 lastPersisted 校验尾部对齐：对不上就整体重写文件，让文件与内存中的 context 重新一致。 */
export async function persistSession(messages: Message[], file: string = SESSION_FILE): Promise<void> {
  await fs.mkdir(path.dirname(file) || '.', { recursive: true })
  const aligned = messages.length >= persistedCount
    && (persistedCount === 0 || messages[persistedCount - 1] === lastPersisted)
  if (aligned) {
    for (const msg of messages.slice(persistedCount)) {
      await fs.appendFile(file, JSON.stringify(msg) + '\n', 'utf-8')
    }
  } else {
    // 整体重写：旧的原始历史被"摘要 + 保留的近期消息"替换，文件重新与内存对齐
    await fs.writeFile(file, messages.map(m => JSON.stringify(m) + '\n').join(''), 'utf-8')
  }
  persistedCount = messages.length
  lastPersisted = messages[messages.length - 1]
}

/** 从 .env 文件加载环境变量（导出供测试）。
 *  用 Node 20.12+ 内置的 process.loadEnvFile（本项目要求 22.13+），不引入 dotenv 依赖。
 *  不覆盖已存在的环境变量；文件不存在就静默跳过（.env 是可选的）。 */
export function loadDotEnv(file: string = '.env'): void {
  try {
    process.loadEnvFile(file)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
  }
}

// 只在直接运行时启动（非 import 时）。必须用 pathToFileURL 把路径转成标准 file:// URL 再比较：
// Windows 路径带盘符和反斜杠，`file://${process.argv[1]}` 这种字符串拼接永远不等，
// 会让 npm run dev 在 Windows 上静默退出（入口代码看似存在却从未执行）。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
