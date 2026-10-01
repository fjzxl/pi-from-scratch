// scripts/check-teaching-slices.mjs
// 教学切片守护脚本 —— 改动 src/ 之后跑一下，确认教学网站还能正确构建。
//
// 为什么需要它：web/app/lesson-data.ts 用硬编码行号从源码里截取教学片段，
// 给 src/ 加一行注释，后面所有行号就会偏移，网站的分阶段代码会错乱或直接构建失败。
// 这个脚本把"改完源码 → 网站还能用"这件事变成一条可执行的检查。
//
// 它做两件事：
//   1. 快照同步检查：web/app/content.generated.ts 里的源码是否与 src/ 一致
//      （不一致说明忘了跑 `npm run generate:content`）
//   2. 断言执行：真正加载 lesson-data.ts，让它自带的
//      assertProgressiveCheckpoints / assertCheckpointOrder 跑一遍
//
// 用法：npm run check:slices
// 依赖：在项目根目录执行过 npm install（tsx 在根目录 devDependencies 中，web/ 无需单独安装）

import { readFileSync, writeFileSync, mkdtempSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, "..");
const web = resolve(projectRoot, "web");
const SOURCE_PATHS = ["src/llm.ts", "src/agent.ts", "src/tools.ts", "src/tui.ts", "src/cli.ts"];

let failed = false;

// ---------- 1. 快照是否与 src/ 同步 ----------
const generatedPath = join(web, "app/content.generated.ts");
if (!existsSync(generatedPath)) {
  console.error("❌ 找不到 web/app/content.generated.ts，请先在 web/ 运行 npm run generate:content");
  process.exit(1);
}
const generated = readFileSync(generatedPath, "utf8");
const snapshot = JSON.parse(generated.match(/export const sourceFiles = ([\s\S]*?) as const;/)[1]);

console.log("检查 1/2：内容快照是否与 src/ 同步");
let stale = 0;
for (const path of SOURCE_PATHS) {
  const onDisk = readFileSync(join(projectRoot, path), "utf8").replace(/\r\n/g, "\n");
  const inSnapshot = (snapshot[path] ?? "").replace(/\r\n/g, "\n");
  if (onDisk !== inSnapshot) {
    stale++;
    console.log(`  ❌ ${path} 与快照不一致 —— 请运行：cd web && npm run generate:content`);
  }
}
if (stale === 0) console.log("  ✅ 5 个源码文件均与快照一致");
else failed = true;
console.log("");

// ---------- 2. 执行 lesson-data.ts 自带断言 ----------
console.log("检查 2/2：教学切片递进断言（assertProgressiveCheckpoints）");
// tsx 来自根目录的 devDependencies（web/ 没有单独安装它）
if (!existsSync(join(projectRoot, "node_modules", "tsx"))) {
  console.log("  ⚠️  跳过：根目录依赖未安装（npm install 后可运行本检查）");
  process.exit(failed ? 1 : 0);
}

const lessonData = readFileSync(join(web, "app/lesson-data.ts"), "utf8");
const lessonMarkdown = JSON.parse(
  generated.match(/export const lessonMarkdown = ([\s\S]*?) as const;/)[1],
);

// 去掉 import（内容以字面量注入），其余逻辑原样保留后执行
const runner =
  `const lessonMarkdown = ${JSON.stringify(lessonMarkdown)} as const;\n` +
  `const sourceFiles = ${JSON.stringify(snapshot)} as const;\n` +
  lessonData.replace(/^import .*$/gm, "") +
  `\nconsole.log("  ✅ 断言通过：第一章 " + lessons.chapter1.checkpoints.length +
     " 个 checkpoint，第二章 " + lessons.chapter2.checkpoints.length + " 个");\n`;

const dir = mkdtempSync(join(tmpdir(), "nanopi-slices-"));
const file = join(dir, "check.mts");
writeFileSync(file, runner, "utf8");

try {
  // Windows 上 npx 是 .cmd，必须走 shell 才能解析
  const out = execFileSync("npx", ["tsx", file], {
    encoding: "utf8",
    cwd: projectRoot,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  console.log(out.trim());
} catch (e) {
  failed = true;
  const msg = (e.stderr || e.stdout || e.message || "").toString();
  console.log("  ❌ 断言失败。常见原因：改了 src/ 的行数，但没同步 lesson-data.ts 里的 selectLines 区间。");
  const hit = msg.match(/Error: ([^\n]+)/);
  if (hit) console.log(`     ${hit[1]}`);
  console.log("     提示：区间应按内容对齐后整体平移，llm.ts/agent.ts 改动行数最常见。");
  if (process.env.SLICES_DEBUG) console.log(msg);
}

process.exit(failed ? 1 : 0);
