# 独立 API 服务包

本目录是纯 API 的私有运行包，不包含网页、源码或本机历史数据。版本和平台见 RELEASE.txt。images.tar 内有 Bria Token 及构建时配置的 Tripo / Kling Key，只能私有保存和交付；PRIVATE_ACCESS.txt 是独立的 API 访问凭据，不是平台 Key。

## 启动

目标 Linux 主机安装 Docker Engine 和 Compose 插件后，将完整目录复制到主机，在该目录执行：

```sh
sha256sum -c SHA256SUMS
docker load -i images.tar
docker compose up -d
docker compose ps
```

默认仅监听主机回环 `127.0.0.1:3001`。使用已有反向代理或 SSH 隧道访问；不需要安装 Node.js、npm、FFmpeg。不要和占用 3001 的旧服务同时启动。

## 网页 / APP 接入

API 使用 HTTP Basic，用户名为 admin，密码见 PRIVATE_ACCESS.txt。`curl -u admin http://localhost:3001/api/health` 会提示输入密码。健康检查的能力标志仅说明配置就绪，不证明上游网络、账号额度或生成质量。

网页来源默认 `http://localhost:8080`。部署其他网页地址时，修改 compose.yaml 的 WEB_ORIGIN 并运行 `docker compose up -d`。网页服务器代理附加认证，平台 Key 不得放入浏览器。当前项目的网页启动配置示例：

```dotenv
CUTOUT_API_BASE_URL=http://127.0.0.1:3001
CUTOUT_API_PATH_PREFIX=
CUTOUT_API_USERNAME=admin
CUTOUT_API_PASSWORD=填写PRIVATE_ACCESS.txt中的Password
```

这里的 BASE_URL 相对于网页代理所在主机；远端 API 应通过受控代理或隧道接入。前端需使用支持 Bria 白底→可灵视频的新版。图生 3D 及模型渲染已移除，服务器无需安装 Chromium、GPU 或 Blender。

API 包含 `/api/videos`、`/api/jobs`、`/api/images` 和 `/api/image-videos`。所有接口都需认证，写入请求还需 `X-Cutout-Client: 1`。原生 APP 可不带 Origin；浏览器须使用配置的准确来源。图片白底和可灵视频生成会调用真实平台并可能扣费，历史结果查询不会新建付费任务。

## 更新与数据

数据保存在 Docker 命名卷。更新前等待任务结束并备份数据卷，保留同一 Compose 项目名和卷名。导入新包后替换 compose.yaml 并 `docker compose up -d`，同步更新网页/APP 的访问凭据；每次构建会生成新密码。

`docker compose stop` 可停止服务并保留数据。不要执行 `docker compose down -v`，它会删除数据卷。查看日志用 `docker compose logs --tail=100 api`。本包不会自动部署、推送、清理历史或备份数据。
