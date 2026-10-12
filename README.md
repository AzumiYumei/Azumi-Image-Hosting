# Azumi Image Hosting

一个面向个人和小型团队的轻量图床，提供网页管理面板和 HTTP API。使用单个 Node.js 服务、SQLite 数据库与本地文件存储，支持 Windows、Linux 和 Docker 部署。

## 功能

- **图片上传**：本地文件和公网 URL 批量上传，按实际内容校验图片格式。
- **图库管理**：标签管理、模糊搜索、按标签分组、分页浏览和图片删除。
- **图片访问**：稳定的令牌链接、指定图片、最新图片及随机图片，支持缓存验证和范围请求。
- **可控压缩**：设置压缩目标、尺寸和最大尝试次数；支持关闭压缩，多帧动画保留原内容。
- **用户管理**：登录、可选注册、用户启用和禁用；普通用户只能删除自己的图片。
- **备份恢复**：流式 ZIP 备份、编号映射、恢复校验、失败回滚和备份保留数量控制。
- **资源限制**：上传大小、批次数量、并发、像素和帧数均可配置；URL 下载设置超时并拦截内网访问。

## 快速开始

本地运行需要 **Node.js 24 LTS** 和 npm；使用 Docker 时不需要在宿主机安装 Node.js。

### 1. 获取项目

```sh
git clone https://github.com/AzumiYumei/Azumi-Image-Hosting.git
cd Azumi-Image-Hosting
```

### 2. 准备配置

将 [.env.example](.env.example) 复制为 `.env`：

```sh
# Linux / macOS
cp .env.example .env
```

```powershell
# Windows PowerShell
Copy-Item .env.example .env
```

生成随机密钥，将输出填写到 `.env` 的 `JWT_SECRET`：

```sh
node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
```

再设置 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD`。直接运行时，建议在 `.env` 中增加：

```dotenv
NODE_ENV=production
PORT=3000
```

生产环境必须配置至少 32 字节的随机密钥。管理员账号只在指定用户名不存在时创建；后续修改环境变量不会覆盖已有账号的密码或角色。示例配置关闭公开注册。

### 3. 启动服务

**直接运行：**

```sh
npm ci
node --env-file=.env src/app/server.js
```

`npm start` 不会自动读取 `.env`，只适用于环境变量已注入的情况。

**Docker Compose：**

```sh
docker compose up -d --build
docker compose logs -f
```

Linux 使用 Docker 前，需要确保挂载目录可由容器内的 UID/GID `1000:1000` 写入：

```sh
mkdir -p data backups
sudo chown -R 1000:1000 data backups
```

示例配置将 Docker 端口绑定到 `127.0.0.1`。需要其他设备直接访问时，修改 `.env` 的 `HOST_IP`；使用域名和 HTTPS 的部署方法见 [部署说明](docs/deployment.md)。

### 4. 使用图床

默认地址为 <http://localhost:3000>：

| 地址 | 用途 |
|---|---|
| `/` | 管理面板，未登录时跳转到登录页 |
| `/login.html` | 登录与注册页面 |
| `/healthz` | 服务与数据库健康检查 |

使用配置的管理员账号登录，即可上传图片、管理图库、复制图片链接，以及导出或恢复备份。

## 常用配置

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | 直接运行的监听端口与地址 |
| `APP_PORT` / `HOST_PORT` | `3000` / `3000` | Docker 容器内与宿主机端口 |
| `JWT_SECRET` | 生产环境必填 | 至少 32 字节的随机签名密钥 |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / 无 | 首次创建管理员的账号信息 |
| `REGISTRATION_ENABLED` | `true` | 设为 `false` 关闭公开注册；示例配置为 `false` |
| `MAX_FILE_BYTES` | `20971520` | 单张图片最多 20MiB |
| `MAX_FILES` | `20` | 每批最多 20 张，可配置到 50 |
| `MAX_CONCURRENT_UPLOADS` | `2` | 同时进行的图片写入任务数量 |
| `COMPRESS_TARGET_BYTES` | `262144` | 压缩目标 256KiB，设为 `0` 关闭 |
| `URL_TIMEOUT_MS` | `30000` | 单个 URL 的解析、跳转与下载超时 |
| `MAX_BACKUP_BYTES` | `1073741824` | 备份上传、输出和解压大小上限为 1GiB |
| `BACKUP_KEEP` | `3` | 保留最近生成的备份数量 |
| `CORS_ORIGINS` | 空 | 允许跨域访问的前端来源，逗号分隔 |

同源管理页面无需配置跨域。完整配置、代理设置和维护说明见 [部署说明](docs/deployment.md)。

压缩目标是软目标：达到尝试次数上限后保存更小的结果，不保证一定低于 256KiB。开启压缩时，图片链接返回的是压缩后的存储内容；需要保留原始字节可关闭压缩。

## 数据与备份

```text
data/
├── db.sqlite        # 图片、用户和标签数据
├── uploads/         # 正式图片文件
└── tmp/             # 上传与恢复暂存文件
backups/             # 导出的 ZIP 备份
```

图片链接公开可读；上传、删除和管理操作需要登录。令牌图片链接用于标识图片，不代表私密访问权限。

备份或恢复期间暂停图片写入，繁忙时返回 `503`，可稍后重试。恢复时重新映射编号和存储路径，保留已有图片令牌；发生冲突会明确报错并回滚。读取缺失图片只返回错误，不自动删除数据库记录。

项目按**单实例**设计，不应让多个服务进程同时操作同一数据目录。数据库使用 WAL；不要单独复制运行中的 `db.sqlite` 作为完整备份，使用管理页面导出，或停止服务后复制完整数据目录。建议将重要备份另存到其他设备。

## API

支持通过 HTTP API 集成上传、查询、删除和备份功能。主要接口：

| 接口 | 用途 |
|---|---|
| `POST /api/auth/login` | 获取登录令牌 |
| `POST /api/images/upload` | 本地批量上传 |
| `POST /api/images/upload-url` | URL 批量上传 |
| `GET /api/images/list` | 分页图库与标签模糊搜索 |
| `GET /api/images/:token` | 通过令牌访问图片 |
| `GET /api/images?random=true` | 获取随机图片，可按标签筛选 |

请求参数、权限和返回格式见 [接口说明](docs/api.md)。

## 开发与验证

```sh
npm ci
npm test
npm audit
```

测试使用独立临时目录和数据库，覆盖上传限制、权限、缓存、并发、恢复回滚、旧数据库迁移和图片链接兼容性，不操作现有图片。

项目代码位于 `src/`，管理页面位于 `public/`，测试位于 `test/`。许可证见 [LICENSE](LICENSE)。
