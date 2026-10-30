# 国内服务器独立 API 部署方案

本地开发使用 `npm run dev:api` 启动源码 API、`npm run dev` 启动网页，网页本地配置指向回环 3001。Windows 导出独立私有服务包使用 `npm run package:server`（需要 Docker Linux 引擎及镜像仓库网络）；默认输出 `.tmp/releases/backend-年月日-时分秒/`。只交付 API，不包含网页；完整说明见 [镜像交付与启动命令](镜像交付与启动命令.md)。

## Bria 白底图片 → 可灵旋转视频（2026-10-30）

网页上传新图片后自动提交视频任务，只展示原图和最终视频；Bria 白底 PNG 为服务端中间产物，不在页面预览或下载。打开历史不会新建付费任务；尚未生成视频的旧图片需明确点击生成。视频结果和查看弹窗采用 9:16 容器、等比完整显示；下载文件保持实际生成尺寸。

可灵密钥配置在 `apps/api/.env.kling.local`，模板为 `apps/api/.env.kling.example`。字段为 `KLING_API_KEY`、`KLING_API_REGION=china|global`；默认 china 对应官方北京端点，global 对应新加坡端点。不自动切换区域。进程环境优先，其后依次读取 `.env.kling.local`、`apps/api/.env`、根 `.env`、`.env.development`。生产独立服务仍只读显式私有配置文件；`prepare-private.mjs` 已将可选可灵配置纳入私有服务包。更新源码或环境变量后须重启；旧镜像须重新打包才能获得接口。

| 接口 | 行为 |
|---|---|
| `GET /api/health` | `klingVideoEnabled` 表示可灵 Key 已配置；不是生成权限/额度或连通性保证 |
| `POST /api/image-videos` | `{imageId}`，只接受 Bria 原图 ID；自动生成/复用白底 PNG，再提交可灵，返回 202；每张原图一个固定视频任务 |
| `GET /api/image-videos` / `GET /api/image-videos/:id` | 最近 20 个任务/状态查询，仅返回本服务链接与安全错误，不下发上游标识、Key 或签名地址 |
| `GET /api/image-videos/:id/file?download=1` | 本地缓存 MP4 下载，支持 Range；生成完成前返回 409 |

继承 API 认证、来源和 POST 客户端标识检查。原图须宽高均至少 300px、比例 1:2.5 至 2.5:1，进入 Bria 付费流程前校验。可灵输入固定为服务器合成的 `white.png`，以 Base64 提交，无需公开素材 URL；不会传原始带背景图片或 Tripo 结果。请求固定为可灵 3.0、1080p、6 秒、无音轨、单镜头，白底小角度左右轻转提示词由服务端固定（整体先向左约 15°、回原始朝向、再向右约 15°；锁定各部件原姿态，平缓换向，不要求完整转圈或展示背面）。

状态依次为 queued → whitening → submitting → processing → downloading → completed；错误为 failed。任务保存在 `image-videos/`，白底结果仍在 `images/`。提交前持久化独占意图与 `external_task_id`；请求结果不明时用该标识查询，未查到也不自动重新提交。已受理任务、下载失败及服务重启均复用原可灵任务。明确失败或不合规格结果不自动再生成；检查平台结果后决定是否上传新素材。单 API 进程队列，不支持多进程共享目录并发提交。

页面关闭后 API 仍处理，刷新后从最近图片打开即可查看结果；视频步骤不需要 WebGL 或浏览器录制。服务端最多下载 250 MiB，限制尺寸和时长，完整解码校验 H.264 MP4 后才标记完成。保留平台输出，不再次做视频 AI 抠图；旋转连续性、主体颜色/形状、纯白稳定性需实测，格式校验不等于视觉质量通过。已保存 PNG/MP4 在缺 Key 时仍能下载。

## 已撤销的图生 3D 链路（2026-10-30）

按用户要求移除图生 3D、模型渲染及录制能力。网页不提供“图片转 3D”；API 不注册 `/api/models` 及其子路径，服务启动不查询或恢复旧模型任务，健康接口不再声明建模能力。Three.js 和服务端 Chromium 渲染依赖已移除，独立服务包无需安装浏览器。

历史 `data/models/` 内容保留，未删除模型、视频或任务记录。Bria→可灵小角度视频流程和 Tripo 图片编辑 API 继续保留。

## 图片白底 API（2026-10-30 新增）

需更新服务端和网页版本，保留现有认证/CORS。Bria 图片需要 direct 模式；Tripo 配置独立，不要求 Bria 启用。既有镜像不会因源码更新自动具备该功能。两平台图片接口权限尚待账号实测，来源见 [SOURCES.md](SOURCES.md)。

服务端配置：`BRIA_API_TOKEN` 用于 Bria；`TRIPO_API_KEY` 用于 Tripo，`TRIPO_API_REGION` 为 `china`（默认）或 `global`，必须与 Key 账号区域匹配。不要放入 `VITE_*` 或网页启动配置。开发环境沿用 API 的 `.env` 加载路径；私有镜像打包脚本会从 `-TokenFile` 指定的配置文件读取可选 Tripo 配置，写入服务端私有配置。已运行容器需重新构建交付，或由管理员通过仅服务端的 `env_file` 注入后重建容器；切勿将 Key 写入客户端、命令日志或提交到 Git。

