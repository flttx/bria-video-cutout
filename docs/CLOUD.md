# Cloudflare 网页与 API + 浏览器本地 FFmpeg

更新：2026-10-24。本文件是当前部署方式；替代之前要求运行本地 3001 的混合模式。

部署记录（2026-10-24）：用户发起迁移并完成 Access 配置后，已发布至 https://bria-video-cutout.flttxq.workers.dev ，版本 `f4921fb4-dc37-4b49-9298-b947ab6b71f1`。远程 D1 迁移、私有 R2 暂存桶及一天清理规则已配置；发布后首页、健康接口和 WASM 清单的未登录访问均跳转至对应 Access 应用。登录后的健康检查、真实 Bria 和成片下载仍待验收。

## 用户需求与工程选择

**用户需求：**正常使用不保留本地后端；FFmpeg 可在本机执行；打开网页后完成抠图、纯色合成和下载。

**工程选择：**React 静态网页与 API 使用同一个 Worker 域名；FFmpeg WebAssembly 使用本机浏览器 CPU／内存；IndexedDB 保存本机素材和成片。当前通过访问 Token 链接兑换 HttpOnly 会话（支持永久链接），不要求 Cloudflare 账号；Access JWT 保留为可选模式。Bria Token、旧服务密钥和 Bria 预签名地址留在服务端。用户主动打开的访问 Token 仅在入口短暂读取并交换，不嵌入静态包、不记日志、不存 localStorage。

```text
浏览器：选片 → WASM 校验、裁片、代理 → 同源分片上传
                                       ↓
Worker + 会话验证 → R2 临时文件 → Worker 流式 multipart → Bria
     ↓                                                    ↓
D1：用户归属、去重、状态 ← Worker 查询原任务 ←───────────────┘
     ↓
浏览器经 Worker 下载结果 → WASM 合成／校验 → IndexedDB → 下载 MP4
```

Worker 不做视频编码，不需要 Cloudflare Containers。保留旧 `/v1/*` 供历史 Node 调用方使用，新网页仅请求 `/browser/*`；代码中 `/api/*` 是浏览器本地适配器的逻辑路径，不发送 HTTP，也不访问 3001。

## 发布前准备

现有 D1 数据库继续使用；不能删除或重建去重记录。以下步骤会修改远程资源，须由操作者手动执行；代码构建和自动测试不会发布。

### 1. 构建与检查

在项目根目录：

```powershell
npm ci
npm run typecheck
npm run build
npm run test:worker
npm run test:browser
```

`npm run build` 包含前端构建和 Worker `deploy --dry-run`。FFmpeg core 在构建时复制到同源静态资源；WASM 分为 8 MiB 文件，浏览器重组，满足平台单个静态文件 25 MiB 上限。分块大小是工程选择，限制来自 [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)。

### 2. 迁移 D1，创建私有临时 R2 桶

```powershell
cd apps/worker
npx wrangler login
npx wrangler d1 migrations apply DB --remote
npx wrangler r2 bucket create bria-video-cutout-staging
```

若桶已经存在则复用，不再次创建。`wrangler.jsonc` 中的 `DB` 绑定已有真实数据库 ID；新增 `STAGING` 绑定对应上述桶。迁移 `0002_browser.sql` 新增用户归属、分片和上传记录，不改写原有 jobs/uploads。

在 R2 控制台为此专用桶配置 `uploads/` 前缀生命周期：删除超过 1 天的对象，终止超过 1 天未完成的 multipart 上传。正常转交 Bria 后程序立即删除暂存对象；异常关闭／断网留下的暂存由生命周期处理。对象到期删除不是即时执行保证，按平台规则生效。**桶保持私有，不开启公共访问。** [R2 生命周期官方说明](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)

使用分片是为了保留大文件上传能力：Free 账号单 HTTP 请求体上限 100 MB，但每片仅 8 MiB，Worker 不把整个视频载入内存。Worker 通过 R2 multipart 完成整文件后流式转交 Bria。生产 CPU 与大文件网络表现仍待实测。[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)、[R2 multipart API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)

