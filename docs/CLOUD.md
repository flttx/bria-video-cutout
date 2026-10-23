# Workers + D1 运行与部署

本项目提供内部使用的混合模式：本地页面和 Node.js 负责视频文件、FFmpeg／FFprobe、预览及导出；Workers 负责 Bria JSON 请求，D1 保存云端任务。文件由 Node.js 直接上传至 Bria、直接下载回本机。D1 不是文件备份，其他电脑不能通过它恢复本机素材。

## 环境与配置

完整工作区开发使用 Node.js 22.12+、npm、FFmpeg／FFprobe。推荐 Node.js 24 LTS。Worker 工具与本地运行时版本锁定在 package-lock.json；Miniflare 使用当前 Wrangler 依赖的同一 beta 版本，仅用于开发测试，不进入 Worker 运行包。

本地 Node.js 服务配置：

```dotenv
BRIA_TRANSPORT=cloud
CUTOUT_CLOUD_URL=https://<worker-address>
CUTOUT_CLOUD_TOKEN=<至少32字符的随机服务端密钥>
```

以上填写在现有服务端环境配置中，不放入 Vite 环境变量或浏览器代码。URL 必须为 HTTPS origin；只对回环地址允许 HTTP，供本地开发使用。`BRIA_TRANSPORT` 省略时为 `direct`，此时继续使用原 `BRIA_API_TOKEN`。

Worker 配置两个 Secrets：`BRIA_API_TOKEN` 为 Bria 账号凭据，`CUTOUT_CLOUD_TOKEN` 与 Node.js 端一致。该密钥代表一个内部调用方，可访问该 Worker 的全部任务；不作为多用户权限系统。

切换模式只影响新任务。历史任务保存自身的 direct/cloud 模式；旧记录缺少模式时按 direct 处理。保留旧 direct 任务的查询能力需要保留本地 Bria Token。云端失败不会回退直连；已有 Alpha／Mask 可继续在本地换色导出。

## 本地运行

在项目根目录安装依赖和初始化本地 D1：

```powershell
npm install
npm run db:local -w apps/worker
```

仅当文件不存在时，将 `apps/worker/config.template` 复制为 `apps/worker/.dev.vars`，填入开发凭据。`.dev.vars` 和 `.wrangler` 均已忽略。真实 Bria Token 会使实际处理产生真实 API 调用；自动测试使用假凭据并拦截上游请求。

```powershell
npm run dev:worker
```

Worker 默认监听本地 8787；将 Node.js 的 `CUTOUT_CLOUD_URL` 设置为 `http://127.0.0.1:8787`，再在另一终端启动：

```powershell
npm run dev
```

页面仍访问 `http://localhost:5174`。新任务仍通过本地 `/api` 接口创建，浏览器不访问 `/v1`。

## 手动部署步骤

以下命令用于日后人工发布，会创建或修改远程资源；本次实现不执行这些步骤。进入 `apps/worker` 后运行：

```powershell
npx wrangler login
npx wrangler d1 create bria-video-cutout
```

把返回的数据库 ID 填入 `wrangler.jsonc` 的 `database_id`；仓库中的全零 ID 只用于本地占位，不能作为生产数据库。确认账号使用 Workers Free 后执行：

```powershell
npx wrangler d1 migrations apply DB --remote
npx wrangler secret put BRIA_API_TOKEN
npx wrangler secret put CUTOUT_CLOUD_TOKEN
npx wrangler deploy
```

Secrets 通过交互输入，不作为命令行参数、日志或代码保存。部署后，在本地服务端配置 Worker 的 HTTPS 地址及同一访问密钥，重启 Node.js。先检查本地 `/api/health` 的 `processingReady`，再按实际账号授权安排短片联调；health 不验证 Bria 套餐余额或接口权限。

## 验证命令

```powershell
npm run typecheck
npm run build
npm run test:local
npm run test:worker
npm audit --registry=https://registry.npmjs.org
```

`build` 中的 Worker 步骤是 `wrangler deploy --dry-run`，只打包、不发布。`test:worker` 使用本地 workerd 与真实 D1 SQL，并通过模拟 Bria、真实 FFmpeg 验证云端适配和成片；所有上游 HTTP 均拦截。媒体地址安全校验仍可能进行公共测试域名 DNS 解析。

`npm test` 打包 Worker 后串行执行两组测试并汇总结果；也可用上述命令分别排查。已知 Matroska Alpha 基线用例的情况见进度记录，不通过跳过或放宽断言规避。

## 状态、容量与恢复

- 云端状态为 `submitting / processing / completed / failed / rejected / uncertain`。云端完成仅代表 Bria 完成；本地通过文件检查和导出后，页面才显示完成。
- D1 主键是每次提交的 `cloudJobId`。同 ID 同规范化参数复用；不同参数返回 409。先插入占位，再发付费请求；90 秒后仍无受理信息的占位变为 `uncertain`，不会再次提交。
- 本地在发送前保存 `cloudJobId` 和提交尝试标记。丢失云端响应后，“恢复任务”只查询该 ID；明确拒绝后由用户主动恢复才生成新 ID。不要删除 D1 去重记录、替换数据库后盲目重跑不明任务。
- Bria 明确返回 400、401、403、404、405、413、415、422、429 时记为拒绝；408、5xx、网络中断或无效受理响应记为不明。这是本项目保守的恢复策略，不是上游 exactly-once 保证。
- Worker 不常驻轮询。Node.js 默认约 5 秒查询；D1 查询锁防止同任务并发访问 Bria，失败记录退避。关闭 Node.js 后不主动同步 D1；重新启动只恢复原有非终态任务，失败记录由用户点击恢复。
- 结果地址失效返回明确错误；不自动再次抠图。本地文件、缓存和云端去重记录均不自动清理。
- 本地 health 区分本地服务与抠图服务：云端不可达时本地仍返回 200，`processingReady=false`，保留本地预览、下载与缓存导出。
- Workers Free 为每日 100,000 请求、每请求 10ms CPU；D1 Free 为每日 5,000,000 行读取、100,000 行写入，单库最大 500MB、账号合计 5GB。按主键查询避免全表扫描；在 Cloudflare 控制台观察 CPU、请求与 D1 行数／存储。额度耗尽时可能返回平台错误，不自动升级套餐。

免费额度只涉及 Cloudflare，Bria 仍按实际账号计费。生产 CPU、网络、真实 Bria 账号和目标设备播放需要单独验收，不能从本地模拟结果推断。

官方资料：[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)、[D1 限制](https://developers.cloudflare.com/d1/platform/limits/)、[D1 计费](https://developers.cloudflare.com/d1/platform/pricing/)、[Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)、[Bria 上传](https://docs.bria.ai/local-video-upload-service)、[Bria 异步任务](https://docs.bria.ai/getting-started/async-requests)。
