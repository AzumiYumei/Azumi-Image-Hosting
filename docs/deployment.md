# 部署文档（Windows & Ubuntu）
# 部署指南（Ubuntu）

本文档指导在 Ubuntu 服务器上部署 Azumi Image Host，覆盖环境准备、启动方式（前台与 systemd 服务）、Nginx 反向代理与 HTTPS、备份与恢复、升级与维护等。

## 环境准备
- 操作系统：Ubuntu 20.04/22.04/24.04（推荐 22.04+）
- 必备软件：`git`、`curl`、`build-essential`、`nodejs`（LTS，推荐 20.x）；可选：`nginx`、`jq`

安装依赖与 Node.js（NodeSource）：
```
sudo apt update
sudo apt install -y git curl build-essential jq
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v && npm -v
```

## 获取源码与目录布局
选择项目目录（示例使用 `/srv/azumi-image-host`）：
```
sudo mkdir -p /srv/azumi-image-host
sudo chown -R $USER:$USER /srv/azumi-image-host
cd /srv/azumi-image-host
git clone <你的仓库地址> .
npm ci || npm install
```

目录说明（首次启动会自动创建）：
- `data/`：应用数据根目录（自动创建）
  - `db.sqlite`：SQLite 数据库文件
  - `uploads/`：图片文件存储目录
- `backups/`：备份输出目录（自动创建）
- `.gitignore` 已忽略 `data/`、`backups/` 与 `.env`，保证数据与密钥不被提交到仓库

## 环境变量与默认值
- `PORT`：服务监听端口，默认 `8080`
- `ADMIN_USERNAME`：管理员用户名，默认 `admin`
- `ADMIN_PASSWORD`：管理员密码（仅用于首次种子创建；未设置则不创建管理员）
- `JWT_SECRET`：JWT 签名密钥，默认 `azumi-image-host-secret`（生产环境务必自定义）

注意：管理员种子创建逻辑为“若设置了 `ADMIN_PASSWORD` 且指定用户名不存在，则创建管理员并设置该密码；若该用户名已存在则跳过，不会覆盖密码”。

## 启动方式 A：前台启动（快速验证）
```
cd /srv/azumi-image-host
export PORT=8080
export ADMIN_USERNAME=azumi-admin
export ADMIN_PASSWORD='请替换为强密码'
export JWT_SECRET='请替换为强随机密钥'
npm start
```
验证服务：
```
curl -s http://127.0.0.1:8080/ -I
```

验证管理员登录与接口（示例）：
```
TOKEN=$(curl -s -X POST http://127.0.0.1:8080/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"azumi-admin","password":"你的强密码"}' | jq -r .token)

curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8080/api/users | jq
```

## 启动方式 B：systemd 服务（生产推荐）
1) 创建运行用户（可选，增强隔离）：
```
sudo adduser --system --group --home /srv/azumi-image-host azumi
sudo chown -R azumi:azumi /srv/azumi-image-host
```

2) 创建环境文件（通过 systemd 注入环境变量）：
```
sudo -u azumi tee /srv/azumi-image-host/.env >/dev/null <<'EOF'
PORT=8080
ADMIN_USERNAME=azumi-admin
ADMIN_PASSWORD=请替换为强密码
JWT_SECRET=请替换为强随机密钥
EOF
```

3) 创建 systemd 单元：`/etc/systemd/system/azumi-image-host.service`
```
[Unit]
Description=Azumi Image Host
After=network.target

[Service]
Type=simple
User=azumi
Group=azumi
WorkingDirectory=/srv/azumi-image-host
EnvironmentFile=/srv/azumi-image-host/.env
ExecStart=/usr/bin/node src/app/server.js
Restart=always
RestartSec=3
AmbientCapabilities=
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
```

4) 启动并设为开机自启：
```
sudo systemctl daemon-reload
sudo systemctl enable azumi-image-host
sudo systemctl start azumi-image-host
sudo systemctl status azumi-image-host --no-pager
```

查看运行日志：
```
journalctl -u azumi-image-host -f --no-pager
```

## 反向代理与 HTTPS（可选）
安装 Nginx：
```
sudo apt install -y nginx
```

示例站点配置：`/etc/nginx/sites-available/azumi-image-host`
```
server {
    listen 80;
    server_name example.com;

    location / {
        proxy_pass http://127.0.0.1:8080/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

启用站点并重载：
```
sudo ln -s /etc/nginx/sites-available/azumi-image-host /etc/nginx/sites-enabled/azumi-image-host
sudo nginx -t && sudo systemctl reload nginx
```

启用 HTTPS（Let’s Encrypt）：
```
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d example.com
```

## 备份与恢复
导出备份（ZIP，包含 `data.json` + `images/`）——需管理员：
```
curl -H "Authorization: Bearer $TOKEN" \
  -X POST "http://127.0.0.1:8080/api/admin/backup/export?download=true" \
  --output backup.zip