R2 需要在账号中启用，是否处于免费额度内取决于实际存储和操作量；不承诺零费用，不自动开通计费。详见 [R2 计费](https://developers.cloudflare.com/r2/pricing/)。Bria 费用独立。

### 3. 访问链接免登录（当前默认）

**用户需求：**带 Token 进入，不登录 Cloudflare。**工程选择：**32 字节密码学随机 Token。永久链接不自动过期、可反复建立会话；一次性链接仍可选（24 小时兑换期）。浏览器会话持续 30 天，过期后重新打开同一永久链接即可。这些有效期不是 Cloudflare 或 Bria 规定。

1. 确保 D1 已应用至 `0004_permanent_tokens.sql`，Worker 设置 `AUTH_MODE=token` 并部署。
2. 关闭本项目外层 Access：Worker 的 **Access** 页面禁用该 Worker 的保护；如果之前通过域名入口配置，则在 **Settings → Domains & Routes → workers.dev** 禁用对应 Access，或在 Zero Trust 删除只保护本项目域名的应用。保留 workers.dev 路由开启，不修改其他项目应用。外层 Access 在 Worker 之前执行，保留时仍会要求 Cloudflare 登录。[官方禁用说明](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
3. 项目根目录生成访问链接：

   ```powershell
   node scripts/create-access-link.mjs --remote --permanent
   ```

4. 打开本机 `.tmp/cloud-access-link.txt`，复制第一行完整链接到浏览器。形如 `/auth/token#token=…`；Token 在 fragment 中，不放到 query。入口先从地址栏移除 Token，再通过同源 POST 兑换会话，成功跳回首页。链接文件不提交、不分享。

有效会话期间直接打开首页即可。永久链接可在其他浏览器使用，会话过期后重新打开原链接，不需要生成新 Token；它一直有效直到管理员撤销。省略 `--permanent` 仍签发 24 小时内单次兑换的链接。所有由该脚本生成的链接归属同一私人使用者，不能用作多人账号系统。旧 Access 身份的任务归属不会自动合并；本机缓存文件仍保留。

D1 只保存 Token／会话的 SHA-256 摘要。永久 Token 每次验证产生独立随机会话，退出一个浏览器不影响其他浏览器；撤销 Token 会删除关联会话。一次性模式仍用单条条件 UPDATE 防重复兑换。会话 Cookie 为 `__Host-cutout_session`，启用 Secure、HttpOnly、SameSite=Strict；写接口继续验证 Origin 和 X-Cutout-Client。无会话不能调用抠图 API，公开静态资源不包含凭据。

撤销本脚本签发的全部链接和会话（此操作会使已登录浏览器失效）：

```powershell
node scripts/create-access-link.mjs --remote --revoke-all
```

`POST /auth/logout` 可注销当前会话，要求同源 Origin 与 `X-Cutout-Client: 1`。本地 `--local` 签发仅用于 HTTPS Worker 模拟器；常规本地开发仍使用回环限定的 DEV_AUTH。

### 3A. Cloudflare Access（可选，非当前默认）

只有选择 `AUTH_MODE=access` 时才执行本节；Token 模式不需要以下登录保护。

为当前 Worker 的 `workers.dev` 地址启用 Access，或为自定义域名创建 Access 自托管应用。保护整个应用域名，并设置仅允许使用者邮箱／组的 Allow 策略；不要设置绕过身份验证的 Bypass 策略。[workers.dev 访问保护](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/)

将应用设置中的团队域名和 Application Audience (AUD) 填入 `apps/worker/wrangler.jsonc`：

当前控制台步骤（2026-10-24 核对）：

1. 首次进入 **Zero Trust** 时按向导建立团队；在 **Settings → Team name and domain** 记录 `xxx.cloudflareaccess.com`。它不是 Worker 的 `flttxq.workers.dev`。[团队域名说明](https://developers.cloudflare.com/cloudflare-one/faq/getting-started-faq/)
2. 打开 **Workers & Pages → bria-video-cutout → Access → Protect this Worker behind Access**，选择 **All traffic**，只保护本 Worker。[当前入口](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
3. 自己使用可以选择 **Cloudflare account** 登录；若限定具体邮箱，在对应 Access 应用中设置 **Allow → Include → Emails → 自己的完整邮箱**。邮件验证码登录须启用 **One-time PIN** 身份提供商，并在应用登录方式中选用；不要放行公共邮箱后缀。[邮件验证码](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/)、[邮箱策略](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/common-policies/)
4. 保存／**Apply Access**。旧版入口为 **Settings → Domains & Routes → workers.dev → Enable Cloudflare Access → Manage Cloudflare Access**；确认覆盖正式域名 `bria-video-cutout.flttxq.workers.dev`。[旧入口说明](https://developers.cloudflare.com/changelog/post/2025-10-03-one-click-access-for-workers/)
5. 在 **Zero Trust → Access controls → Applications** 找到对应应用，打开 **Configure → Additional settings**，复制 **Application Audience (AUD) Tag**。旧界面可能位于 Basic information；不是 Application ID。[AUD 获取说明](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)

无需安装 WARP 或创建 Tunnel。将以上两项填入下面的配置：

```jsonc
"vars": {
  "ACCESS_TEAM_DOMAIN": "你的团队.cloudflareaccess.com",
  "ACCESS_AUD": "Access应用的AUD"
}
```

团队域名不含 `https://` 或路径；AUD 不是 Bria Token。Worker 对 `/browser/*` 独立验证 Access JWT；未配置时明确拒绝请求，不退化为公开 API。[Access JWT 验证说明](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)

`DEV_AUTH=1` 只用于本地开发，不放入生产 vars 或 Secrets。即便误设，非回环域名也不能用它绕过鉴权。`preview_urls=false` 已显式配置。

### 4. Secret 与部署

已有正确的 Bria Secret 可直接沿用；需要更新时使用交互输入：

```powershell
npx wrangler secret put BRIA_API_TOKEN
npx wrangler deploy
```

`CUTOUT_CLOUD_TOKEN` 只供旧 `/v1/*` 调用方使用，新网页不需要且绝不应填入前端。不要复制根 `.env.development` 到静态目录；生产的 Bria Token 只保存在 Worker Secrets。[Secrets 官方说明](https://developers.cloudflare.com/workers/configuration/secrets/)

默认媒体下载／上传域名允许 Bria、Amazon S3、CloudFront 的官方域名后缀。如果实际账号返回其他域名，程序会报 `MEDIA_HOST`；管理员核对可信上游后，可在 Worker 变量 `BRIA_MEDIA_HOSTS` 中添加逗号分隔的域名。它不是浏览器参数，不接受任意客户端 URL，也不跟随上游重定向。

### 5. 验收

先通过访问链接建立会话，再打开部署输出的 HTTPS 地址。可选 Access 模式则通过 Access 登录。无需本机 `npm run dev`、Node API 或原生 FFmpeg。

1. 页面应显示浏览器处理环境可用，提交区不再提示 Access／云端配置错误。
2. 在同一已登录浏览器打开 `/browser/health`，核对 `processingReady=true`。它验证配置及 D1 查询，不验证 Bria 余额、权限或 4K 性能。
3. 先用短片完成上传、抠图、播放和下载；这一步会实际调用 Bria。查看任务对应的 D1 记录与 R2 暂存清理。
4. 保留缓存后更换背景，应仅本机合成，不再次提交抠图。
5. 刷新页面应保留任务和成片；提交结果不明时只能恢复原云端 ID 的查询，不能自动重试付费 POST。

## 开发环境

首次先在根目录 `npm run build`，再 `npm run db:local -w apps/worker`。仅当 `.dev.vars` 不存在时复制 `apps/worker/config.template`，设置开发凭据。

两个终端分别运行：

```powershell
npm run dev:worker
npm run dev
```

页面为 `http://localhost:5174`，Vite 仅将 `/browser` 转发到本地模拟 Worker 8787。D1 和 R2 使用本地模拟存储。根 `.env.development` 属于旧 Node API 与原生回归测试配置，不用于浏览器连接生产 Worker。

## 缓存与恢复边界

- 本机 IndexedDB 保存原素材、处理源片段、Alpha／Mask、任务和成片。换电脑、换浏览器、换站点域名不会自动恢复这些文件；清理站点数据会丢失它们。
- 无痕模式、存储配额、浏览器回收和内存不足可能导致失败，程序明确报错。生产使用请及时下载成片。
- Web Locks 防止同一浏览器多个标签页重复执行同一任务；WASM 操作串行运行，每次处理后释放 Worker 内存。
- 浏览器关闭时本地处理停止；Bria 已受理的任务可能继续。重新打开同一站点后继续查询原任务、下载与合成，前提是浏览器缓存仍在、结果地址尚有效。
- 同 ID 同参数去重；发出 POST 前先持久化提交标记，网络失败后只 GET 原任务。D1 未找到原任务时也不会自动重发。明确拒绝后由用户主动恢复才创建新提交 ID。
- D1 去重记录不自动清理；R2 仅临时上传，不保存最终成片，不承担浏览器素材备份。
- 老 `data/` 和旧 Node 任务未自动迁移，仍保留原文件；当前网页不访问旧 3001。

## 运行限制与验证范围

Bria 模式约束仍按 [SOURCES.md](SOURCES.md) 的 S1–S7；本次没有引入其他 AI，也没有增加自定义背景。4K 成片不等于原生 4K Mask。

浏览器使用 `@ffmpeg/ffmpeg 0.12.15`、单线程 `@ffmpeg/core 0.12.10`。构建脚本针对固定 core 包修正 ffprobe JavaScript 包装层未保存 C 返回码的问题，不修改 WASM；验证既包括成功解析，也包括损坏文件拒绝。版本升级必须重新核对此适配。

真实 WASM 的三模式短片合成、音轨、帧数、缓存换色、页面恢复已验证；4K 仅为 3840×2160、0.5 秒、3 帧合成素材冒烟，不能外推 60 秒复杂 4K 性能。官方也说明 WASM 性能低于原生 FFmpeg：[ffmpeg.wasm 性能](https://ffmpegwasm.netlify.app/docs/performance/)。

生产 Access、R2、网络、CPU／配额及真实 Bria 新链路未验证；部署前后按本文件步骤检查。自动测试全部拦截 Bria HTTP，不产生付费抠图请求。旧本地回归的 Matroska 基线失败见 [PROGRESS.md](PROGRESS.md)。

## 最新发布状态（Token 模式）

2026-10-24 已应用 D1 0003 并发布版本 `4061e1a0-39eb-4d53-829f-c6efb18479f0`。生产私人链接已写入本机 `.tmp/cloud-access-link.txt`（Git 忽略）。发布后匿名检查仍被外层 Cloudflare Access 跳转，需按第 3 节禁用本项目 Access；目前尚未完成生产免登录兑换和真实抠图验收。

2026-10-24 后续更新：永久 Token 模式已发布，版本 `ae8d003e-1ea9-44b3-b2c5-76f2bfcf7316`。`.tmp/cloud-access-link.txt` 现为永久可重复使用的链接。外层 Access 已解除；线上重复建立会话、health `processingReady=true`、匿名拒绝与独立退出验证通过。会话过期后重新打开该永久链接即可，Token 本身不自动过期；真实 Bria 抠图仍待验收。

## APP 按设备隔离（2026-10-25）

- 用户已明确授权修改服务并同步云端。迁移 `0005_device_scope.sql` 为 browser_jobs / browser_uploads 增加 device_id，原记录保留空值；先应用增量迁移，再发布 Worker。保留自定义域名 cutout.flttxq.top 与 workers.dev 入口。
- 新 APP 请求携带 `X-Cutout-Device: dev_<64位小写十六进制摘要>`。任务及上传操作按账号 owner＋device_id 查询；不携带标识的旧网页只访问空设备命名空间。health 返回 deviceIsolation / deviceId，旧 APP 和网页不受新增字段影响。
- `/browser/jobs/:id/claim-device` 仅用于本机已有旧任务升级，要求已认证账号和设备标识；原子地将空设备归属绑定一次，已属于其他设备的记录返回 404。重复绑定同一设备幂等，不访问 Bria，不改云 ID。旧版没有设备证据，不能追溯物理归属；同账号有相同旧任务记录时先绑定者取得归属，其他设备停止恢复，不另行提交。
- 设备标识用于任务分区，来源由客户端声明，不等同硬件认证；共享账号凭据不是每设备独立密钥。原有账号认证、同源验证继续生效。已有旧网页历史若对应任务被 APP 绑定，网页将不能再访问该项。
- Worker 回归 26/26，通过同账号不同设备的上传／任务／成品隔离、无 header 防绕过、旧任务竞争绑定与幂等；上游全 mock，不产生 Bria 费用。

生产已应用 0005 并部署版本 `d8498bf5-f197-4379-8a78-318218ef7efe`（2026-10-25）；直接连接自定义域名的认证、设备 health、旧客户端兼容和非法设备拒绝检查通过，测试会话已注销。没有付费转换或既有任务归属变更。
