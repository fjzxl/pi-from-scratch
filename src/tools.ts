// src/tools.ts
// 4 个内置工具 —— 能读写改代码并执行验证的最小集，也是 agent 的"手和脚"。
// 每个 tool 是独立执行函数：async (args) => string；有文件/命令副作用，但不修改 Context。
// 注意：教学版不验证 args，生产 agent 应在 execute 前用 parameters validate 参数。

import { promises as fs } from 'node:fs'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import * as path from 'node:path'
import * as os from 'node:os'
import type { AgentTool } from './agent.js'

const execAsync = promisify(exec)

/** 工具输出截取上限（行数），超过则截取尾部并提示 */
const MAX_OUTPUT_LINES = 200

let truncateCounter = 0  // 进程内自增编号，避免临时文件重名

/**
 * 截取工具输出：超过 maxLines 行时只保留尾部，完整输出存到临时文件。为什么要截？
 * 工具结果会原样进入 Context，超长输出浪费 token 还可能撑爆上下文。尾部优先——报错通常在末尾；
 * 读代码时开头往往更重要，教学版不按工具区分策略，这是刻意取舍（pi 按工具分别定义截断规则）。
 */
async function truncateOutput(content: string, maxLines = MAX_OUTPUT_LINES): Promise<string> {
  const lines = content.split('\n')
  if (lines.length <= maxLines) return content
  const kept = lines.slice(-maxLines).join('\n')
  const tmpPath = path.join(os.tmpdir(), `nanopi-output-${process.pid}-${truncateCounter++}.txt`)
  await fs.writeFile(tmpPath, content, 'utf-8')
  return `[output truncated: showing last ${maxLines} of ${lines.length} lines. full output: ${tmpPath}]\n${kept}`
}

/** read_file：返回文件内容（截取尾部防止超大输出）。agent 的"眼睛"——先读再改是基本修养 */
const readFile: AgentTool = {
  name: 'read_file',
  description: '读取文件内容。参数：path（文件路径）。大文件截取最后 200 行。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要读取的文件路径' },
    },
    required: ['path'],
  },
  execute: async (args) => {
    const { path: filePath } = args as { path: string }
    const content = await fs.readFile(filePath, 'utf-8')
    return await truncateOutput(content)
  },
}

/** write_file：覆盖写入整个文件；只改局部文本时使用 edit，避免覆盖其余内容 */
const writeFile: AgentTool = {
  name: 'write_file',
  description: '写入文件（覆盖）。参数：path（路径）、content（内容）',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要写入的文件路径' },
      content: { type: 'string', description: '文件内容' },
    },
    required: ['path', 'content'],
  },
  execute: async (args) => {
    const { path: filePath, content } = args as { path: string; content: string }
    await fs.mkdir(path.dirname(filePath) || '.', { recursive: true })  // 目录不存在就逐级创建，少报一个错
    await fs.writeFile(filePath, content, 'utf-8')
    return `wrote ${filePath} (${content.length} chars)`
  },
}

/** edit：局部字符串替换（精确匹配 + 唯一性校验）。小改用它，比重写整个文件更稳 */
const edit: AgentTool = {
  name: 'edit',
  description: '编辑文件：精确替换一段文本。参数：path、old_string、new_string。old_string 必须在文件中唯一匹配，否则报错。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径' },
      old_string: { type: 'string', description: '要被替换的文本（必须唯一匹配）' },
      new_string: { type: 'string', description: '替换后的文本' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  execute: async (args) => {
    const { path: filePath, old_string, new_string } = args as { path: string; old_string: string; new_string: string }
    const content = await fs.readFile(filePath, 'utf-8')
    const count = content.split(old_string).length - 1  // 原文必须唯一；匹配多处时应提供更多上下文
    if (count === 0) throw new Error(`old_string not found in ${filePath}`)  // 报错给模型，它会重新读文件再试
    if (count > 1) throw new Error(`old_string matches ${count} places in ${filePath}, must be unique`)
    // 用函数替换避免 new_string 中的 $ 特殊字符（$& $` $' $1）被 String.replace 解释
    const newContent = content.replace(old_string, () => new_string)
    await fs.writeFile(filePath, newContent, 'utf-8')
    return `edited ${filePath}: replaced ${old_string.length} chars`
  },
}

/** run_bash：使用系统默认 shell（不保证是 Bash）执行命令；相对路径以进程工作目录为准 */
const runBash: AgentTool = {
  name: 'run_bash',
  description: '执行 shell 命令。参数：command（命令字符串）。返回 stdout+stderr，截取最后 200 行。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的 shell 命令' },
    },
    required: ['command'],
  },
  execute: async (args, signal) => {
    const { command } = args as { command: string }
    try {
      const { stdout, stderr } = await execAsync(command, { maxBuffer: 1024 * 1024, timeout: 30000, signal })  // 最多缓冲 1 MiB，30 秒超时，支持中断
      const output = stderr ? `[stderr] ${stderr}\n[stdout] ${stdout}` : stdout
      return await truncateOutput(output)
    } catch (e: unknown) {
      if (signal?.aborted) return 'aborted'
      const err = e as NodeJS.ErrnoException & { code?: number; stdout?: string; stderr?: string }
      return `[exit ${err.code}] ${err.stderr ?? ''}${err.stdout ?? ''}`  // 命令失败也返回输出，模型能从报错里学着修命令
    }
  },
}

/** 返回全部内置工具。想加新工具？按 AgentTool 格式定义一个加进数组即可，agent 代码不用动 */
export function builtinTools(): AgentTool[] {
  return [readFile, writeFile, edit, runBash]
}
