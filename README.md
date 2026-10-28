# Bria Video Cutout

新增 **[独立 API 服务端](docs/STANDALONE_SERVER.md)**：供单独网页或 APP 调用。本地构建一个内置服务端 Bria Token 的私有镜像，服务器执行 `docker load -i images.tar`、`docker compose up -d`；镜像不包含网页、Nginx 或 Caddy。支持独立接口认证和精确 CORS，启动及接入命令见 [镜像交付与启动命令](docs/镜像交付与启动命令.md)。以下原架构与开发命令继续保留。

在线网页 + Cloudflare API + 本地 FFmpeg 的视频抠图工具。线上普通模式只需打开部署后的 HTTPS 网址，在浏览器内处理；本地原生模式通过 Node.js 调用 ffmpeg.exe 合成与编码。AI 仅使用 Bria。

## 当前架构

- Cloudflare Worker 托管前端及 `/browser/*` API；访问 Token 链接换取 HttpOnly 会话（支持永久链接），不要求 Cloudflare 账号。Access JWT 为可选模式。
- D1 保存云端任务、归属、上传引用和去重记录。
- R2 私有临时桶接收 8 MiB 分片；Worker 流式转交给 Bria，成功后删除临时文件。异常遗留文件通过桶生命周期清理。
- FFmpeg WebAssembly 在浏览器运行。素材、任务、Alpha／Mask 和成片保存在当前浏览器的 IndexedDB，预览／下载使用本机 Blob URL。
- 本地原生模式沿用上述任务与缓存，最终结果校验、合成、编码交给回环地址 3002 的原生服务，导入探测和必要的上传前处理仍用 WASM。服务不调用 Bria，失败可复用原结果恢复导出。
- 自动模式整段 MP4／MOV／WebM／AVI 通过格式、编码及时长检查后原文件直传；裁选、文字／点选代理及 GIF 兼容处理仍按需编码。首次导入仍需读取元数据，换背景和最终导出仍可能进行本地合成／编码。
- 页面关闭后本地计算停止；重新打开同一站点、同一浏览器，可从保存阶段恢复。已尝试提交的任务仅查询原云端 ID，不自动重新付费提交。

生产配置、访问链接生成及发布记录：[docs/CLOUD.md](docs/CLOUD.md)。

## 功能与边界

自动识别、文字描述、正负点三种模式；白色默认，共十种预设纯色；输出尺寸、比例和帧率跟随源片段，MP4／H.264。保留音轨，支持复用 Alpha／Mask 换色；不支持背景图片上传。43 寸设备只播放下载的成片。

