# Bria Video Cutout Demo

本地运行的 Bria 视频抠图 Demo。可选 Cloudflare Workers + D1 管理云端请求，视频处理仍留在本机。AI 仅使用 Bria Video API；FFmpeg 用于视频预处理、Mask 合成与编码。最终把文件拷贝到 43 寸设备播放，设备不运行本项目。

## 功能边界
- 三种模式：自动前景、Prompt 指定目标、正负点指定实例。
- 默认白色背景；黑灰红绿蓝黄青洋红橙，共十种预设色。
- 输出尺寸、画面比例及帧率跟随原视频，MP4 / H.264；无需选择导出规格。
- 输入格式与编码按 Bria 官方 API 校验；AVI/GIF 与浏览器无法播放的受支持视频会生成本地兼容预览。
- 不支持自定义背景图片；不支持其他 AI 模型；无设备端交互应用。

## 当前进度
已接通本地上传、Bria 异步抠图/Mask、任务恢复、FFmpeg 合成、源尺寸 MP4 预览与下载。三种模式各完成一次短片真实联调；复杂视频质量与 43 寸设备兼容性仍待专项验收。

## 环境
Node.js 22.12+、npm、FFmpeg/FFprobe。检测到本机 Node 24.18.0 和 FFmpeg 9。

## 启动（Windows PowerShell）
    cd E:\Projects\jupiter\bria-video-cutout
    npm install
    # 仅在没有 env 文件时复制模板；已有配置不要覆盖
    Copy-Item apps\api\config.template apps\api\.env
    npm run dev

浏览器：http://localhost:5174
后端：http://localhost:3001/api/health

在服务端 env 文件设置 `BRIA_API_TOKEN`。已经存在的根目录 `.env.development` 可直接使用，无需复制。优先级：进程环境变量 → `apps/api/.env` → 根 `.env` → 根 `.env.development`。这些文件均被忽略，Token 不返回前端。默认前端端口为 5174，避免与参考平台占用的 5173 冲突。

检查：
    npm run typecheck
    npm test
    npm run build

## 方案与验收文档
- docs/PLAN.md
- [技术细节](docs/技术细节.md)
- docs/API_CONTRACT.md
- docs/QA.md
- docs/PROGRESS.md

Bria 官方文档：https://docs.bria.ai/video-editing

## 云端接口模式

默认保留 direct 直连模式。设置 `BRIA_TRANSPORT=cloud`、`CUTOUT_CLOUD_URL` 和 `CUTOUT_CLOUD_TOKEN` 后，新任务经 Workers 调用 Bria，D1 负责去重与恢复。Worker 的 Bria Token 保存在 Secrets，视频由本地 Node.js 直接上传／下载；浏览器不接触云端凭据。旧任务按其原模式恢复，不自动回退或重发。

完整配置、本地运行、手动部署与验证步骤见 [Workers + D1 运行与部署](docs/CLOUD.md)。本地开发使用 `npm run dev:worker`；`npm run build` 仅执行 Worker 打包 dry-run，不会发布。

## 使用

1. 选择本地视频。设置自动 / Prompt / 点选；点选模式暂停在同一帧添加正负点。
2. 选择 Bria 支持的 MP4/MOV/WebM/AVI/GIF；输入的视频编码也会按 API 支持范围校验。选择模式后自动核对视频时长：自动最长 60 秒，Prompt/点选最长 5 秒；超限时显示片段裁选控件，且不会静默截断。官方约束见 [SOURCES.md](docs/SOURCES.md)。
3. 选择十种纯色之一，导出尺寸自动跟随原视频，点击“开始处理并导出”。提交时会再次校验时长、片段范围及模式必填项；通过后才上传并调用 Bria，可能消耗账号额度。
4. 查看真实任务阶段；完成后在“导出结果”播放或下载 MP4。自动默认缓存透明视频，Mask 默认缓存；修改背景色后显示“待应用”，点击“应用修改并导出”只做本地处理。
5. 刷新页面可恢复最近任务；通过“本地任务记录”切换历史任务。网络错误可恢复原任务查询，提交结果不明会要求核对控制台，不自动重复付费请求。

任务和结果保存在项目 `data/`，不自动清理。仅在确认不再需要恢复或换色且服务已停止后手动清理。当前只面向本机使用，不作为公网多用户服务部署。

测试分层：`npm test` 使用模拟 Bria 和真实 FFmpeg；真实账号联调记录在 `docs/QA.md`。测试不会自动调用 Bria。最终文件跟随原视频尺寸，不会增加 Mask 分割细节。奇数尺寸补最多 1 像素以兼容编码；可变帧率按源平均帧率归一化。
