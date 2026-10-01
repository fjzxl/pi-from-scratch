# PI from Scratch Web

交互式教学网站。正文来自根目录的 `docs/`，源码快照来自 `src/`；源文件齐全时，构建前会自动同步，否则使用已提交的内容快照。

首次接触项目可以先看[新手入门指南](../docs/getting-started.md)和[项目逻辑图](../docs/architecture.md)。以下命令在 `web/` 目录执行。

```bash
npm install
npm run dev
```

如果通过 `npm run dev` 输出的局域网 `Network` 地址访问开发站点，需要允许对应的 hostname，否则 Next.js 可能会阻止开发资源（包括 HMR），导致页面交互失效。例如：

```bash
NEXT_ALLOWED_DEV_ORIGINS=192.168.31.245 npm run dev
```

多个 hostname 可以用逗号分隔：

```bash
NEXT_ALLOWED_DEV_ORIGINS=192.168.31.245,my-dev-host.local npm run dev
```

修改配置后需要重启开发服务器。

生产构建：

```bash
npm run build
```

网站使用离线 trace，不需要 API Key。

Windows PowerShell 的启动命令，以及内容生成缺少大纲文件时使用已提交快照的说明，见[新手指南的教学网站章节](../docs/getting-started.md#4-本地运行教学网站)。