模型固定为 `seedream_v5`；请求纯白背景、保留主体，输出约 419 万像素并尽量维持比例，真实结果尺寸记录在 `outputMeta`。Tripo 不是确定性抠图，不能保证主体细节或背景每个像素均纯白。未配置的平台禁用生成，已保存结果仍可查看下载。更换区域不会自动接管旧任务，需恢复任务原区域。

| 请求 | 用途 |
| --- | --- |
| `GET /api/health` | `imageWhiteEnabled` 表示至少一项图片 API 已配置；`imageWhiteProviders: {bria:boolean,tripo:boolean}` 分别表明可用配置，不代表上游权限或质量已验证 |
| `POST /api/images` | `application/octet-stream` 上传单张 PNG/JPG；沿用 `X-Video-Filename` 的 URI 编码文件名头；仅上传，不提交付费任务 |
| `POST /api/images/:id/process` | JSON `{ "provider": "bria" }` 或 `{ "provider": "tripo" }` 首次生成/恢复；省略沿用该记录的平台（旧记录默认 Bria）。同原图同平台重复请求返回同一记录，提交结果不明时禁止再次提交 |
| `GET /api/images` | 最近 20 张图片记录；刷新后可恢复查看 |
| `GET /api/images/:id?provider=tripo` | 查询所选平台状态或尚未创建的预览记录；只读，不上传到上游、不计费。省略 provider 查询该记录；返回 `sourceId`、`provider`、`meta`、可选 `outputMeta` 及本服务文件链接。首次生成须使用已上传的 sourceId，尚未创建的预览 id 不可单独查询/提交 |
| `GET /api/images/:id/source` | 规范化后的 PNG 原图 |
| `GET /api/images/:id/file?download=1` | 完成后的白底 PNG 下载 |

网页仍使用 `/bria-cutout/api/...` 前缀和同源认证代理。所有资源沿用已有服务认证；POST 继续要求 `X-Cutout-Client: 1`。图片原件、透明缓存与白底结果位于数据卷的 `images/`，任务记录位于 `image-jobs/`；单进程图片串行队列，禁止多个 API 进程共享同一目录运行任务。仅图片格式开放 JPEG/PNG，资源限制属于工程选择，不是 Bria 上限。

当前交付和启动命令见 **[镜像交付与启动命令](镜像交付与启动命令.md)**。

用户最终确认只交付服务端，由独立网页或 APP 调用。一个私有 Linux 镜像内包含 Node.js API、FFmpeg/FFprobe 和服务端 Bria Token；不包含网页、Nginx 或 Caddy。目标腾讯云服务器导入镜像后运行 `docker compose up -d`，无需源码和 start.sh。域名未确定，证书本次不配置。

## 接口与认证

- 原生 APP 与独立网页均调用 `/api/*`，每个请求自动携带 HTTP Basic 认证，使用私有交付文件中的接口账号密码。这与 Bria Token 相互独立，客户端不接触 Bria Token。按用户选择，APP 可内置接口凭据，网页由启动配置注入，无登录界面或前置登录接口。客户端内置凭据可被提取，持有者可调用该单人服务。
- API 按 WEB_ORIGIN 允许一个精确网页来源的 CORS，支持 Authorization、上传和 Range 预检及响应头。原生 APP 可不带 Origin；带 Origin 的请求必须匹配配置。
- 所有 POST 继续要求 X-Cutout-Client: 1。浏览器写请求验证来源，API 不提供 Cookie 登录，客户端显式附加认证头。下载/预览同样需要认证。
- 默认仅监听主机 `127.0.0.1:3001`，无域名阶段通过 SSH 隧道测试；正式网页/APP 调用由外部 HTTPS 入口代理到该端口。网页来源地址与 API 域名分别配置，不是同一概念。
- 本版是单人私有 API，不提供注册、多租户和角色权限。旧代理认证模式仅保留兼容，实际交付镜像使用 Basic 模式。

## 执行与数据

单实例 API、串行处理、文件状态存储。素材、任务、缓存和成片保存在 `bria-cutout-server_media` 命名卷。API 以非 root 用户运行，根文件系统只读，独立临时目录；初始预算为 2 CPU / 4 GiB，主机还需为系统和磁盘预留资源，这不是性能承诺。

已接收任务由服务器后台处理。已受理的 Bria / Tripo / Kling 任务通过查询恢复；结果不明的付费提交不自动重发，缓存结果可复用。视频抠图使用 Bria，图片另支持 Tripo，Bria 白底图另可接可灵图生视频；官方约束继续见 [SOURCES.md](SOURCES.md)。

不自动迁移原 IndexedDB、Cloudflare D1/R2、本地 data 或旧整站包的数据卷。旧的 `tencent-20261028-v1` 包含网页，不属于最终交付；本次以 `backend-20261028-v1` 为准。旧浏览器/本机开发模式保留，与 API 镜像独立。

## 运维与验收

更新前等待任务完成，停止容器并备份整个命名卷，再导入新镜像及 Compose，保留项目名。每次打包更新接口密码；回滚须使用对应镜像、凭据和兼容数据。无在线一致性备份、横向扩容或自动素材清理。不要执行 `docker compose down -v`。

验证记录见 [PROGRESS.md](PROGRESS.md)。目标腾讯云网络、真实 Bria 账户和任务、长片资源上限、备份恢复以及设备播放仍须上机验收。不会自动远端部署或发起收费任务。
