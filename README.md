# Azumi Image Host

轻量图片托管 API：单个 Node.js 24 LTS 服务、SQLite 数据库和本地文件存储，支持 Windows、Linux 与 Docker。

支持本地/URL 批量上传、标签、随机与最新图片、用户管理、流式 ZIP 备份恢复。上传、压缩与下载均设有资源上限；读取缺失图片不会删除记录。

## 开始使用

```sh
npm ci
npm start
```

默认监听 `3000`，健康检查为 `/healthz`。项目提供 API，没有首页界面。开发环境未设置密钥时，在 `data/.jwt-secret` 保存随机密钥；生产环境必须提供至少 32 字节的随机 `JWT_SECRET`。

生产部署前参考 [.env.example](.env.example)、[部署说明](docs/deployment.md) 和 [接口说明](docs/api.md)。直接运行时 `.env` 不会自动加载，可使用 `node --env-file=.env src/app/server.js`；Docker Compose 自动读取 `.env`。

## 验证

```sh
npm test
npm audit
```

测试使用独立临时目录和数据库，不操作实际图片。支持单实例部署；不要让多个进程同时操作同一数据目录。图片公开可读，上传与管理需要登录。
