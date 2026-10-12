# API

图片公开读取，写入和管理使用 `Authorization: Bearer <token>`。除取图/下载备份外均返回 JSON；错误返回 `{ "error": "说明" }`。令牌有效期七天，每次认证检查数据库中的用户状态和角色。

## 认证

- `POST /api/auth/register`：`{ "username": "u", "password": "p" }`，返回 `{ id, username }`。注册可通过配置关闭。
- `POST /api/auth/login`：同上，返回 `{ token, username, isAdmin }`，供管理页面使用。

用户名最长 64 字符且不能有首尾空格；密码非空且最多 72 个 UTF-8 字节。频繁请求返回 429，认证并发达到上限返回 503。

## 图片

GitHub 管理页面位于 `/`，登录页面位于 `/login.html`。保留以下扩展接口：

- `GET /api/images/list?search=关键词&before=编号&limit=50`：JSON 图片列表，返回 `{ images: [{ id, filename, tags, url, created_at }], nextBefore }`。支持标签模糊搜索，也可使用 `tags` 参数；默认 50、最多 100 条，编号倒序游标分页。
- `GET /api/images/:token`：通过 32 位十六进制令牌返回图片，已有链接保持可用。支持缓存验证和范围请求。

上传同时返回 `created` 与兼容管理页面的 `images` 字段，成功项包含 `{ id, accessToken, url, duplicate }`；URL 的失败项在 `created` 中报告，`images` 只包含成功项。`created` 为兼容字段名，包含新增和复用结果，并非全为新记录。

本地与 URL 上传默认进行全图库 SHA-256 内容查重。`duplicate: false` 表示新增；`duplicate: true` 表示复用已有图片的编号、令牌和链接，不新增文件，也不修改所有者或标签。文件名和来源 URL 不参与判断。同批次、并发上传以及原文件与其压缩后的存储文件均参与查重；仅视觉相似但字节不同的图片不会直接判为重复。旧图库启动时自动补齐存储摘要，旧图片压缩前的原始摘要无法恢复。备份保留新图片的原始摘要，恢复时重新计算存储摘要。

- `POST /api/images/upload`：multipart 字段 `files`（可重复），`tags`（逗号/中文逗号分隔或多值）。返回 `{ created: [{ id }] }`。默认最多 20 张，每张 20MiB；按实际内容校验格式、像素、帧数，扩展名和 MIME 使用检测结果。整批先校验图片；后续保存发生运行错误时，先前已成功保存的图片仍保留。
- `POST /api/images/upload-url`：`{ urls: ["https://..."], tags: ["标签"] }`。返回 `{ created: [{ id } | { error }] }`，单张下载错误不会影响其他 URL。仅允许公网 HTTP/HTTPS。
- `GET /api/images?tags=标签1,标签2&random=false`：返回最新的一张匹配图片。多个关键词按“任一标签模糊匹配”处理；可设 `random=true`。随机查找最多 32 个候选，最新查找最多 512 个候选；缺失文件过多时可能返回 404，需要管理员检查数据目录。
- `GET /api/images/:id/raw`：返回指定图片；支持 `Last-Modified` 条件请求、范围请求和一小时缓存。最新/随机地址使用 `no-cache`，保留每次重新选择图片的行为。
- `DELETE /api/images/:id`：需认证；所有者或管理员可删除，返回 `{ deleted: id }`。

支持 Sharp 可解码的 JPEG、PNG、WebP、GIF、TIFF、AVIF/HEIF 等格式；不接受 SVG 或任意文本。格式支持取决于运行环境的解码能力。可配置压缩目标和尝试次数；动画不自动压缩，详情参见部署说明。读取缺失文件返回 404，不删除数据库记录。

## 标签与用户

- `GET /api/tags?after=0&limit=100`：返回 `{ tags: [{id,name}], nextAfter }`。
- `GET /api/users?after=0&limit=100`：管理员接口，返回 `{ users: [{id,username,role,status,created_at}], nextAfter }`。
- `PATCH /api/users/:id/status`：管理员接口，body `{ status: "active" | "disabled" }`。不能禁用当前管理员；用户禁用后旧令牌立即失效。

列表按编号递增分页，默认 100，最多 200 条。将 `nextAfter` 作为下次 `after`，直到返回 null；恰好达到页大小时可能有一个额外空页。

## 状态与备份

- `GET /healthz`：数据库可用时返回 `{ status: "ok" }`，不需认证。
- `GET /api/admin/status/db`：管理员接口，返回 `{ users, images, tags, dbFileSizeBytes, dbTotalSizeBytes }`；总大小包含 WAL 和 SHM。
- `POST /api/admin/backup/export`：管理员接口，返回 `{ backupZip }`；加 `?download=true` 下载 ZIP。默认只保留最近三份自动生成的备份。
- `POST /api/admin/backup/import`：管理员接口，multipart 单字段 `backupZip`，返回 `{ imported: true, counts: { users, images, tags } }`。

图片写入与备份资源繁忙时返回 503，并附带 `Retry-After: 5`。上传大小超过限制返回 413，文件、字段、数量或备份校验错误返回 400。Docker 健康检查访问 `/healthz`，根路径为管理页面。

## 升级变化

生产环境必须配置安全密钥；标签/用户列表增加分页；默认关闭浏览器跨域访问，需要配置 `CORS_ORIGINS`；默认上传批量上限从 50 改为 20，可配置回 50。旧令牌使用旧密钥时会失效。备份仍使用 ZIP，旧版服务不保证支持新版本清单；升级前保留旧备份。
