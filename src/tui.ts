// src/tui.ts
// 极简终端界面 —— 单行输入 + 流式输出 + Ctrl+C 打断。
// 不做 differential renderer、不做 component 树、不做 markdown 渲染。
// 这些是"终端 UI 框架"的功课，不是"手撕 agent"的灵魂。

import * as readline from 'readline'

export class Tui {
  private rl: readline.Interface | null = null                  // Node 内置 readline，负责读一行输入
  private onPromptCb: ((text: string) => void) | null = null    // 用户敲回车时通知谁（由 cli.ts 注册）
  private onAbortCb: (() => void) | null = null                 // Ctrl+C 时通知谁
  private aborted = false                                       // 防止一次任务中重复触发 abort
  private busy = false  // agent 运行中阻止并发输入，避免两轮任务同时修改共享的 Context
  private closed = false  // 输入流已结束（Ctrl+D 或管道输入读完），readline 不再接受新输入

  /** 注册 prompt 回调 */
  onPrompt(cb: (text: string) => void): void {
    this.onPromptCb = cb
  }

  /** 注册 Ctrl+C 回调；TUI 只通知 CLI，由 CLI 的 AbortController 向下传递中断 */
  onAbort(cb: () => void): void {
    this.onAbortCb = cb
  }

  /** 启动 TUI，开始读输入 */
  start(): void {
    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    })
    process.stdin.on('keypress', (_ch: string, key: { ctrl?: boolean; name?: string } | undefined) => {
      // 只在 agent 运行时处理 Ctrl+C，空闲时交给 readline 默认行为
      if (this.busy && key?.ctrl && key?.name === 'c' && !this.aborted) {
        this.aborted = true
        this.onAbortCb?.()
      }
    })

    // Ctrl+D / 输入流结束会触发 readline 的 close。不处理的话进程会静默退出，
    // 学习者会以为程序"坏了"；这里记录状态，空闲时明确提示后退出。
    this.rl.on('close', () => {
      this.closed = true
      if (!this.busy) this.exit()
    })

    this.prompt()
  }
  private prompt(): void {
    if (!this.rl) return
    if (this.busy) return  // agent 运行中，不显示 prompt
    if (this.closed) return this.exit()  // agent 结束后输入流已关闭：没有新输入可读，退出
    this.aborted = false  // 新一轮开始，重置 abort 标记
    this.rl.question('> ', (answer) => {
      const text = answer.trim()
      if (text) {
        this.onPromptCb?.(text)
        // 不立即递归 prompt()——等 setBusy(false) 时再调
      } else {
        this.prompt()  // 空输入：重新提示，不触发回调
      }
    })
  }

  /** agent 开始运行时调用，阻止新输入 */
  setBusy(busy: boolean): void {
    this.busy = busy
    if (!busy) this.prompt()  // agent 结束，恢复输入
  }

  /** 输入流结束后退出：打印一行提示，让"程序怎么没了"有答案 */
  private exit(): void {
    process.stdout.write('\n[会话结束]\n')
    process.exit(0)
  }

  /** 流式打印 assistant 文本 delta（增量片段）；write 不自动换行，保留连续输出 */
  printText(delta: string): void {
    process.stdout.write(delta)
  }

  /** 打印 tool 调用 */
  printToolCall(name: string, args: unknown): void {
    process.stdout.write(`\n[tool: ${name}] ${JSON.stringify(args)}\n`)
  }

  /** 打印 tool 结果 */
  printToolResult(name: string, result: string): void {
    process.stdout.write(`[result: ${name}] ${result}\n`)
  }

  /** 回合结束：换行 */
  printTurnEnd(): void {
    process.stdout.write('\n')
  }

  /** 停止 TUI，清理监听器 */
  stop(): void {
    this.rl?.close()
    this.rl = null
    process.stdin.removeAllListeners('keypress')
  }
}
