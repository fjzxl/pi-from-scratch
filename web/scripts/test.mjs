// web 的跨平台测试入口：生成内容 → 以 .next-test 为构建目录执行 next build → 运行 tests/。
// 为什么由 Node 编排：npm 在 Windows 上默认用 cmd.exe 执行 scripts，
// 不支持 `VAR=value command` 这种 Unix 环境变量前缀，所以在 Node 里设置好环境变量再启动子进程。
process.env.NEXT_DIST_DIR ??= ".next-test";

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nextBin = join(webRoot, "node_modules", "next", "dist", "bin", "next");

function run(label, args) {
  process.stdout.write(`> ${label}\n`);
  const result = spawnSync(process.execPath, args, { cwd: webRoot, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("generate:content", [join(webRoot, "scripts", "generate-content.mjs")]);
run("next build --webpack", [nextBin, "build", "--webpack"]);
// 用 glob 而不是目录参数：部分 Node 版本会把目录当模块加载
run("node --test tests/*.test.mjs", ["--test", "tests/*.test.mjs"]);