```

导入备份（上传 ZIP）——需管理员：
```
curl -H "Authorization: Bearer $TOKEN" \
  -F "backupZip=@backup.zip" \
  "http://127.0.0.1:8080/api/admin/backup/import"
```

数据目录位置（默认）：
- 数据库：`/srv/azumi-image-host/data/db.sqlite`
- 图片：`/srv/azumi-image-host/data/uploads/`
- 备份：`/srv/azumi-image-host/backups/`

## 升级与维护
- 拉取新版本并重启服务：
```
cd /srv/azumi-image-host
git pull
npm ci || npm install
sudo systemctl restart azumi-image-host
```
- 修改环境变量后重启：
```
sudo systemctl restart azumi-image-host
```
- 查看接口文档：详见 `docs/api.md`

## 常见问题
- 管理员未创建：需确保设置了 `ADMIN_PASSWORD`，并且指定的 `ADMIN_USERNAME` 在数据库中尚不存在。
- 端口占用：修改 `PORT` 或在 Nginx 中使用反向代理，避免直接暴露端口。
- `.env` 未生效：前台运行需使用 `export` 导出；生产环境通过 `EnvironmentFile` 注入。
- 权限问题：确保 `WorkingDirectory` 与数据目录归属 `azumi` 用户，systemd 中使用同一用户运行。

## 变量速查
- `PORT`（默认 8080）：监听端口
- `ADMIN_USERNAME`（默认 admin）：管理员用户名（可自定义）
- `ADMIN_PASSWORD`（无默认）：设置后才会触发管理员种子创建
- `JWT_SECRET`（默认 azumi-image-host-secret）：JWT 签名密钥（生产务必更换）

完成以上步骤后，你的 Azumi Image Host 即可在 Ubuntu 上稳定运行；如需进一步的限流、访问日志或多实例部署（负载均衡），可通过 Nginx 和 systemd 模板扩展实现。

---

# Docker 部署（Ubuntu）

## 前提条件
- 已安装 Docker 与 Docker Compose（Ubuntu 22.04+ 默认提供 `docker compose` 插件）
```
sudo apt update
sudo apt install -y docker.io
sudo systemctl enable --now docker
sudo usermod -aG docker $USER
newgrp docker
docker --version
docker compose version
```

## 快速开始
1) 在项目根创建 `.env`（用于注入环境变量）
```
tee .env >/dev/null <<'EOF'
# 容器内部应用端口（保持默认 8080，通常不需要改动）
APP_PORT=8080
# 宿主机对外绑定 IP（默认 0.0.0.0；如需仅本机访问，改为 127.0.0.1）
HOST_IP=0.0.0.0
# 宿主机对外端口（默认 3000）
HOST_PORT=3000

ADMIN_USERNAME=azumi-admin
ADMIN_PASSWORD=请替换为强密码
JWT_SECRET=请替换为强随机密钥
EOF
```

2) 构建并启动（后台运行）
```
docker compose up -d --build
```

若出现警告 `the attribute version is obsolete`：
- 说明：Compose v2 不再使用 `version` 字段；该字段将被忽略。
- 处理：已在仓库中移除 `version` 字段，更新到最新 `docker-compose.yml` 即可。

3) 查看日志与状态
```
docker compose logs -f
docker compose ps
```

如报错 `Cannot connect to the Docker daemon at unix:///var/run/docker.sock`：
- 确认 Docker 服务已启动：
  - `sudo systemctl status docker`
  - 如未运行：`sudo systemctl start docker` 或 `sudo systemctl enable --now docker`
- 当前用户加入 `docker` 组并重新登录：
  - `sudo usermod -aG docker $USER && newgrp docker`
- WSL(Ubuntu) 场景：需启用 systemd 或手动启动：
  - 在 `/etc/wsl.conf` 中配置：
    - `[boot]`
    - `systemd=true`
  - 在 Windows 执行 `wsl --shutdown` 后重开子系统；或临时运行 `sudo service docker start`。

4) 验证服务
```
curl -s http://127.0.0.1:3000/ -I
```

5) 验证管理员登录（示例）
```
TOKEN=$(curl -s -X POST http://127.0.0.1:3000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"azumi-admin","password":"你的强密码"}' | jq -r .token)

curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:3000/api/users | jq
```