Bria 自动模式最长 60 秒：[官方自动接口](https://docs.bria.ai/video-editing/editing/remove-background)。文字／点选最长 5 秒、Mask 最高 750p：[文字接口](https://docs.bria.ai/video-editing/masking/mask-by-prompt)、[点选接口](https://docs.bria.ai/video-editing/masking/mask-by-key-points)。本项目生成 1280×720 范围内代理，按原片尺寸合成；4K 文件不代表原生 4K Mask。约束与工程选择对照见 [SOURCES.md](docs/SOURCES.md)。

浏览器 WASM 性能及可用内存不同于原生 FFmpeg；当前通过短片与合成 4K 三帧冒烟，未承诺复杂长片的耗时或内存上限。浏览器缓存不是云端备份；清除站点数据会丢失素材与成片，及时下载所需文件。

## 本地开发（只用于开发，不是用户运行要求）

### 当前默认：前端连接独立 Docker API

本次已创建被 Git 忽略的 `apps/web/.env.server.local`，配置 `CUTOUT_API_BASE_URL=http://127.0.0.1:3001`、`CUTOUT_API_USERNAME=admin` 和交付包的接口密码；不是 Bria Token。环境变量由网页启动进程读取，代理统一附加认证，浏览器不需要登录，也不接收接口密码。

```powershell
docker compose -f .tmp/releases/backend-20261028-v1/compose.yaml up -d
npm run dev
```

打开 **http://localhost:8080**，对应 API 的默认 WEB_ORIGIN。不要改用 `127.0.0.1:8080`，除非同步修改 API 的 WEB_ORIGIN。初次在其他机器配置时，复制 `apps/web/server-config.template` 为 `apps/web/.env.server.local` 并填写接口密码；修改配置后重启前端。默认启动不再依赖本地 Worker/WASM/native 服务。下文是保留的旧开发入口。

### 原 Cloudflare / 浏览器处理入口

需要 Node.js 22.12+ 与 npm。此旧浏览器入口不代理 3001。

```powershell
npm ci
npm run build
npm run db:local -w apps/worker
```

仅在不存在时，将 `apps/worker/config.template` 复制为 `apps/worker/.dev.vars`，填入开发环境变量。`DEV_AUTH=1` 仅对回环地址生效，公网请求仍要求有效会话（或所选 Access 模式的 JWT）；真实 Bria Token 会导致实际请求计费。

Worker 开发脚本显式使用 `--local-upstream 127.0.0.1`，避免 Wrangler 从生产路由推导请求域名、导致本地免登录不生效。若 5174 已被其他项目占用，可用 `npm run dev:browser -w apps/web -- --port 5175` 启动旧前端，再访问 `http://127.0.0.1:5175/`。

```powershell
# 终端 1：本地模拟 Worker、D1、R2
npm run dev:worker
# 终端 2：前端 http://localhost:5174
npm run dev:browser -w apps/web
```

根目录 `.env.development` 的 `BRIA_TRANSPORT`、`CUTOUT_CLOUD_URL`、`CUTOUT_CLOUD_TOKEN` 属于旧 Node API 配置，新网页不读取这些凭据。

### 本机原生 FFmpeg 模式

配置本机 `FFMPEG_PATH`、`FFPROBE_PATH`（可沿用 Git 忽略的 `.env.development`，或把工具加入 PATH）。完成上述本地 Worker 配置后运行：

```powershell
npm run dev:local
```

访问 `http://127.0.0.1:5175/`，顶部显示“本机 FFmpeg 导出模式”。该命令启动 Worker 8787、原生服务 3002 和前端 5175；不要与已占用这些端口的服务重复启动。已有 Worker 时可分别运行 `npm run dev:native` 和 `npm run dev:native -w apps/web`。

刷新同一地址可继续使用原 IndexedDB 任务。已有失败任务点“恢复任务”，已有成片可换色重新导出，不需要再抠图。当前使用原生 CPU H.264 编码，未启用 GPU；原生服务不可用时明确报错，不自动改用 WASM。保持页面打开直到成片返回缓存，关闭页面可能使本机编码继续但无法接收成片，恢复时只重做本地导出。中转文件在正常请求结束或失败后清除；强制终止服务可能留下 `data/native` 临时文件。

这是本地启动模式，不会让线上 HTTPS 页面自动调用本机工具，也不需要启动旧 3001 API。

## 验证

```powershell
npm run typecheck
npm run build
npm run test:worker
npm run test:browser
npm run test:browser:native
npm run test:local
```

`build` 只 dry-run 打包，不部署。浏览器测试使用 Playwright 和本机 Chrome／Edge（也可设置 `BROWSER_TEST_EXECUTABLE`），Bria HTTP 被模拟；FFmpeg WASM 真实运行。`test:browser:native` 启用真实原生服务验证浏览器导出、换色及失败恢复。测试生成素材及本地回归测试需要原生 FFmpeg／FFprobe，可沿用 `.env.development` 中的工具路径。

旧 3001 API 与 `/v1/*` 保留用于历史兼容和回归，新网页没有 3001 依赖；原生合成服务复用 `apps/api` 中的媒体处理函数。Matroska 仅作为可信上游结果解析，仍不允许作为用户上传格式。原 `data/` 文件不会自动导入 IndexedDB，也不会被删除。

## 文档

- [部署和运行](docs/CLOUD.md)
- [总体方案](docs/PLAN.md)
- [技术细节](docs/技术细节.md)
- [接口契约](docs/API_CONTRACT.md)
- [验证记录](docs/QA.md)
- [进度与限制](docs/PROGRESS.md)
