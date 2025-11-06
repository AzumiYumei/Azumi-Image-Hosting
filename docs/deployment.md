# 部署文档（Windows & Ubuntu）

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