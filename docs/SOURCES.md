# Bria 视频抠图方案：事实依据与来源

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
