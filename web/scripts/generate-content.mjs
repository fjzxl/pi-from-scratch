import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "..");
const projectRoot = resolve(webRoot, "..");

const sourcePaths = [
  "src/llm.ts",
  "src/agent.ts",
  "src/tools.ts",
  "src/tui.ts",
  "src/cli.ts",
];

const generatedPath = resolve(webRoot, "app/content.generated.ts");

// 已提交的内容快照。docs/ 里的文章缺失时（普通克隆会缺少被 gitignore 的大纲文件），
// 沿用快照里的文章正文，保证文章内容不会因为缺少大纲而丢失。
const existing = await readFile(generatedPath, "utf8");
const existingLessons = JSON.parse(
  existing.match(/export const lessonMarkdown = ([\s\S]*?) as const;/)[1],
);

const lessonPaths = {
  outline: "docs/pi-from-scratch.md",
  chapter1: "docs/ch01-modules.md",
  chapter2: "docs/ch02-loop.md",
};

// 普通克隆缺少被 gitignore 的大纲源文件时，修正已提交快照中与当前实现不符的几处旧表述。
function refreshFallbackOutline(outline) {
  return outline
    .replace("4 个纯函数", "4 个独立工具（会读写文件、执行命令）")
    .replace("消息超过 50 条", "消息达到 50 条")
    .replace("tui 只是用 `process.stdout.write` 消费它", "cli.ts 接收 AgentEvent，再调用 TUI 的打印方法");
}

const lessons = {};
let keptLessonCount = 0;
for (const [key, relativePath] of Object.entries(lessonPaths)) {
  try {
    lessons[key] = await readFile(resolve(projectRoot, relativePath), "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    if (!(key in existingLessons)) {
      throw new Error(`缺少 ${relativePath}，且快照中没有 ${key}，无法生成教学内容。`);
    }
    lessons[key] = key === "outline"
      ? refreshFallbackOutline(existingLessons[key])
      : existingLessons[key];
    keptLessonCount++;
  }
}

// 源码快照总是从 src/ 重新读取：源码在 Git 中始终存在，
// 教学网站必须跟随 src/ 的最新内容（包括新增的注释）。
const sourceFiles = Object.fromEntries(
  await Promise.all(
    sourcePaths.map(async (path) => [path, await readFile(resolve(projectRoot, path), "utf8")]),
  ),
);

const output = `// Generated from ../docs and ../src. Do not edit by hand.\n\n` +
  `export const lessonMarkdown = ${JSON.stringify(lessons, null, 2)} as const;\n\n` +
  `export const sourceFiles = ${JSON.stringify(sourceFiles, null, 2)} as const;\n`;

await writeFile(generatedPath, output, "utf8");

if (keptLessonCount > 0) {
  console.log(`已更新源码快照；${keptLessonCount}/${Object.keys(lessonPaths).length} 篇文章沿用已提交内容（父级教学源缺失）。`);
} else {
  console.log("已从 ../docs 与 ../src 重新生成教学内容。");
}
