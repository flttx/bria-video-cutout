# Bria API 接口契约

## 独立服务端接入（2026-10-28，工程契约）

独立 API 镜像供单独网页和 APP 调用，不包含网页。使用下文 `/api/*` 业务端点，接口认证为 `Authorization: Basic base64(admin:接口密码)`，接口密码见私有交付文件，与 Bria Token 无关。Bria Token 只在服务端使用。按用户要求，APP 可内置接口凭据，网页通过启动配置读取，自动附加认证头，无需用户登录。客户端内置凭据可被提取；它拥有该单人服务的调用权限。

网页来源由 WEB_ORIGIN 精确配置；允许 GET/POST/OPTIONS，预检无需登录，业务接口全部要求认证。CORS 允许 Authorization、Content-Type、X-Cutout-Client、X-Video-Filename、Range，暴露 Content-Disposition、Content-Length、Content-Range、Accept-Ranges。原生 APP 不要求 Origin；如果发送 Origin 则必须匹配。POST 必须带 X-Cutout-Client: 1，浏览器 POST 必须有匹配来源。未认证返回 401，来源或客户端标记错误返回 403。

下载/预览也需要认证。独立网页通过带认证的 fetch 获取 Blob；APP 使用带认证头的下载器/播放器。响应中的 `/api/...` 路径相对 API 地址解析。默认监听服务器回环 3001，正式客户端使用外部 HTTPS 入口；详细配置见 [镜像交付与启动命令](镜像交付与启动命令.md)。下文 `/browser/*` 是旧 Cloudflare 架构，不属于该服务端镜像。

官方 API 总索引：https://docs.bria.ai/video-editing
完整来源与条款对照：[SOURCES.md](./SOURCES.md)（2026-10-22 核验）。本文件所述 Bria 参数、限制以各端点的官方链接为准；项目定义和待联调项另行注明。

