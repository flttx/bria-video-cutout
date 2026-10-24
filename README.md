# Bria Video Cutout

在线网页 + Cloudflare API + 浏览器本地 FFmpeg 的视频抠图工具。正常使用只需打开部署后的 HTTPS 网址，无需本机 Node.js、3001 服务或 ffmpeg.exe。AI 仅使用 Bria；确定性的视频预处理、合成与编码在本机浏览器执行。

## 当前架构

- Cloudflare Worker 托管前端及 `/browser/*` API；访问 Token 链接换取 HttpOnly 会话（支持永久链接），不要求 Cloudflare 账号。Access JWT 为可选模式。
- D1 保存云端任务、归属、上传引用和去重记录。
- R2 私有临时桶接收 8 MiB 分片；Worker 流式转交给 Bria，成功后删除临时文件。异常遗留文件通过桶生命周期清理。
- FFmpeg WebAssembly 在浏览器运行。素材、任务、Alpha／Mask 和成片保存在当前浏览器的 IndexedDB，预览／下载使用本机 Blob URL。
- 页面关闭后本地计算停止；重新打开同一站点、同一浏览器，可从保存阶段恢复。已尝试提交的任务仅查询原云端 ID，不自动重新付费提交。

生产配置、访问链接生成及发布记录：[docs/CLOUD.md](docs/CLOUD.md)。

## 功能与边界

自动识别、文字描述、正负点三种模式；白色默认，共十种预设纯色；输出尺寸、比例和帧率跟随源片段，MP4／H.264。保留音轨，支持复用 Alpha／Mask 换色；不支持背景图片上传。43 寸设备只播放下载的成片。

Bria 自动模式最长 60 秒：[官方自动接口](https://docs.bria.ai/video-editing/editing/remove-background)。文字／点选最长 5 秒、Mask 最高 750p：[文字接口](https://docs.bria.ai/video-editing/masking/mask-by-prompt)、[点选接口](https://docs.bria.ai/video-editing/masking/mask-by-key-points)。本项目生成 1280×720 范围内代理，按原片尺寸合成；4K 文件不代表原生 4K Mask。约束与工程选择对照见 [SOURCES.md](docs/SOURCES.md)。

浏览器 WASM 性能及可用内存不同于原生 FFmpeg；当前通过短片与合成 4K 三帧冒烟，未承诺复杂长片的耗时或内存上限。浏览器缓存不是云端备份；清除站点数据会丢失素材与成片，及时下载所需文件。

## 本地开发（只用于开发，不是用户运行要求）

需要 Node.js 22.12+ 与 npm。新前端不再代理 3001。

```powershell
npm ci
npm run build
npm run db:local -w apps/worker
```

仅在不存在时，将 `apps/worker/config.template` 复制为 `apps/worker/.dev.vars`，填入开发环境变量。`DEV_AUTH=1` 仅对回环地址生效，公网请求仍要求有效会话（或所选 Access 模式的 JWT）；真实 Bria Token 会导致实际请求计费。

```powershell
# 终端 1：本地模拟 Worker、D1、R2
npm run dev:worker
# 终端 2：前端 http://localhost:5174
npm run dev
```

根目录 `.env.development` 的 `BRIA_TRANSPORT`、`CUTOUT_CLOUD_URL`、`CUTOUT_CLOUD_TOKEN` 和原生工具路径属于旧 Node API 配置，新网页不读取这些凭据。

## 验证

```powershell
npm run typecheck
npm run build
npm run test:worker
npm run test:browser
npm run test:local
```

`build` 只 dry-run 打包，不部署。浏览器测试使用 Playwright 和本机 Chrome／Edge（也可设置 `BROWSER_TEST_EXECUTABLE`），Bria HTTP 被模拟；FFmpeg WASM 真实运行。测试生成素材及旧回归测试需要原生 FFmpeg／FFprobe，可沿用 `.env.development` 中的工具路径。

旧 `apps/api` 与 `/v1/*` 仅保留用于历史兼容和回归，新网页没有 3001 依赖。旧 Matroska Alpha 测试仍有容器校验基线失败，详见 [PROGRESS.md](docs/PROGRESS.md)。原 `data/` 文件不会自动导入 IndexedDB，也不会被删除。

## 文档

- [部署和运行](docs/CLOUD.md)
- [总体方案](docs/PLAN.md)
- [技术细节](docs/技术细节.md)
- [接口契约](docs/API_CONTRACT.md)
- [验证记录](docs/QA.md)
- [进度与限制](docs/PROGRESS.md)
