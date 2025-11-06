# API 文档

除图片获取接口外，其余返回均为 JSON。图片获取接口仅返回单张图片的二进制，并保留原始文件名与格式。需要认证的接口使用 `Authorization: Bearer <token>`。

## 认证
- `POST /api/auth/register`
  - body: `{ "username": "u", "password": "p" }`
  - 返回: `{ id, username }`
  - curl 示例：
    ```
    curl -X POST http://<HOST>:<PORT>/api/auth/register \
      -H 'Content-Type: application/json' \
      -d '{"username":"user1","password":"pass123"}'
    ```
- `POST /api/auth/login`
  - body: `{ "username": "u", "password": "p" }`
  - 返回: `{ token }`
  - curl 示例：
    ```
    curl -X POST http://<HOST>:<PORT>/api/auth/login \
      -H 'Content-Type: application/json' \
      -d '{"username":"user1","password":"pass123"}'
    ```

## 图片
- `POST /api/images/upload`（需认证）
  - form-data: `files[]` 多文件, 可选 `tags`（逗号分隔或多值）
  - 返回: `{ created: [{ id }, ...] }`
  - curl 示例（多文件 + 多标签）：
    ```
    curl -X POST http://<HOST>:<PORT>/api/images/upload \
      -H 'Authorization: Bearer <TOKEN>' \
      -F 'files=@local1.png' \
      -F 'files=@local2.jpg' \
      -F 'tags=avatar' \
      -F 'tags=test'
    ```
- `POST /api/images/upload-url`（需认证）
  - body: `{ urls: ["http://...","..."], tags: ["tag1","tag2"] }`
  - 返回: `{ created: [{ id } | { error }, ...] }`
  - curl 示例：
    ```
    curl -X POST http://<HOST>:<PORT>/api/images/upload-url \
      -H 'Authorization: Bearer <TOKEN>' \
      -H 'Content-Type: application/json' \
      -d '{"urls":["https://example.com/a.png","https://example.com/b.jpg"],"tags":["code","js"]}'
    ```
- `GET /api/images`
  - 查询参数：`tags=tag1,tag2`（可选）、`random=true|false`
  - 返回: 单张图片二进制（保留原始文件名与格式）
  - curl 示例（随机获取并按原名保存）：
    ```
    curl -OJ "http://<HOST>:<PORT>/api/images?tags=avatar,test&random=true"
    ```
- `GET /api/images/:id/raw`
  - 返回图片二进制（浏览器或图片查看器直接显示），保留原始文件名与格式
  - curl 示例（按服务器提供的原始文件名保存到本地）：
    ```
    curl -OJ "http://<HOST>:<PORT>/api/images/123/raw"
    ```
- `DELETE /api/images/:id`（需认证）
  - 普通用户只能删除自己的图片；管理员可删除任意图片
  - curl 示例：
    ```
    curl -X DELETE "http://<HOST>:<PORT>/api/images/123" \
      -H 'Authorization: Bearer <TOKEN>'
    ```

## 标签
- `GET /api/tags`
  - 返回: `{ tags: [{ id, name }, ...] }`
  - curl 示例：
    ```
    curl "http://<HOST>:<PORT>/api/tags"
    ```

## 管理员
- `GET /api/users`（需管理员）
  - 返回: `{ users: [{ id, username, role, status, created_at }, ...] }`
  - curl 示例：
    ```
    curl -H 'Authorization: Bearer <TOKEN>' "http://<HOST>:<PORT>/api/users"
    ```
- `PATCH /api/users/:id/status`（需管理员）
  - body: `{ status: "active" | "disabled" }`
  - 返回: `{ id, status }`
  - curl 示例（禁用用户）：
    ```
    curl -X PATCH "http://<HOST>:<PORT>/api/users/2/status" \
      -H 'Authorization: Bearer <TOKEN>' \
      -H 'Content-Type: application/json' \
      -d '{"status":"disabled"}'
    ```
- `GET /api/admin/status/db`（需管理员）
  - 返回: `{ users, images, tags, dbFileSizeBytes, dbPath }`
  - curl 示例：
    ```
    curl -H 'Authorization: Bearer <TOKEN>' "http://<HOST>:<PORT>/api/admin/status/db"
    ```
- `POST /api/admin/backup/export?download=true`（需管理员）
  - 返回: 下载ZIP（包含 `data.json` 与 `images/`）或 `{ backupZip: "/绝对路径" }`
  - curl 示例（下载备份到本地）：
    ```
    curl -H 'Authorization: Bearer <TOKEN>' \
      -X POST "http://<HOST>:<PORT>/api/admin/backup/export?download=true" \
      -o backup.zip
    ```
- `POST /api/admin/backup/import`（需管理员）
  - form-data: `backupZip`（ZIP文件）
  - 返回: `{ imported: true }`
  - curl 示例（上传备份ZIP）：
    ```
    curl -H 'Authorization: Bearer <TOKEN>' \
      -X POST -F "backupZip=@backup.zip" \
      "http://<HOST>:<PORT>/api/admin/backup/import"
    ```

### 管理员登录说明
- 管理员用户名可通过环境变量 `ADMIN_USERNAME` 配置（默认 `admin`），密码通过 `ADMIN_PASSWORD` 配置；首次启动时自动创建该管理员账号。

## 备注
- 任何 git 操作不会影响 `data/` 与 `backups/` 的数据，这些目录已被 `.gitignore` 忽略。
- 随机与标签检索均基于数据库实现，可组合使用。