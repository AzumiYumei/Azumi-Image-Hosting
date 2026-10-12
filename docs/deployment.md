# 部署与维护

## 运行环境

使用 Node.js 24 LTS。项目依赖 Sharp 和 SQLite 原生模块，安装依赖时使用 `npm ci`，不要在安装失败时退回忽略锁文件的安装。更新依赖后运行 `npm test` 与 `npm audit`。

## 配置

复制 `.env.example` 为 `.env`，填写管理员密码和密钥。生成随机密钥：

```sh
node -e "console.log(require('node:crypto').randomBytes(48).toString('hex'))"
```

`NODE_ENV=production` 时缺少 `JWT_SECRET` 会拒绝启动；显式密钥少于 32 字节也会拒绝启动。更换密钥会使旧令牌失效。`ADMIN_USERNAME`、`ADMIN_PASSWORD` 只在对应用户名不存在时创建管理员，不覆盖已有用户或密码。

| 变量 | 默认值 | 作用 |
|---|---:|---|
| PORT / HOST | 3000 / 0.0.0.0 | 直接运行的监听地址 |
| DATA_DIR / BACKUPS_DIR | ./data / ./backups | 数据和备份目录 |
| MAX_FILE_BYTES | 20971520 | 单张上传/下载最多 20MiB |
| MAX_FILES | 20 | 每批最多 20 张，最高可配 50 |
| MAX_CONCURRENT_UPLOADS | 2 | 全局图片写入任务上限，包含上传和删除 |
| MAX_IMAGE_PIXELS | 25000000 | 解码总像素上限，动画按所有帧计算 |
| MAX_IMAGE_FRAMES | 100 | 动画帧数上限 |
| COMPRESS_TARGET_BYTES | 262144 | 压缩目标，设为 0 关闭 |
| COMPRESS_ATTEMPTS | 4 | 最大编码尝试次数 |
| MAX_IMAGE_DIMENSION | 2048 | 需要压缩时的宽高上限 |
| URL_TIMEOUT_MS | 30000 | 单个 URL 包含解析、跳转和下载的超时 |
| MAX_BACKUP_BYTES | 1073741824 | ZIP 上传、输出及解压总大小上限 |
| MAX_BACKUP_MANIFEST_BYTES | 16777216 | 备份 JSON 清单上限 |
| MAX_BACKUP_ENTRIES | 100000 | ZIP 图片条目与每类清单记录的上限 |
| BACKUP_KEEP | 3 | 自动保留最近生成的备份数量 |
| REGISTRATION_ENABLED | true | false 关闭公开注册；示例配置默认关闭 |
| MAX_TAGS | 32 | 单次标签数量，单个标签最长 100 字符 |
| ACCESS_LOG | true | false 关闭访问日志 |
| CORS_ORIGINS | 空 | 允许浏览器跨域的来源列表，逗号分隔 |
| TRUST_PROXY | 空 | Express 可信代理配置，例如 loopback |

JSON 请求最多 64KiB。认证接口每个来源每分钟最多 20 次，最多同时处理 4 个认证请求。代理配置必须与实际网络匹配，否则客户端可能伪造来源地址，或所有用户共享一个限流来源。

URL 上传仅允许 HTTP/HTTPS 公网地址，拒绝内网、保留地址和带凭据的 URL；每次重定向重新校验 DNS，最多三次重定向。请求不使用系统代理，避免绕过地址限制。

## 直接运行

```sh
npm ci
node --env-file=.env src/app/server.js
```

直接运行需要在 `.env` 中额外设置 `NODE_ENV=production`，并按需设置 `PORT`；`APP_PORT`、`HOST_PORT`、`HOST_IP` 用于 Compose，不影响直接运行。Linux 可通过 systemd 注入环境文件：

```ini
[Unit]
Description=Azumi Image Host
After=network.target

[Service]
Type=simple
User=azumi
Group=azumi
WorkingDirectory=/srv/azumi-image-host
Environment=NODE_ENV=production
EnvironmentFile=/srv/azumi-image-host/.env
ExecStart=/usr/bin/node src/app/server.js
Restart=on-failure
RestartSec=3
TimeoutStopSec=35
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

## Docker

```sh
docker compose up -d --build
docker compose logs -f
```

镜像使用多阶段构建，运行阶段不保留编译工具，以 `node` 用户运行。Linux 宿主机应预先创建目录并赋予 UID/GID 1000 写权限：

```sh
mkdir -p data backups
sudo chown -R 1000:1000 data backups
```

示例配置只将端口绑定到宿主机 `127.0.0.1`。对外部署可使用 Nginx 与 HTTPS，设置 `client_max_body_size` 时需考虑批量上传和备份大小；代理超时需覆盖备份耗时。验证服务请访问 `/healthz`，根路径提供管理页面，未登录时跳转到 `/login.html`。

Compose 限制日志轮转，停止服务时等待最长 35 秒。应用收到停止信号会停止接收新请求，等待已开始的任务并关闭数据库；超过 30 秒强制退出。请求总超时为 120 秒，备份下载的耗时仍受代理和客户端设置影响。

## 数据与恢复

`data/db.sqlite`、`data/uploads` 为持久数据，`data/tmp` 用于暂存。SQLite 启用 WAL 和 FULL 同步；状态接口统计数据库、WAL 与 SHM 大小。不要只复制正在运行的 `db.sqlite`，应使用备份接口，或停止服务后整体复制数据目录。

备份导出分页读取清单、流式打包图片，不把全部图片读入内存。图片已压缩，ZIP 内不再次压缩图片。备份或恢复期间暂停图片写入，繁忙返回 503，可稍后重试；单实例之外的进程不受这项锁控制。

恢复兼容原有完整 `data.json + images/` 备份，校验结构、路径、CRC、图片、关联关系和解压大小后导入。用户名和标签名相同则复用当前记录并保留当前权限；重新映射用户、图片、标签编号。忽略备份里的旧绝对路径；同名同内容图片复用，同名不同内容另存，不覆盖现有图片。失败回滚数据库并清理本次新增文件，ZIP 临时文件在返回成功前删除。

压缩目标是软目标：达到尝试上限后保留更小的结果，不保证一定小于 256KiB。多帧动画保留原内容以避免损坏动画；关闭压缩可保留原文件。公开地址返回的是存储内容，压缩开启时不是原始上传字节。

上传事务失败会清理新增文件。删除使用可恢复的暂存文件，重启时根据数据库恢复未提交的删除，或完成已提交的删除。掉电或强制终止仍可能产生孤立的上传/恢复文件；数据库与文件系统无法组成一个共同事务。启动清理超过一天的已知临时文件，不自动删除正式图片或缺失文件的记录。恢复前建议另存一份完整数据目录；定期将备份复制到其他设备。

旧数据仍可读取，无需批量改写图片路径。启动时自动为缺少令牌的旧数据库添加列，并为没有令牌的图片生成链接；已有令牌保持不变。备份恢复保留令牌链接，冲突时明确失败并回滚。旧版接受的非图片文件不会自动清除；新版本不再接受这些文件。新增索引在启动时自动创建，大图库首次启动可能需要较长时间。
