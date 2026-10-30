# Bria Video Cutout

新增 **[独立 API 服务端](docs/STANDALONE_SERVER.md)**：供单独网页或 APP 调用。本地构建一个内置服务端 Bria Token 的私有镜像，服务器执行 `docker load -i images.tar`、`docker compose up -d`；镜像不包含网页、Nginx 或 Caddy。支持独立接口认证和精确 CORS，启动及接入命令见 [镜像交付与启动命令](docs/镜像交付与启动命令.md)。以下原架构与开发命令继续保留。

在线网页 + Cloudflare API + 本地 FFmpeg 的视频抠图工具。线上普通模式只需打开部署后的 HTTPS 网址，在浏览器内处理；本地原生模式通过 Node.js 调用 ffmpeg.exe 合成与编码。视频抠图使用 Bria；独立服务另支持 Bria / Tripo 图片处理、Tripo 建模和可灵图生视频。

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

图生 3D 及模型渲染链路已移除；历史模型/视频文件保留在数据目录，但不再提供网页入口或模型 API。


服务器处理模式的 **图片白底** 入口：选择 PNG/JPG 上传后自动生成白底旋转视频。页面只展示原图和最终视频，移除中间白底 PNG 预览/下载、单独图片生成按钮和 API 切换；Bria 白底图保留在服务器供可灵使用。服务端原有 Bria / Tripo 图片 API 与缓存仍保留。

服务端自动完成 Bria 白底 PNG → 可灵 3.0 图生视频 → 下载/校验/保存 MP4。已有白底图片直接复用；请求 1080p、6 秒、无声、固定镜头、相对参考朝向左右约 15° 缓慢轻转，实际动作幅度、颜色和纯白背景需检查。页面关闭后服务端继续处理，刷新后从最近任务恢复；打开历史只查询，上传新图片才自动生成。提交结果不明时按原任务标识查询，不自动重发。可灵视频采用 **9:16 预览及查看弹窗**，按比例完整显示，不裁剪或拉伸；下载视频尺寸保持实际生成规格。

可灵配置模板为 `apps/api/.env.kling.example`，复制为 **`apps/api/.env.kling.local`** 后填写 `KLING_API_KEY`，默认 `KLING_API_REGION=china`（北京端点；国际区用 `global`，新加坡端点），重启 `npm run dev:api`。私有文件已被 Git/Docker 忽略，Key 只在服务端使用。可灵输入宽高均至少 300px、比例 1:2.5 至 2.5:1；原图比例不做裁剪，实际视频尺寸记录在结果中。接口与限制来源见 [SOURCES.md](docs/SOURCES.md)。

本地保护范围：20 MiB、单边 8192px、总像素 2400 万；不支持动图。Bria 需要 `BRIA_TRANSPORT=direct` 与服务端 `BRIA_API_TOKEN`；Tripo 独立配置服务端 `TRIPO_API_KEY`、`TRIPO_API_REGION=china`（默认，国际区用 `global`，需匹配账号）。Tripo 另校验规范化图片不超过 20 MB、宽高至少 14px、宽高比 1:3 至 3:1。所有 Key 仅存服务端，不使用 `VITE_*`。需要更新独立 API 和前端；旧服务器或浏览器模式提示功能未启用。配置与官方来源见 [STANDALONE_SERVER.md](docs/STANDALONE_SERVER.md)、[SOURCES.md](docs/SOURCES.md)。

自动识别、文字描述、正负点三种模式；白色默认，共十种预设纯色；输出尺寸、比例和帧率跟随源片段，MP4／H.264。保留音轨，支持复用 Alpha／Mask 换色；不支持背景图片上传。43 寸设备只播放下载的成片。

Bria 自动模式最长 60 秒：[官方自动接口](https://docs.bria.ai/video-editing/editing/remove-background)。文字／点选最长 5 秒、Mask 最高 750p：[文字接口](https://docs.bria.ai/video-editing/masking/mask-by-prompt)、[点选接口](https://docs.bria.ai/video-editing/masking/mask-by-key-points)。本项目生成 1280×720 范围内代理，按原片尺寸合成；4K 文件不代表原生 4K Mask。约束与工程选择对照见 [SOURCES.md](docs/SOURCES.md)。

浏览器 WASM 性能及可用内存不同于原生 FFmpeg；当前通过短片与合成 4K 三帧冒烟，未承诺复杂长片的耗时或内存上限。浏览器缓存不是云端备份；清除站点数据会丢失素材与成片，及时下载所需文件。

## 本地开发（只用于开发，不是用户运行要求）

### 当前本机：前端连接源码 API

本机被 Git 忽略的 `apps/web/.env.server.local` 已切换为 `CUTOUT_API_BASE_URL=http://127.0.0.1:3001`、`CUTOUT_API_PATH_PREFIX=`。浏览器请求 `/bria-cutout/api/...`，Vite 代理转成后端 `/api/...`。原远端配置已备份到 `.tmp/local-start/`；需要远端时恢复 BASE_URL 为 `http://10.28.111.20`、PATH_PREFIX 为 `/bria-cutout` 并重启前端。接口凭据只由代理读取，不进入网页脚本。

```powershell
# 终端 1：本机需有 Node.js 22.12+、npm 依赖及 FFmpeg/FFprobe
npm run dev:api
# 终端 2
npm run dev
```

打开 **http://localhost:8080**；`dev:api` 在未显式配置时设置这一 WEB_ORIGIN。不要改用 `127.0.0.1:8080`，除非同步修改 API 的 WEB_ORIGIN。后端从进程环境、`apps/api/.env.kling.local`、`apps/api/.env`、`.env`、`.env.development` 按顺序读取配置，前者优先；平台 Key 仅放服务端。源码 API 仅监听回环地址，默认不启用生产认证；正式部署使用下述独立服务包。

如需切回本机 Docker API，先停止源码 API 释放 3001，再启动交付包，并将其 PRIVATE_ACCESS.txt 中的接口凭据填入前端本地配置。远端部署方式见 [Nginx 独立 API 入口](docs/NGINX_GATEWAY.md)。

### 导出独立服务包（Windows）

启动 Docker Desktop Linux 引擎后运行 `npm run package:server`。默认按时间命名，输出 `.tmp/releases/backend-年月日-时分秒/`，包含 `images.tar`、Compose、访问凭据、启动文档及校验文件；只包含 API，不包含网页或本机历史数据。可用 `npm run package:server -- -Tag 自定义版本 -TokenFile 私有配置文件` 指定版本/配置。默认读取与本地 API 相同的环境配置，包含可选 Tripo / Kling Key；包内镜像含服务端密钥，只作私有交付。不会自动部署或推送镜像。目标机启动步骤见 [镜像交付与启动命令](docs/镜像交付与启动命令.md)。

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
