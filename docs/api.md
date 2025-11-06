# API 文档

所有返回均为 JSON，除原图获取接口。需要认证的接口使用 `Authorization: Bearer <token>`。

## 认证
- `POST /api/auth/register`
  - body: `{ "username": "u", "password": "p" }`
  - 返回: `{ id, username }`
- `POST /api/auth/login`
  - body: `{ "username": "u", "password": "p" }`
  - 返回: `{ token }`

## 图片
- `POST /api/images/upload`（需认证）
  - form-data: `files[]` 多文件, 可选 `tags`（逗号分隔或多值）
  - 返回: `{ created: [{ id }, ...] }`
- `POST /api/images/upload-folder`（需认证）
  - form-data: `folderZip` 单文件（将本地文件夹压缩成zip后上传）, 可选 `tags`
  - 返回: `{ created: [{ id }, ...] }`
- `POST /api/images/upload-url`（需认证）
  - body: `{ urls: ["http://...","..."], tags: ["tag1","tag2"] }`
  - 返回: `{ created: [{ id } | { error }, ...] }`
- `GET /api/images`
  - 查询参数：`tags=tag1,tag2`（可选）、`random=true|false`、`count=1..100`
  - 返回: `{ images: [...] }`
- `GET /api/images/:id/raw`
  - 返回图片二进制（浏览器或图片查看器直接显示）
- `DELETE /api/images/:id`（需认证）
  - 普通用户只能删除自己的图片；管理员可删除任意图片

## 标签
- `GET /api/tags`
  - 返回: `{ tags: [{ id, name }, ...] }`

## 管理员
- `GET /api/users`（需管理员）
  - 返回: `{ users: [{ id, username, role, status, created_at }, ...] }`
- `PATCH /api/users/:id/status`（需管理员）
  - body: `{ status: "active" | "disabled" }`
  - 返回: `{ id, status }`
- `GET /api/admin/status/db`（需管理员）
  - 返回: `{ users, images, tags, dbFileSizeBytes, dbPath }`
- `POST /api/admin/backup/export?download=true`（需管理员）
  - 返回: 下载ZIP（包含 `data.json` 与 `images/`）或 `{ backupZip: "/绝对路径" }`
- `POST /api/admin/backup/import`（需管理员）
  - form-data: `backupZip`（ZIP文件）
  - 返回: `{ imported: true }`

### 管理员登录说明
- 管理员用户名可通过环境变量 `ADMIN_USERNAME` 配置（默认 `admin`），密码通过 `ADMIN_PASSWORD` 配置；首次启动时自动创建该管理员账号。

## 备注
- 任何 git 操作不会影响 `data/` 与 `backups/` 的数据，这些目录已被 `.gitignore` 忽略。
- 随机与标签检索均基于数据库实现，可组合使用。