## 目录与持久化
- 宿主机 `./data` 映射到容器 `/app/data`（包含 `db.sqlite` 与 `uploads/`）
- 宿主机 `./backups` 映射到容器 `/app/backups`
- `.gitignore` 已忽略上述目录与 `.env`，确保数据与密钥不入仓库

## 常用操作
- 停止：`docker compose down`（不删除卷）
- 停止并清理：`docker compose down -v`
- 重启：`docker compose restart`
- 进入容器：`docker compose exec app sh` 或 `bash`

## 升级与回滚
- 拉取最新代码后重建：
```
git pull
docker compose build --no-cache
docker compose up -d
```
- 回滚：保留旧镜像或使用 Git 标签回退代码后重新构建

## 反向代理（可选）
- 生产环境建议容器仅暴露到内网（例如宿主映射到 `127.0.0.1:8080`），对外通过 Nginx 暴露域名与 HTTPS。
- Nginx 配置参考前文“反向代理与 HTTPS”。

## 端口与IP设置（Docker）
- 宿主机对外端口与IP通过 `.env` 控制：
  - `HOST_IP`：绑定的宿主机 IP（默认 `0.0.0.0`，表示所有网卡；若仅本机访问，设为 `127.0.0.1`）
  - `HOST_PORT`：对外端口（默认 `3000`）
  - `APP_PORT`：容器内应用监听端口（默认 `8080`，与 Node 应用一致）
- 端口映射关系：`HOST_IP:HOST_PORT -> 容器 APP_PORT`。例如：
  - 对外开放：`HOST_IP=0.0.0.0`, `HOST_PORT=3000`, `APP_PORT=8080` → 外部访问 `http://<服务器IP>:3000/`
  - 仅本机访问：`HOST_IP=127.0.0.1`, `HOST_PORT=3000`, `APP_PORT=8080` → 仅宿主访问 `http://127.0.0.1:3000/`
- 如需更改对外端口，修改 `.env` 的 `HOST_PORT` 并重新 `docker compose up -d`。

## 注意事项
- 管理员种子：仅当设置了 `ADMIN_PASSWORD` 且 `ADMIN_USERNAME` 在数据库中不存在时创建；不会覆盖已存在管理员密码。
- 端口占用：若宿主端口已被占用，修改 `.env` 的 `HOST_PORT` 并重新 `docker compose up -d`。
- 权限：确保宿主机 `./data` 与 `./backups` 对当前用户可读写。

本应用为轻量化图床（JS/Node.js + SQLite），数据与图片存放在 `data/` 与 `backups/` 目录下，这些目录已通过 `.gitignore` 忽略，任何 git 操作均不会删除或覆盖其中的数据。

## 环境准备
- 安装 Node.js（建议 18+）
- Windows 需在 PowerShell 下用 `cmd /c` 执行 npm，避免执行策略拦截

## 快速部署步骤
1. 在项目根目录初始化并安装依赖：
   - Windows: `cmd /c "npm install"`
   - Ubuntu: `npm install`
2. 设置环境变量（至少管理员用户名、密码与端口）：
   - Windows（临时会话）：`$env:ADMIN_USERNAME="admin"; $env:ADMIN_PASSWORD="你的强密码"; $env:PORT="8080"`
   - Ubuntu（临时会话）：`export ADMIN_USERNAME="admin"; export ADMIN_PASSWORD="你的强密码"; export PORT=8080`
3. 启动服务：
   - Windows: `cmd /c "npm start"`
   - Ubuntu: `npm start`
4. 访问：`http://<服务器IP>:<端口>/`（API以 `/api/...` 形式）

### 管理员初始化
- 首次启动时，若设置了 `ADMIN_PASSWORD` 且不存在管理员用户，则自动创建用户名为 `ADMIN_USERNAME`（默认 `admin`）的管理员。

## 目录说明
- `data/uploads/`：用户上传或拉取的图片文件
- `data/db.sqlite`：SQLite数据库文件
- `backups/`：导出的备份zip将保存在这里

## 跨平台说明
- 本应用仅使用 Node.js 与 SQLite3，均可在 Windows 和 Ubuntu 运行
- 通过 IP:PORT 直接访问，不需要配置域名或额外反向代理

## 备份与恢复
- 导出备份：管理员调用 `POST /api/admin/backup/export?download=true` 可直接下载ZIP
- 导入备份：管理员上传ZIP至 `POST /api/admin/backup/import`（表单字段 `backupZip`）