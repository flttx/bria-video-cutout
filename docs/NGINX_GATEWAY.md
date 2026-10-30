# Nginx 独立 API 入口

## 当前部署

公司服务器 `10.28.111.20` 的入口为 `http://10.28.111.20/bria-cutout/api/...`。只在原 Nginx 默认 server 中新增 `/bria-cutout/api/` 路由，不接管 `/api/`，不修改其他站点和容器。当前主机只配置了 HTTP 80；443、域名证书和外部网关未配置、未验证。

浏览器实际请求 `http://localhost:8080/bria-cutout/api/...`。本地 Vite 服务端附加接口认证，转发至公司 Nginx 的同名路径。Nginx 将路径改为 `/api/...`，上游为 `127.0.0.1:28084`，Docker 映射至容器 3001。浏览器不接收接口密码。后端返回的 `/api/...` 下载/缩略图地址由网页统一转换为 `/bria-cutout/api/...`，已经带前缀的地址及浏览器模式的 Blob URL 不重复改写。

本机 `apps/web/.env.server.local`：

```dotenv
CUTOUT_API_BASE_URL=http://10.28.111.20
CUTOUT_API_PATH_PREFIX=/bria-cutout
CUTOUT_API_USERNAME=admin
# 保留 PRIVATE_ACCESS.txt 对应的 CUTOUT_API_PASSWORD，不在本文中记录。
```

直接连接原始 API 镜像时，PATH_PREFIX 留空，BASE_URL 使用原镜像地址。浏览器仍使用独立路径，由 Vite 转换。WEB_ORIGIN 保持实际网页来源 `http://localhost:8080`，不是 API 地址。

## 服务器配置

- Compose（2026-10-30 更新）：`/home/jupiterdev/services/bria-video-cutout/backend-20261030-download-v3/compose.yaml`。
- 端口：`127.0.0.1:28084:3001`，不再绑定 `10.28.111.20:28084`。
- Nginx：`/etc/nginx/default.d/bria-cutout.conf`，内容来自 `deploy/standalone/nginx-api-location.conf`，必须包含在 server 块内。
- 当前镜像为 `bria-cutout-api:backend-20261030-download-v3`，包含结果下载停滞有限重连及图片下载进度。数据卷仍为 `bria-cutout-server_media`，没有删除或迁移数据。新目录的 `runtime.env` 以 600 权限保留原接口密码，覆盖镜像新生成的密码；服务端 `PRIVATE_ACCESS.txt` 与实际运行凭据一致，现有客户端无需换密码。
- SELinux 保持 Enforcing。为 Nginx 反向代理，将 TCP 28084 标记为 `http_port_t`，持久开启 `httpd_can_network_relay`；`httpd_can_network_connect` 保持 off。中继布尔值作用于主机 HTTP 服务，不是只针对这一条 location；不会自行新增监听端口。
- 本次没有停用 Toolbox，也没有修改其他容器、防火墙或外部域名路由。

## 接入与验证

APP 尚未接入，本轮无需迁移 APP。后续客户端的健康路径是 `/bria-cutout/api/health`，直接调用仍需 HTTP Basic 认证，POST 仍需 `X-Cutout-Client: 1`。后端返回的根路径 `/api/...` 必须补上 `/bria-cutout`；不要用以 `/` 开头的路径覆盖基础地址前缀。

验证使用真实 Nginx、API、FFmpeg 和一秒合成视频，覆盖认证、CORS、上传、预览、Range 206、浏览器播放和源文件逐字节下载。成品导出及历史下载另由本地浏览器回归验证，上游 Bria 模拟；不为部署验证提交真实付费任务。真实测试视频保留在数据卷，便于复查。

正式网页发布仍需托管侧代理并附加认证；只上传静态文件不会带上 Vite 代理。当前 HTTP 链路不是 HTTPS，外部入口的 DNS、证书和访问限制需另行配置。

## 备份和回滚

下载修复 v3 的停机一致备份位于 `backend-20261030-download-v3/deployment-backup/`，包括 `data.before.tar.gz`、校验值、旧 Compose、Nginx 哈希和其他容器前后启动时间。仅回滚 v3 时在 `backend-20261030-framing-v2` 目录执行 `docker compose up -d --wait api`，保留同一数据卷。v3 healthy、两条用户图片视频 completed 且代理 Range 206、真实结果文件重新下载哈希验证均通过；未改动 Nginx 或其他服务。

2026-10-30 更新前备份位于新目录的 `deployment-backup/`：`compose.before.yaml`、`data.before.tar.gz`（停机后取得一致快照，约 64 MiB）、`data.sha256`、`nginx.before.tar.gz`、Nginx 配置哈希及其他容器启动时间对照。原镜像和旧目录保留。新容器已 healthy，真实网关上传/预览/Range/原文件下载通过；其他容器未重启，Nginx 文件哈希未变，零次新增付费请求。

仅回滚本次 API 镜像时，在旧目录 `/home/jupiterdev/services/bria-video-cutout/backend-20261028-v1` 执行 `docker compose up -d --wait api`，保留同一数据卷；不要执行 `down -v`。部署验证合成上传 ID：`273e63c6-7881-42fe-aa4a-8a2b27dc388d`。

以下是 2026-10-29 网关迁移的历史备份和回滚方式。服务器备份目录位于旧交付目录的 `migration-20261029/`：

- `compose.before.yaml`：原内网 28084 映射。
- `compose.transition.yaml`：内网及回环双监听配置。
- `nginx.before.tar.gz`：原 Nginx 主配置及 include 目录。
- `selinux.before.txt`、`selinux-ports.before.txt`：原 SELinux 设置。
- `containers.before.txt`、`containers.after.txt`：其他容器启动时间对照。

本地旧环境文件备份在 Git 忽略的 `.tmp/nginx-migration-20261029/web.env.before`，包含私有接口配置，勿提交或公开。

优先只恢复旧直连入口，不撤销已正常运行的 Nginx：

```bash
cd /home/jupiterdev/services/bria-video-cutout/backend-20261028-v1
cp migration-20261029/compose.transition.yaml compose.yaml
docker compose config --quiet
docker compose up -d --wait api
```

本地网页 BASE_URL 改回 `http://10.28.111.20:28084`，PATH_PREFIX 留空并重启网页。新前端仍请求 `/bria-cutout/api/`，代理会转换到直连后端的 `/api/`，无需撤销前端代码。

若确定完全撤销网关，且没有其他配置变更或新服务依赖，则先恢复 `compose.before.yaml`，将新增 `bria-cutout.conf` 移出 Nginx 的 `*.conf` include 范围，执行 `sudo nginx -t` 后 reload。最后依据备份恢复 `httpd_can_network_relay=off` 并删除本次新增的 TCP 28084 本地端口标签。不要整包覆盖后来修改过的 Nginx 配置，不要执行 `docker compose down -v`。
