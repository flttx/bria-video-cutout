# 项目规则

- 所有编辑仅限 bria-video-cutout，不触碰 E:\Projects\jupiter 的其他子项目。
- AI 仅使用 Bria Video API；FFmpeg/FFprobe 仅做确定性的视频预处理、合成和编码。
- 本地运行并导出文件，43 寸设备只负责播放；不做触屏专用 UI。
- 背景仅白色默认与九种其他预设纯色，禁止新增自定义背景图上传。
- 自动抠图 Bria 最高 60s；Prompt/点选 Bria Mask 最高 5s、750p。4K 输出不等于原生 4K Mask。
- 所有 Bria API 约束、默认值、能力声明须附官方直达链接并核对 docs/SOURCES.md；用户需求、工程决策、待实测假设必须分别标明，不得将方案推断冒充官方规定。
- 保护 Token、预签名 URL、私有文件路径；不得写入客户端或日志。
- 未实现的功能必须返回明确错误，不伪造完成或 QA 结果。
- 修改功能时同步更新 docs/PROGRESS.md 及必要的测试。
- 不自动提交、推送、部署、发布。