- **[官方]** 上传：`POST /v2/video/upload` 获取 `upload_url`、`upload_fields`、`file_url` 后 multipart 上传；视频 ≤1 GB，URL 有效期 1 小时/1 天：[Bria Upload Service](https://docs.bria.ai/local-video-upload-service)。
- **[官方参数 + 工程分流]** 自动去背景：`POST /v2/video/edit/remove_background`，`video`、`auto_zoom=false`、`preserve_audio=true`；视频 ≤60 秒、最高 16000×16000 输入、默认沿用源尺寸：[Bria Remove Background](https://docs.bria.ai/video-editing/editing/remove-background)。按导出策略选择：
  - **直接 MP4 [工程分流]**：`background_color=White` 或其他 Bria 预设色、`output_container_and_codec=mp4_h264`，尺寸符合目标则下载即交付；参数取值见 [官方枚举](https://docs.bria.ai/video-editing/editing/remove-background)。色卡 HEX 不能直接作为 Bria 参数。
  - **透明缓存 [工程选择，官方格式约束]**：`background_color=Transparent` + `webm_vp9`（或 `mov_proresks` / `mkv_vp9`），缓存结果后交给 FFmpeg。透明与 `mp4_h264` 不兼容，Bria **会回退黑底并提供 warning**，必须检查终态 `result.warning`：[Bria Alpha 支持表](https://docs.bria.ai/video-editing/editing/remove-background)。
  - **[官方/项目分界]** `auto_zoom=false` 时 Bria 保留输入尺寸、帧率与比例：[Bria 自动模式](https://docs.bria.ai/video-editing/editing/remove-background)；当前项目导出也跟随源视频显示尺寸和帧率，所需旋转/SAR 归一化、奇数边缘补齐和转码由本地 [FFmpeg](https://ffmpeg.org/ffmpeg-filters.html) 完成。
- **[官方] Prompt Mask**：`POST /v2/video/segment/mask_by_prompt`，`video`、`prompt`、`auto_trim=false`；最长 5 秒、最高 750p，异步生成 Mask 视频，文字说明的最终结果字段是 `mask_url`：[Bria Generate Mask by Prompt](https://docs.bria.ai/video-editing/masking/mask-by-prompt)。
- **[官方] 点选 Mask**：`POST /v2/video/segment/mask_by_key_points`，`video`、`frame_index`、`key_points[{x,y,type:positive|negative}]`、`auto_trim=false`；最长 5 秒、最高 750p，生成 Mask 视频，`positive` 为包含、`negative` 为排除：[Bria Generate Mask by Key Points](https://docs.bria.ai/video-editing/masking/mask-by-key-points)。
- **[官方] 查询**：`GET /v2/status/{request_id}`；状态 `IN_PROGRESS`、`COMPLETED`、`ERROR`、`UNKNOWN`；提交返回 `request_id`、`status_url`，视频建议每 5 秒查询，不得因任务尚未完成而重复提交：[Bria Async Polling](https://docs.bria.ai/getting-started/async-requests)。

**[官方文档歧义，待实测]** 两个 Mask 端点的说明均写终态 `mask_url`，但各自 SDK 示例调用 `result.result.video_url`：[Prompt](https://docs.bria.ai/video-editing/masking/mask-by-prompt)、[Key Points](https://docs.bria.ai/video-editing/masking/mask-by-key-points)。需基于真实联调响应验证解析逻辑；不能预先宣称其一定返回哪一种字段。

**[工程实现]** Mask 不是已合成指定纯色背景的视频；本项目选择通过 [FFmpeg alphamerge/overlay/scale](https://ffmpeg.org/ffmpeg-filters.html) 与源视频 RGB 时序/空间配准并合成纯色底。**这不是 Bria 官方强制使用 FFmpeg 的规定**，也不构成额外 AI 服务。

**[工程规则]** 导出任务记录 `direct_bria_mp4` / `alpha_composite` / `mask_composite` / `transcode_only`；能否不重调 API 更换颜色取决于是否缓存 Alpha/Mask。以上是本项目状态管理约定，**无 Bria 官方端点对应**。

## 浏览器架构 API（2026-10-24，当前工程契约）

生产入口为同源 /browser/*；默认 AUTH_MODE=token 验证 HttpOnly 会话，Access 模式验证 JWT 签名、issuer、audience、exp。写操作验证 Origin 和 X-Cutout-Client: 1。业务 JSON 请求最大 64 KiB。上传、任务与结果按已验证用户归属检查。客户端不能传任意上游 URL。

Token 模式：GET /auth/token 提供不含凭据的入口页，读取并移除 fragment 中的 token；POST /auth/session 接收 {token}（最大 256 字节），验证永久授权并创建独立会话，或原子兑换一次性授权，设置 Secure / HttpOnly / SameSite=Strict Cookie，响应仅 {ok:true}。GET /auth/session 验证会话；POST /auth/logout 撤销当前会话。永久链接无自动过期、可反复使用；一次性链接 24 小时兑换期、会话 30 天均为工程选择，所有认证响应 no-store；无效／撤销、会话过期或一次性链接重复兑换返回 401。CLI 只向 D1 写入摘要，不写原始 Token。

| 接口 | 请求与返回 |
| --- | --- |
| GET /browser/health | ok、userId（不含个人信息的归属标识）、tokenConfigured、processingReady；不返回邮箱、Token 或签名 URL |
| POST /browser/uploads | JSON {size, mediaType?}；mediaType 仅允许 video/mp4、video/quicktime、video/webm、video/x-msvideo，省略按 video/mp4 兼容旧客户端；返回 uploadId、chunkSize=8388608；创建私有 R2 multipart 暂存，MIME 随 R2 元数据传递至 Bria 上传授权及文件表单 |
| PUT /browser/uploads/:id/parts/:number | application/octet-stream；Content-Length 与预期分片长度一致；最后一片可以更小；返回 ok |
| POST /browser/uploads/:id/complete | 所有分片齐全后锁定转交，R2 complete → Worker 流式 Bria multipart；返回 uploadId，不返回上传表单与地址 |
| POST /browser/jobs | 沿用 CloudJobInput：cloudJobId、uploadId、mode、meta，以及相应模式参数；同 ID 去重 |
| GET /browser/jobs/:id | id、state、httpStatus?、warning、resultAvailable；不返回上游请求 ID 或 result URL |
| GET /browser/jobs/:id/artifact | 对当前用户已完成任务返回同源媒体字节流；不重定向、不返回上游响应错误正文。支持 `Range: bytes=N-` 续传（206 + `Content-Range`，越界 416，其他 Range 形式 416）；首次完整下载后副本保存在 R2 `results/<id>`，之后直接从 R2 返回 |

R2 成功转交后删除对象；上传响应丢失或转交失败可重新上传（未提交 AI），但不能据此重复已尝试的抠图 POST。D1 browser_jobs/browser_uploads/browser_parts 新表管理归属和分片；旧 jobs/uploads 仍负责提交去重、查询租约与凭据保存。

本机素材导入、任务列表、恢复、换色、隐藏／撤销和导出状态改为浏览器模块函数，沿用 /api/* 字符串作为内部路由以复用 UI；没有对应网络请求。成片和缩略图用 Blob URL，下载不再追加 ?download=1。IndexedDB 和 Web Locks 负责本机事务及互斥；旧 data/ 不自动迁移。

生产没有有效会话／所选模式的 Access 身份时拒绝浏览器请求；DEV_AUTH=1 只对回环地址开发请求有效。旧 Bearer 服务密钥不能替代浏览器会话。

## 旧 Node API（历史兼容，新网页不调用）

服务只监听 `127.0.0.1:3001`。所有 POST 需要 `X-Cutout-Client: 1`，JSON 请求使用 `Content-Type: application/json`；允许配置的本地页面来源，不向浏览器返回 Token、Bria 请求标识、签名 URL 或磁盘路径。

| 接口 | 请求与结果 |
| --- | --- |
| `GET /api/health` | 返回 `ok`、`phase=pipeline`、`tokenConfigured` 和 `processingReady`；云端检查失败仍返回本地 200，但 processingReady=false，不代表账号额度或 FFmpeg 全面验收 |
| `GET /api/config` | 模式、预设色与 `outputResolution="source"`；`frameworkOnly=false` |
| `POST /api/videos` | `application/octet-stream` 原始视频流；流式写盘后 FFprobe 校验 Bria 支持的容器/编码及本地帧率范围，201 返回 `id/meta/bytes/createdAt`。最大 1,000,000,000 字节 |
| `POST /api/videos/:id/preview` | 为 AVI/GIF 或浏览器无法播放的已上传视频生成可播放的本地 H.264/AAC 预览；Bria 处理仍使用原文件 |
| `GET /api/videos/:id/preview` | 返回本地兼容预览，支持 Range 请求；视频 ID 只解析到本地视频存储目录 |
| `POST /api/jobs` | `{id,videoId,mode,prompt,points,start,end,reusable,color,resolution}`；202 返回本地任务视图。`id` 是客户端 UUID，同 ID 同参数复用原任务，参数冲突返回 409 |
| `GET /api/jobs` | 最近 50 个本地任务；页面刷新后显示在任务记录中，不自动选中历史任务或恢复成品 |
| `GET /api/jobs/:id` | 状态、参数快照、初次导出 ID、源片段 `sourceMeta{width,height,fps}`（准备完成后）、脱敏错误、`canResume`；没有虚构进度百分比 |
| `POST /api/jobs/:id/resume` | 失败任务恢复。已有 Bria 请求只继续查询/下载；提交结果不明且无请求 ID 时拒绝自动重发 |
| `POST /api/jobs/:id/export` | `{id,color,resolution}`，复用缓存做本地导出；直接有色视频改变颜色返回 409 |
| `GET /api/exports/:id` | 导出状态、实际尺寸/帧率/时长/音轨、字节数、本地下载地址 |
| `GET /api/exports/:id/file` | MP4 预览/下载，支持单段 Range；`?download=1` 返回附件下载。不允许读取未完成文件 |

任务状态：`queued → preparing → uploading → submitting → processing → downloading → exporting → completed / failed`。本地作业串行执行以限制内存和外部并发；不是 Bria 的并发规定。

导出状态：`queued → exporting → completed / failed`。只有 FFprobe 校验目标尺寸、H.264/yuv420p、音轨、帧率、时长与完整帧数后才标记完成。导出路径记录 `direct_bria_mp4 / alpha_composite / mask_composite / transcode_only`。

## 参数与恢复规则（工程选择）

- `start/end` 为原视频秒数，必须在实际时长内且结束晚于开始；自动最多 60 秒，两个 Mask 模式最多 5 秒，超限拒绝，不隐式截断（官方上限见 S1/S2/S3）。
- `points` 为 `{x,y,type,atSeconds}[]`，x/y 为 0..1；须至少一个正点，所有点在同一帧且在裁选片段内。本地最多 100 点是工程校验，不是 Bria 限制。
- `reusable=true` 默认请求自动模式透明 WebM；关闭时请求当前预设色 MP4。Mask 始终缓存。`color` 只接受十种英文预设名称，新请求 `resolution` 仅接受 `source` 或省略（按 source 处理）；指定 2K/4K 返回明确错误。历史任务与导出记录仍可读取，已落盘的旧任务按原快照恢复；对其新建导出统一使用缓存源片段尺寸，旧文件不被覆写。
- 先裁剪并生成固定帧率、方形像素的源片段；Mask 代理保持比例且不超过 1280×720。浏览器兼容预览同样为本地 H.264/AAC 代理，不替代提交给 Bria 的原文件。代理边界及恒定帧率均属本地策略。点坐标映射到代理像素；时间减去片段起点后换算帧索引。
- 检查 Bria 结果的比例、帧率、时长与帧数。合成前按帧序号统一时间基准，避免 WebM 毫秒时间基准导致尾帧丢失；本地源音轨重新加入输出。
- 持久化文件在项目 `data/videos`、`data/jobs`、`data/exports`。重启继续未完成且可恢复任务；已有失败任务由用户点击恢复。提交状态已落盘但请求 ID 未取得时标记 `SUBMISSION_UNCERTAIN`，先核对控制台，禁止自动重复扣费。
- 查询约每 5 秒进行；临时网络错误、429/5xx 查询按退避有限重试，POST 不自动重试。半小时查询超时后允许恢复原任务查询。超时、代理规格、下载 4 GB 保护及 FFmpeg 时间限制都是工程选择。
- 本地不自动清理视频及缓存，以保留恢复/换色能力。数据会占用磁盘；确认结果后可在服务停止时手动清理 `data`。

## 2026-10-22 真实联调记录

三种模式各提交一次 1 秒、512×512、24fps 的公开测试片段（素材来源见 SOURCES.md）。上传返回 `result.upload_url/upload_fields/file_url`；自动模式完成字段为 `video_url`，两个 Mask 模式本次均为 `mask_url`。解析仍保留 `video_url` 兼容分支，不将一次实测推广为永久协议保证。

自动透明结果实际为 VP9/WebM，FFprobe 标签使用大写 `ALPHA_MODE=1`；已兼容大小写并用 libvpx-vp9 实际解码检查 Alpha。自动模式完成 3840×2160 导出，两个 Mask 模式完成 2560×1440 导出，全部 24 帧、1 秒并带音轨。通过缓存换色再次导出不增加 Bria 提交。

这些结果只证明本次素材和账号的调用/合成链路；复杂运动、长视频、高分辨率输入、多实例质量与设备播放器兼容性仍待专项验收。

## 旧 /v1 云端 API（历史兼容，2026-10-23）

所有 `/v1` 接口要求 `Authorization: Bearer <CUTOUT_CLOUD_TOKEN>`，密钥至少 32 字符；拒绝带 Origin 的浏览器请求，不提供 CORS。仅供受信任的本地 Node.js 服务端调用，不是浏览器公开接口。POST 仅接收 JSON，最大 64KB。所有响应设置 no-store；不返回原始异常、上游错误正文或 Bria 请求 ID。

| 接口 | 请求 | 响应 |
| --- | --- | --- |
| GET /v1/health | 无 | 200 `{ok:true,service:"bria-cutout-cloud"}`；鉴权、配置与 D1 检查，不请求 Bria |
| POST /v1/uploads | `{}` | 201 `{uploadId,upload_url,upload_fields}`；仅 Node.js 持有上传凭据，随后直接 multipart 上传至 Bria |
| POST /v1/jobs | `{cloudJobId,uploadId,mode,meta,color?,prompt?,frame_index?,key_points?}` | 202 云端任务视图；同 ID 同参数返回原记录，冲突 409 |
| GET /v1/jobs/:id | UUID | 200 云端任务视图；必要时查询一次 Bria，终态返回已保存结果 |

`meta` 为已处理上传文件的 `{width,height,duration,fps,frames}`，不能填原视频规格代替代理规格。自动模式 color 省略表示透明 WebM，指定十种英文预设色表示有色 MP4；Prompt 只接受 prompt，点选只接受 frame_index 与像素 key_points。Worker 重验参数和元数据，实际媒体内容仍由本地 FFprobe 检查；Worker 不读取视频做二次探测。Mask 代理限制为 1280×720 范围、最多 100 点，是项目工程规则，不是 Bria 官方限制。

任务视图为 `{id,state,status?,httpStatus?}`；state 为 submitting、processing、completed、failed、rejected、uncertain。status 是过滤后的 Bria 状态和必要 `video_url/mask_url`，warning 仅返回布尔值。签名结果地址只给受信任 Node.js，不能透传至浏览器。completed 只表示 Bria 完成，本地仍须下载及验收才能标记本地任务完成。

D1 先插入唯一占位再提交；同 ID 比较规范化参数的 SHA-256。提交占位 90 秒过期只转 uncertain。明确拒绝保留 rejected；本地仅在用户主动恢复时创建新的 cloudJobId。Worker 不提供重发接口，网络或数据库故障不得用新 ID 自动替代。

状态查询按主键读取，5 秒间隔，领取 70 秒查询锁并用随机标识防止迟到响应覆盖；失败退避 10–60 秒，兼顾 Retry-After。查询和上传授权故障返回脱敏错误。缺失云端记录返回 CLOUD_JOB_NOT_FOUND，本地停止自动恢复；已知 Bria 404 状态查询转 UNKNOWN 终态，不重复提交。

本地任务新增 transport（direct/cloud）和 cloudJobId，均不出现在浏览器任务视图中。缺少 transport 的旧记录按 direct 处理；模式配置改变不迁移历史任务。云端 Token 只在 Worker，本地保存内部服务密钥。已有 direct 任务如需恢复，须保留对应本地 Bria 凭据。

官方来源：[上传](https://docs.bria.ai/local-video-upload-service)、[自动](https://docs.bria.ai/video-editing/editing/remove-background)、[Prompt](https://docs.bria.ai/video-editing/masking/mask-by-prompt)、[点选](https://docs.bria.ai/video-editing/masking/mask-by-key-points)、[异步状态](https://docs.bria.ai/getting-started/async-requests)。上述 /v1 接口、去重及锁时长均为工程约定，不是 Bria 提供的 API。


### 本机原生合成服务（工程接口）

仅本地原生模式使用，经 Vite `/native` 代理到 `127.0.0.1:3002`。所有请求须有 `X-Cutout-Client: 1`，只接受回环 Host 及允许的本地 Origin，不开放跨域访问。不调用 Bria、不返回磁盘路径或凭据。

- `GET /native/health`：执行 FFmpeg／FFprobe 版本检查，成功返回 `{ok:true,service:"cutout-native",version:1}`。
- `POST /native/render`：`Content-Type: application/octet-stream`，正文为源片段字节随后接结果字节。`X-Cutout-Render` JSON 含 `{sourceBytes,kind:"alpha"|"mask"|"direct",color,resolution:"source"}`；每份媒体最多 1 GB。参数只接收预设颜色，服务重新探测媒体而不信任客户端视频元数据。成功为 MP4 流，`X-Cutout-Result` 含 `{meta,bytes,route}`；返回前已通过结果和成片验收。临时文件正常结束后清理。
- 正在处理另一请求返回 `409 NATIVE_BUSY`；工具缺失 `503 MEDIA_TOOL_MISSING`；媒体／结果无效返回明确错误。失败只重试本地合成，浏览器不得因此重发 Bria。

### 临时任务诊断日志（浏览器云端）

`POST /browser/diagnostics`：与 browser API 相同的会话、Origin、X-Cutout-Client 和有效 X-Cutout-Device；Content-Type 为 application/x-ndjson，Content-Length 为实际 UTF-8 字节数且不超过 1 MiB。只接受 schema=1 的匿名数字事件日志；成功 201 返回 `{id,bytes,createdAt}`。日志不经过 Bria。

`GET /browser/diagnostics/:id`：仅同账号同设备可读取；其他账号／设备返回 404。R2 私有对象名为 diagnostics/<id>.jsonl，授权元数据不返回给客户端；没有公开下载 URL。设备点击上传是唯一触发，不做后台自动上传或自动重试。

`GET /browser/jobs/:id/artifact` 增加 `X-Cutout-Source`，值为 `r2` 或 `upstream`；缺失该头时客户端记录来源未知，不用 CF-Cache-Status 推断 R2 命中。
