# Bria 视频抠图方案：事实依据与来源

## 2026-10-30 Bria 白底图片接可灵图生视频

- **用户需求：**完善 Bria 图片白底流程，接入可灵生成视频，增加服务端可灵环境变量文件。与 Tripo 图生 3D/录制流程独立。
- **官方事实（当日实际读取中英文页面）：**[可灵图生视频 3.0](https://klingai.com/document-api/api/video/3-0-omni/image-to-video) 使用 `POST /image-to-video/kling-3.0`、`Authorization: Bearer ${KLING_API_KEY}`；`contents` 包含 prompt 和 first_frame，图片可传 URL 或 Base64，PNG/JPEG 最大 50 MB、宽高至少 300px、比例 1:2.5 至 2.5:1。`settings` 支持 resolution、duration、audio、multi_shot；`options.external_task_id` 可用于查询。
- **官方事实：**同页 `GET /tasks?task_ids=...` 或 `external_task_ids=...` 返回任务数组；状态 submitted / processing / succeeded / failed，结果位于 `outputs` 的 video 项。中国区示例端点为 `api-beijing.klingai.com`，[国际区文档](https://kling.ai/document-api/apiReference/model/imageToVideo) 示例为 `api-singapore.klingai.com`。快照保存于 `.tmp/kling-docs/`，协议以当前官方页面为准。
- **工程选择：**固定 1080p、6 秒、audio=off、multi_shot=false、无水印附加输出；首帧为 Bria 去背景后合成的白底 PNG，Base64 只经服务端提交。提示词要求主体完整居中、保持颜色材质、镜头固定、纯白背景和平稳的小角度左右轻转；这是生成意图，不是质量保证。图片不裁剪或拉伸，不对结果再次 AI 抠图，实际尺寸以视频元数据为准。
- **2026-10-30 提示修正：**相机白底输入无底座，旧可灵视频新增底座且 180° 附近背面跳回正面。移除 `product turntable shot`，明确主体独立刚体旋转、每四分之一圈的时间与朝向，禁止新增底座/台面/支架及前后面切换。提交前将实际提示保存在任务记录中。转台措辞的诱导作用是工程推测；单图背面缺失、模型是否遵循连续旋转必须检查成片，提示不能保证消除问题。
- **工程保护：**每原图固定一个任务，提交前记录意图；超时/未知响应通过 external ID 恢复，查不到也不重复提交。结果下载预算 250 MiB，校验单视频轨 H.264、6 秒附近、1080p 级尺寸并完整解码后保存；这些为交付保护，不是可灵平台全部格式限制。
- **验证边界：**提供的 Key 对中国区官方任务接口只读查询成功，无新付费生成。模拟上游验证 Bria 白底图传递、视频保存、鉴权、查询恢复与去重；真实生成权限、额度、耗时以及旋转/白底/主体保真仍待实际素材验证。
- **后续真实实测（2026-10-30）：**针对相机底座与前后面跳变，复用白底输入，以修订提示实际提交一次可灵任务 `945000722167891783`，成功得到 1080×1916、6.041667 秒成片。全片抽帧及 2–4 秒连续 48 帧检查未见底座或旧版正反面突变；背面依然是生成推断，不能据此保证其他输入的效果。账本和对比证据位于 `.tmp/kling-camera-fix/`。
- **反例与验收限制（2026-10-30）：**机器人任务 `945011489352977148` 的持久化 prompt 与修订版逐字相同，仍在约 3 秒处出现侧面朝向突变、重复展示背面，连续旋转验收不合格。证据 `.tmp/kling-robot-review/`。这证明当前提示没有可靠约束所有输入；平台成功及媒体解码通过不等于视觉连续性通过，系统尚无自动视觉质量判定。
- **历史工程选择（2026-10-30，现已回退）：**用户曾确认中文通用版，以主体结构、表面特征和遮挡关系描述，不指定物体类别；每 1.5 秒转过 90° 均相对于初始参考朝向。后续用户反馈主体抖动，要求撤销该版。
- **历史工程选择（2026-10-30，曾按用户要求回退）：**`apps/api/src/kling.ts` 已逐字恢复中文详细版之前的英文通用提示，与相机纠正版任务保存的 prompt 一致，保留禁止新增底座的要求。只影响新提交，不改写历史提示或自动重生成旧视频。该英文版此前亦有机器人连续性不合格反例，回退不代表保证消除抖动或实现完整 360°。

- **当前工程选择（2026-10-30，小角度版）：**用户不再要求可灵完整 360°。通用英文提示要求整体 0–2 秒向画面左侧约 15°、2–4 秒回到原始朝向、4–6 秒向画面右侧约 15°，平缓换向；主体作为无关节动作的静态刚体，锁定所有部件的相对位置/角度，禁止走动、手势、表情、呼吸或局部形变，参考可见面持续可见；移除四分之一圈时间节点、背面展示及禁止反向转动的旧约束。保持固定镜头、刚体部件、纯白背景、居中与禁止新增底座。角度为生成意图，非平台确定性参数；真实成片仍需验收。仅新提交生效，不重写历史任务，不自动付费重生成。图生 3D 链路随后已按用户要求撤销。

## 2026-10-30 Tripo 图生 3D 与旋转录制（历史方案，现已移除）

**当前状态：**用户已撤销整条图生 3D 链路。以下内容只保留研究与验证记录，不代表当前产品能力；建模、模型渲染、录制代码/接口及其运行依赖已删除，历史生成文件保留。

- **用户需求：**直接调用 Tripo 图生 3D 并自动输出视频结果，不再显示模型预览或要求手动录制。与图片白底相互独立，不强制先抠图/重绘。
- **官方事实（当日核对）：**[Tripo H 系列 Image to Model](https://developers.tripo3d.ai/en/docs/generation-image-to-model/standard) 使用 `POST /v3/generation/image-to-model`，上传引用作为 `input`，模型版本可选 `v3.1-20260211`；支持纹理、PBR、面数限制和输入视角对齐。异步查询成功后读取 `output.model_url`。`quad=true` 会强制 FBX，因此本实现固定 false；不请求网格压缩或额外转换任务。输入官方限制 20 MB，建议至少 256×256。
- **工程选择：**几何版本固定 `v3.1-20260211`，纹理版本 `v3.0-20250812`，standard 质量、50,000 面预算、纹理/PBR 开启、`enable_image_autofix=false`，`orientation=align_image`。每张原图一个建模任务；区域与付费提交意图持久化，不明提交不重发；恢复查询不重新建模。现有图片上传校验继续复用，Tripo 上传前再检查规范化文件不超过 20 MB。
- **渲染依据：**[Three.js](https://threejs.org/docs/) 的 GLTFLoader/WebGLRenderer 加载 GLB；[Playwright Chromium](https://playwright.dev/docs/browsers) 在服务端启动无界面浏览器。模型资源必须内嵌，GLB 结构及 URI 经服务端校验，加载器和请求拦截再次阻止外部资源；Meshopt 随 API 渲染 bundle 打包，无 CDN。白底、灯光和帧角度为本项目工程设置。
- **工程选择（2026-10-30 更新）：**6 秒、1080×1920（9:16）、30fps，服务端独立渲染 180 张 PNG，角度为帧号乘 2°，不依赖墙上时间、requestAnimationFrame、captureStream 或 MediaRecorder。FFmpeg 按帧序编码 180 帧，循环首尾角度步长一致。固定正交相机按旋转全周几何尺寸保留边距；灯光/曝光恒定。渲染和编码任务持久化，网页关闭不影响执行，进程重启从第 0 帧恢复未完成任务；新结果校验通过后替换，失败保留旧视频。GLB 100 MiB、PNG 帧总量 768 MiB、15 分钟渲染超时及单队列均为工程保护，非 Tripo 官方限制。
- **真实实测：**用户明确要求直接调用后，用白底橙色矩形创建一次国际区任务，上游成功并报告 `credits_consumed=30`，与当日[国际区定价](https://developers.tripo3d.ai/en/pricing)的标准图生 3D 30 积分一致。中国区只读鉴权失败，国际区成功，已明确修改本地配置为 global。查询中断后恢复原任务，没有重复提交。真实 GLB 已加载并录制为 1080×1080、6 秒、180 帧 H.264 视频，浏览器播放通过；结果位于 `data/tripo-real-20261030-rectangle/`。
- **质量限制与待实测：**此样本生成了带装饰结构的浅棕色物体，与纯橙色矩形原图的形状/颜色明显不符，未达到保真要求。不能将接口成功等同于 AI 建模质量通过，也不能仅据最终画面断定色差全部来自模型或全部来自灯光。真实产品照片、其他 GLB 材质/方向、背面结构和纹理质量、服务端软件渲染资源与耗时、设备播放和用户视觉验收仍待实测。

## 2026-10-30 Tripo 图片编辑补充

- **用户需求：**在图片白底入口增加 Tripo，与 Bria 可切换；不包含 3D 建模和视频生成。
- **官方事实（当日核对）：**[Image to Image](https://developers.tripo3d.ai/en/docs/generation-image-to-image) 为异步 `POST /v3/generation/image-to-image`，可用上传得到的 `file_token` 作为 `input`；本项目选用文档默认模型 `seedream_v5`，输出 PNG。该模型通过提示词编辑背景，`background` 参数仅适用于部分其他模型，不能当作通用白底开关。输入 PNG/JPEG，20 MB、至少 14px，宽高比 1:3–3:1。显式输出尺寸支持 3.69–10.40 MP。
- **官方事实：**[File Upload](https://developers.tripo3d.ai/en/docs/files) 为 `POST /v3/files`，multipart 字段 `file`；[Task Query](https://developers.tripo3d.ai/en/docs/task-query) 为 `GET /v3/tasks/{task_id}`，成功图片取 `output.generated_image_url`；[中国区文档](https://developers.tripo3d.com/en/docs/generation-image-to-image) 使用 `https://openapi.tripo3d.com/v3`，国际区使用 `.ai`。Bearer Key 仅由服务端发送。
- **工程选择：**默认中国区，可显式配置国际区，不自动切换；每张图每个平台一个稳定任务，保存区域/模型/上传引用/提交意图，保留旧 Bria 记录。Tripo 按原比例取约 419 万像素输出（整数取整）；使用固定白底编辑提示词，生成的透明像素本地铺白，不强制原尺寸或要求 Alpha，不二次调用 Bria。对不透明结果不做背景识别或强制改色，因此不保证每个背景像素均为 #FFFFFF。沿用本地 2400 万像素和下载 100 MiB 保护。提交异常不自动重发；下载失败查询原任务，不跨平台兜底。
- **待实测：**Tripo 账号区域、图片服务权限、计费与耗时、真实素材文字/形状一致性、背景纯白质量。本轮只做官方协议核对、模拟 API 和本地媒体/浏览器验证，未创建真实付费任务。

## 2026-10-30 图片白底入口

- **用户需求：**先通过 Bria 去除单张静态图片的背景，再合成白底图片。此阶段新增独立入口，不调用视频抠图，也不接入可灵；图片是主体素材，不是自定义背景图。
- **官方依据：**[图片 Remove Background](https://docs.bria.ai/image-editing/editing/background-remove) 属于图片编辑接口，使用 `POST /v2/image/edit/remove_background`；`image` 接受 Base64 或可访问图片 URL，返回带透明度的抠图结果。接口支持 JPEG/PNG/WEBP；本次仅开放 JPEG/PNG。显式传入 `sync=false`、`preserve_alpha=true`，通过原任务 `request_id` 查询 `result.image_url`。不发送重绘指令。
- **工程选择：**上传与规范化后大小各不超过 20 MiB，单边不超过 8192px、总像素不超过 2400 万；这些是本服务的资源保护范围，不是 Bria 官方上限。FFmpeg 规范化图片为 PNG，再把透明结果合成不透明白底 RGB PNG；不拉伸、不裁剪、不设置透明度二值化阈值。下载保护上限为 100 MiB。
- **服务边界：**只在独立 API 的 direct 模式启用；使用已有服务端 Bria Token。网页只使用 `/bria-cutout/api/images*`，上游凭据、Base64、文件路径和临时 URL 不进入响应或日志。Worker/浏览器模式未接入图片处理，旧 API 通过能力检查给出明确提示。
- **付费与恢复：**上传不提交 Bria；点击生成才发起一次图片任务。先落盘提交意图，重复点击返回原任务。已知任务可恢复查询/下载/合成；未知是否成功的提交禁止自动重发。缓存透明图用于恢复合成，网页刷新从最近记录恢复。
- **验证边界：**模拟 Bria 的接口与浏览器测试、真实本地 FFmpeg 白底合成已执行；实际账号是否开通图片接口、真实前景边缘质量和最终服务器版本仍待验证。

## 2026-10-28 国内服务器独立部署复核

**最终范围更新：**用户确认只交付供独立网页/APP 调用的 API 服务端，一个镜像，不含网页/Nginx/Caddy。使用服务端 Basic 认证和精确 CORS；原生 APP 可不带 Origin。旧的 Nginx/整站说明是此前方案记录，已由 [当前方案](STANDALONE_SERVER.md) 替代。Bria Token 仍只内置于 API 私有镜像，接口密码是另外生成的客户端登录凭据。

- **用户需求更新：**应用可部署到国内服务器，覆盖此前只在本机处理的部署要求；43 寸设备仍只播放成片。
- **官方复核：**重新读取 [自动接口 S1](https://docs.bria.ai/video-editing/editing/remove-background)、[文字 Mask S2](https://docs.bria.ai/video-editing/masking/mask-by-prompt)、[点选 Mask S3](https://docs.bria.ai/video-editing/masking/mask-by-key-points) 与 [上传 S4](https://docs.bria.ai/local-video-upload-service)。保留现有参数与时长限制，上传仍使用授权、multipart、file_url 流程；未增加任何 Bria 国内专线或区域可达性声明。
- **工程选择：**复用 Node Pipeline 与原生 FFmpeg，单实例文件存储，腾讯云 CVM + Nginx 认证及 HTTP 反向代理；无域名时走 SSH 隧道，后续域名的 HTTPS 由外部入口处理；不依赖 Worker/D1/R2，不使用新 AI 模型。
- **部署依据（按用户要求移除 Caddy）：**[Nginx 密码认证](https://nginx.org/en/docs/http/ngx_http_auth_basic_module.html)、[反向代理与缓冲](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)、[腾讯云 Nginx 证书部署](https://cloud.tencent.com/document/product/400/35244)、[腾讯云安全组](https://cloud.tencent.com/document/product/213/112614)、[域名 A 记录](https://cloud.tencent.com/document/api/302/3449)、[是否需要备案](https://cloud.tencent.com/document/api/243/19630)。证书由管理员下载、更新和重载，应用不自动申请/续期。
- **待实测：**目标国内服务器到 Bria API/上传存储/结果存储的实际网络及设备播放。Linux 容器的本地验证以 PROGRESS.md 为准。主机资源与并发限制是工程预算，不是官方最低规格或性能承诺。
- **镜像交付更正：**本地仓库通过 [buildx build](https://docs.docker.com/reference/cli/docker/buildx/build/) 指定目标 Linux 架构并加载镜像，再用 [image save](https://docs.docker.com/reference/cli/docker/image/save/) 打包；目标服务器用 [image load](https://docs.docker.com/reference/cli/docker/image/load/) 导入并启动纯运行 Compose，不需要源码仓库或构建环境。
- **用户明确选择：**Token 内置于私有镜像的服务端配置，使用 `docker compose up -d`，不要求 start.sh、证书文件或目标机环境密钥。[BuildKit secret mount](https://docs.docker.com/build/building/secrets/) 避免凭据进入构建参数/日志，本项目有意将凭据复制到最终私有层，因此最终镜像仍须视为密钥载体；这不是官方建议的通用公开镜像做法。网页登录使用随机 256 位密码及 [Nginx 支持的 SSHA](https://nginx.org/en/docs/http/ngx_http_auth_basic_module.html) 存储，传输通过 SSH 或后续 HTTPS 入口保护。

核对日期：2026-10-22。以下链接均指向官方技术文档；官方 API 可能更新，正式联调前需再次核对。文档中使用 [S1] 等编号回指本表。

## 官方接口及约束（已核对文档，不代表已通过账号实测）

| 编号 | 官方文档 | 本方案引用的可核实规则 |
| --- | --- | --- |
| S1 | [Bria — Remove Background](https://docs.bria.ai/video-editing/editing/remove-background) | 支持 MP4/MOV/WebM/AVI/GIF 容器；H.264/H.265 (HEVC)/VP9/AV1/PhotoJPEG 视频编码；`POST /v2/video/edit/remove_background`；最长 60 秒；输入最高 16000×16000；`auto_zoom=false` 时保留输入比例/分辨率及帧率，`preserve_audio` 可保留音频；支持 Bria 预设 `background_color` 字符串（不是任意 HEX）；输出 `mp4_h264` 不带 Alpha；支持 Alpha 的预设为 `webm_vp9`、`mov_proresks`、`mkv_vp9`；`Transparent` 配不支持 Alpha 的预设会回退黑底并返回 warning；202 异步响应。 |
| S2 | [Bria — Generate Mask by Prompt](https://docs.bria.ai/video-editing/masking/mask-by-prompt) | `POST /v2/video/segment/mask_by_prompt`；依据文本 `prompt` 生成 Mask 视频；最长 5 秒、最高 750p；`auto_trim=true` 可截断；202 返回 `request_id/status_url`；结果文档写 `mask_url`。 |
| S3 | [Bria — Generate Mask by Key Points](https://docs.bria.ai/video-editing/masking/mask-by-key-points) | `POST /v2/video/segment/mask_by_key_points`；依据 `frame_index` 和 `key_points`（`x,y,type`）生成 Mask 视频，`positive` 表示纳入、`negative` 表示排除；最长 5 秒、最高 750p；202 和 `mask_url`；文档代码示例使用像素数值坐标。 |
| S4 | [Bria — Video Upload Service](https://docs.bria.ai/local-video-upload-service) | `POST /v2/video/upload` 获取 `upload_url/upload_fields/file_url`，multipart 上传；只接收视频，单文件最大 1 GB；上传 URL 有效期 1 小时、文件 URL 有效期 1 天；URL 本身是可访问凭据，不可泄露。 |
| S5 | [Bria — Async requests, webhooks and polling](https://docs.bria.ai/getting-started/async-requests) | 202 异步、`request_id/status_url`；状态 `IN_PROGRESS/COMPLETED/ERROR/UNKNOWN`；视频建议约每 5 秒轮询；不要对进行中的任务重复提交 POST；结果 URL 有时效；Webhook 需要 HMAC 验签。 |
| S6 | [Bria — Authentication](https://docs.bria.ai/getting-started/authentication) | REST 请求使用 `api_token` 请求头；Token 应保存于环境变量或密钥管理系统，不能放在客户端或公共仓库。 |
| S7 | [Bria — Rate limits and errors](https://docs.bria.ai/getting-started/rate-limits-and-errors) | 429 限流、403 套餐权限、422 处理失败、413 体积/分辨率超限（以具体端点为准）；查询状态计入速率限制。实际账户额度需以控制台/当前套餐为准。 |
| S8 | [FFmpeg — Filters](https://ffmpeg.org/ffmpeg-filters.html) | `alphamerge`、`overlay`、`scale`、`pad` 等提供本地确定性遮罩、合成和画面尺寸处理能力；不属于新的 AI 抠图接口。 |
| S9 | [FFmpeg — ffprobe](https://ffmpeg.org/ffprobe.html) | 解析视频容器、编码流、尺寸、音轨等元数据，用于上传前检查及导出后验收。 |
| S10 | [Bria — Video API Reference](https://docs.bria.ai/video-editing) | 视频编辑/分割属于 Bria 的 REST 异步 API；API 服务地址与大类入口。 |

## 三种模式与来源的直接对应

| 需求模式 | API | 官方最长时长 | 官方分割/视频尺寸约束 | 官方结果性质 | 来源 |
| --- | --- | --- | --- | --- | --- |
| 自动识别前景 | `remove_background` | 60 秒 | 输入最高 16000×16000，通常沿用源尺寸（`auto_zoom=false`） | 去背景后的视频，可选预设色或 Alpha | [S1](https://docs.bria.ai/video-editing/editing/remove-background) |
| Prompt 指定目标 | `mask_by_prompt` | 5 秒 | Mask 最高 750p | 遮罩视频（`mask_url`） | [S2](https://docs.bria.ai/video-editing/masking/mask-by-prompt) |
| 点选目标 | `mask_by_key_points` | 5 秒 | Mask 最高 750p | 遮罩视频（`mask_url`） | [S3](https://docs.bria.ai/video-editing/masking/mask-by-key-points) |

**注意**：Prompt/点选的 750p 为 Bria 遮罩能力上限，不意味着本地无法生成 3840×2160 的视频文件；把遮罩放大到 4K 不能恢复不存在的高频边缘细节。[S2][S3] 是“750p”事实来源；“放大不提高模型原生细节”是图像处理推论，非 Bria 官方对输出效果的承诺。

## 非 Bria 规则：必须与官方限制区分

| 类型 | 本项目规则 | 依据 / 说明 |
| --- | --- | --- |
| 用户需求 | Windows 本地 Demo，最终结果放到 43 寸设备播放 | 用户明确要求；**不是** Bria API 限制 |
| 用户需求 | 导出规格自动跟随原视频，取消手动档位 | 2026-10-22 最新要求覆盖此前固定 16:9 与 2K/4K 约定；这是产品输出策略，非新增 Bria 规则 |
| 用户需求 | 自动 / Prompt / 点选三种交互模式 | 用户明确要求；各自可调用官方 [S1][S2][S3] 能力 |
| 用户需求 | 白色默认 + 九种预设颜色，无自定义背景图 | 用户明确要求；UI 的 HEX 值仅用于本地预览/FFmpeg，Bria API 接收预设英文名称 [S1]，两者精确色值一致性**待实测** |
| 工程选择 | Prompt/点选超过 5 秒时要求先裁出 5 秒片段 | 避免 `auto_trim=true` 无提示截断；5 秒硬约束来自 [S2][S3] |
| 工程选择 | 生成最高 720p 的本地代理视频、保存 UI 归一化坐标、按采样帧计算 `frame_index` | 为符合 750p 上限做的坐标/时间映射方案；[S3] 提供字段和像素示例，但**未保证项目代理视频坐标映射规则**，需联调验证 |
| 工程选择 | FFmpeg 将 Mask 配准原视频、按源片段尺寸合成纯色底；必要时转码、补齐奇数边缘 | 官方 Mask 为遮罩而非彩色成片 [S2][S3]，具体合成流程由本项目设计，工具能力见 [S8] |
| 工程选择 | 原始 Alpha/Mask 缓存后可本地改背景色、不重复调用 Bria | 本地复用策略；仅直出有色 MP4 时**不**保证后续免 API 重跑 |
| 待实测 | `result.mask_url` 与个别 SDK 示例 `result.video_url` 不一致 | [S2][S3] 文字说明的是 `mask_url`，但示例代码访问 `video_url`；需要真实请求确定响应兼容逻辑 |
| 待实测 | Prompt 多实例选择稳定性、点选是否精准匹配一个实例、复杂发丝/运动边缘 | **质量风险与验收项，不是官方承诺** |
| 待确认 | 43 寸设备播放器支持的 H.264/H.265 Profile、码率、音轨及色彩空间 | 需要设备型号或实机检测；不能从 Bria API 文档推断 |

## 2026-10-27 自动模式原文件直传

- **官方复核：**[S1 自动去背景](https://docs.bria.ai/video-editing/editing/remove-background) 列出 MP4/MOV/WebM/AVI/GIF 及受支持编码；[S4 上传服务](https://docs.bria.ai/local-video-upload-service) 的 `media_type` 为可选 MIME 字符串，示例为 `video/mp4`，省略时使用 `video/` 前缀。两页均未要求所有视频先重编码为 H.264。
- **工程选择：**自动模式覆盖整段视频、内容探测确认上传类型且视频轨／容器时长均不超过 60 秒时，MP4/MOV/WebM/AVI 原字节直传；裁选、文字／点选和缺少可确认容器时长时沿用必要预处理。GIF 保留转为 MP4 的兼容路径，因为上传文档只声明视频类型，没有确认 `image/gif` 上传授权支持；不将该保守分支描述为自动抠图接口禁止 GIF。
- **验证边界：**原字节、MIME、代理／裁选和导出检查通过本地模拟上游测试；真实 Bria 对旋转、SAR、可变帧率及复杂素材的结果一致性仍需实测，现有结果校验未放宽。

### 同日真实结果配准复核

- **实测事实：**读取用户已完成任务的本地 D1 参数与 R2 缓存，源规格为 720×1280、653 帧、59.9194345fps、10.897967 秒；返回 Alpha 为 1280×720、653 帧、60fps、容器 10.89 秒，不含旋转矩阵，查看首帧确有横倒画面。没有新建 Bria 任务。
- **工程处理：**新增严格的同帧数／低累计偏差整数帧率兼容，及依据源有符号旋转矩阵的四分之一周还原；方向不明确时仍拒绝。方向还原、完整帧数、导出帧率与旧记录恢复由合成媒体回归验证；不由本样本推断 Bria 对全部手机／SAR／VFR 素材均有相同行为。官方一般格式与保留属性说明仍见 [自动接口](https://docs.bria.ai/video-editing/editing/remove-background)。

## 使用原则

1. 新增任何“平台最高/最低/默认/必须/支持”描述，都必须写明官方文档地址和具体接口，不能只写“Bria 官方规定”。
2. 源于用户的要求标为“用户需求”，工程推断与实现选择标为“工程选择”，未实测内容标为“待实测/待确认”。
3. 若官方文字与 SDK 示例冲突，以正式 API 合约加**真实联调响应**确认，记录实测日期及脱敏数据；不可把冲突当作已解决。
4. 官网内容可能变动。最终发布前复查来源与当前套餐权益，并补充设备端实测。

## 2026-10-22 联调复核与新增证据

- [S1/S2/S3/S4/S5/S6/S7] 已重新查看官方页面。自动背景默认值在 S1 的说明段与字段表仍有差异；本项目始终显式传入颜色、输出编码、`auto_zoom=false` 和 `preserve_audio=true`，不依赖默认值。
- **[真实账号短片实测]** 上传授权响应为 `result` 包装；Mask 两端点均返回 `mask_url`，自动返回 `video_url`。不将单次响应排除其他兼容字段的可能性。
- **[本地文件实测]** 自动透明结果为 VP9/WebM，`ALPHA_MODE=1` 标签大小写不固定。FFmpeg 的 libvpx-vp9 解码保留 Alpha；使用统一帧序号时间基准避免尾帧丢失。此处属于本地处理验证，不是新增 Bria 协议保证。
- **[测试素材来源]** NASA 宇航员公开图片，经 scikit-image 提供：[astronaut 数据说明及公共领域声明](https://scikit-image.org/docs/stable/api/skimage.data.html#skimage.data.astronaut)、[测试下载源](https://raw.githubusercontent.com/scikit-image/scikit-image/v0.25.2/skimage/data/astronaut.png)。使用 FFmpeg 制成 1 秒、512×512、24fps 片段并加入合成测试音轨。它用于链路冒烟，不代表真实运动视频质量。
- **[验证边界]** 原视频/缓存/导出留在本项目，Token、预签名 URL 和完整上游响应不写入文档或客户端；仅保存脱敏实测摘要。未做长片、极限分辨率或设备兼容性测试。

## 2026-10-22 Bria 输入格式对齐

- **[官方格式]** [S1](https://docs.bria.ai/video-editing/editing/remove-background) 列出 MP4、MOV、WebM、AVI、GIF 容器及 H.264、H.265、VP9、AV1、PhotoJPEG 视频编码。
- **[工程实现]** 上传后用 FFprobe 校验媒体容器和视频编码；只看文件扩展名或浏览器 MIME 不足以确认文件内容。
- **[本地预览]** AVI/GIF 或浏览器不能直接播放的受支持视频会被 FFmpeg 生成小尺寸 H.264/AAC 预览，方便播放、裁选和标注；Bria 仍接收原上传视频。此转换是本地兼容措施，不表示 Bria 支持额外格式。

## 2026-10-22 导出与界面限制复核

- 重新直读 [S1 自动模式](https://docs.bria.ai/video-editing/editing/remove-background)、[S2 文字 Mask](https://docs.bria.ai/video-editing/masking/mask-by-prompt)、[S3 点选 Mask](https://docs.bria.ai/video-editing/masking/mask-by-key-points)：当前官方页面仍列出自动 60 秒/16000×16000、文字与点选 5 秒/750p。界面在模式按钮下直接显示这些限制及链接。
- **[用户需求]** 输出规格跟随源视频，禁止手动指定。**[工程选择]** MP4/H.264、平均帧率归一化、奇数尺寸补最多 1 像素、1280×720 代理及历史兼容均属本地处理策略，不能视为 Bria 要求。
- **[本地实测]** 复用已有真实 Alpha 缓存，生成白/蓝两份 512×512、24fps、24 帧、有音轨的 MP4，与源片段一致。本次没有新增 Bria 请求，未扩展 AI 质量验收结论。

## 2026-10-23 Workers + D1 适配依据

| 编号 | 官方直达链接 | 核对内容 |
| --- | --- | --- |
| C1 | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) | Free 每日 100,000 请求、每 HTTP 请求 10ms CPU、128MB 内存；Free 账号 HTTP 请求体上限 100MB。等待网络不计 CPU，不等于可执行长时间视频编码 |
| C2 | [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) | Free 每日 5,000,000 行读取、100,000 行写入，合计 5GB 存储；日配额用尽后查询会失败 |
| C3 | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) | Free 单库最大 500MB，每次 Worker 调用最多 50 次查询；单行／BLOB 最大 2MB |
| C4 | [本地 D1](https://developers.cloudflare.com/workers/testing/miniflare/storage/d1/) | Miniflare 提供本地 D1；本地验证不能替代生产配额与 CPU 验收 |

- **[用户需求]** 使用 Workers Free + D1 Free；保留完整本地 Node.js 视频处理流程，内部调用，不做跨电脑历史同步。本地关闭后不主动刷新云端状态，重启继续查询。
- **[工程选择]** Worker 仅转发小型 JSON；Node.js 持有短期上传凭据直接上传至 Bria，再直接下载结果；D1 仅存任务、上传引用与去重信息，无 R2、视频编码、Webhook 或云端后台轮询。
- **[工程选择]** 服务密钥至少 32 字符，JSON 64KB 上限；云端占位、指纹、70 秒查询锁、90 秒提交不明判定及拒绝码白名单均为本项目规则，不是 Cloudflare 或 Bria 的官方要求。
- **[官方接口复核]** S1–S5 直达页面在本次适配规划中重新读取；继续显式传入原三模式参数，保留 Mask video_url 兼容分支和 Alpha 警告检查，不依赖有歧义的背景默认值。
- **[待实测]** 真实 Worker CPU 是否始终满足 Free 配额、账号权限、区域网络、真实 Bria 联调及签名结果有效期。Cloudflare 免费不包含 Bria 费用。

## 2026-10-24 浏览器本地 FFmpeg 迁移依据

| 编号 | 官方直达链接 | 核对内容 |
| --- | --- | --- |
| C5 | [Access JWT 验证](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/) | 服务端验证 JWT 签名、issuer、应用 audience 与有效期；不信任未经验证的用户声明 |
| C6 | [workers.dev](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/) | 可为 workers.dev 应用启用 Access，限制使用者 |
| C7 | [Worker 静态资源绑定](https://developers.cloudflare.com/workers/static-assets/binding/) | 同一 Worker 绑定前端资源并按路由处理 API |
| C8 | [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/) | multipart 创建、分片上传、完成、恢复，以及对象流式读写 |
| C9 | [R2 对象生命周期](https://developers.cloudflare.com/r2/buckets/object-lifecycles/) | 对象过期删除和未完成 multipart 终止规则 |
| F1 | [ffmpeg.wasm 概览](https://ffmpegwasm.netlify.app/docs/overview/) | FFmpeg 在浏览器 Web Worker 中运行；单／多线程 core 与虚拟文件系统 |
| F2 | [ffmpeg.wasm 性能](https://ffmpegwasm.netlify.app/docs/performance/) | 性能低于原生 FFmpeg；官方旧基准不能作为本项目耗时保证 |
| F3 | [ffmpeg.wasm 使用](https://ffmpegwasm.netlify.app/docs/getting-started/usage/) | Vite 使用 ESM core，加载后执行虚拟文件读写和转码 |

- **[用户需求更新]** 不保留本地 Node 后端；FFmpeg 允许本机运行。因此新网页采用浏览器 WASM，正常使用不依赖 3001 或原生 exe。
- **[官方重新核对]** S1 通过官方页面 HTML 核对自动最长 60 秒、输入 16000×16000；S2/S3 页面仍列出 5 秒、750p；S4 仍使用上传授权、multipart 和 file_url 三步。本次没有更改 Bria 接口参数与能力声明。
- **[官方平台限制]** C1 当前仍列出 Free 请求体 100 MB、静态文件单个 25 MiB。**[工程选择]** 8 MiB R2 上传分片及 WASM 静态分片；不能把这些分片大小描述为 Bria 规定。
- **[工程选择]** 私有 R2 仅暂存待转交 Bria 的文件，成功即删除；部署时配置一天过期及未完成分片终止规则。生命周期执行时机遵循 C9，不承诺精确到秒的清除。
- **[工程选择]** Access 登录代替浏览器持有共享服务密钥；同源媒体接口隐藏预签名 URL；身份归属哈希、Web Locks、IndexedDB、30 分钟查询窗口均属本项目策略。
- **[本地实测]** 固定 core 0.12.10 的 JavaScript ffprobe 包装没有保存 C 返回码；构建适配保留实际返回码，真实成功与损坏文件拒绝均回归。不是 Bria 或 Cloudflare API 规定。
- **[验证边界]** 真实 WASM 短片、三模式合成、离线换色、页面恢复与 4K 三帧冒烟通过；上游均模拟。生产 Access、R2、CPU 配额、真实 Bria 新上传链路、长片内存和设备播放待验收。

## 2026-10-24 Token 访问方式调整

- **[用户需求]** 带 Token 访问，不登录 Cloudflare 账号。
- **[工程选择]** 32 字节随机单次链接、24 小时兑换期、30 天 HttpOnly 会话，D1 仅存摘要并用条件 UPDATE 原子兑换；同一私人使用者的链接共用归属。这些不是 Bria 或 Cloudflare 官方规定。
- **[官方核对]** [Workers Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/) 说明 Access 在 Worker 执行前检查请求，并提供禁用规则／对应应用的方法。Token 模式仍需关闭该项目外层 Access；其他项目不受影响。

- **[用户需求补充]** 支持永久 Token。**[工程选择]** 显式 --permanent 创建可重复使用、无自动过期的授权；每次进入创建独立的 30 天会话，过期后重开原链接，支持管理员撤销。
