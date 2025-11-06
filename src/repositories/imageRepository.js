// ================================================================
// Copyright (c) 2025 AZUMI 图片数据访问
// 
// 文件名称: ImageRepository.js
// 作者: AzumiYumeichi
// 创建日期: 2025-11-06
// 版本: 1.0
// 
// 描述: 封装图片数据的增删查与标签关联逻辑，并提供按标签检索、
//       随机获取图片的接口。
// 
// 修改历史:
// 2025-11-06 - 初始版本
// ================================================================
const { Database } = require('../db/sqlite');

class ImageRepository {
  /** 方法：创建图片记录并返回ID */
  static async CreateImage({ ownerId, filename, originalName, mimeType, size, storagePath, remoteUrl }) {
    const db = Database.Get();
    const now = new Date().toISOString();
    const res = await db.Run(
      `INSERT INTO images (owner_id, filename, original_name, mime_type, size, storage_path, remote_url, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      [ownerId || null, filename, originalName || null, mimeType || null, size || 0, storagePath, remoteUrl || null, now]
    );
    return res.lastID;
  }

  /** 方法：为图片关联标签 */
  static async AttachTags(imageId, tagIds = []) {
    const db = Database.Get();
    for (const tagId of tagIds) {
      await db.Run('INSERT OR IGNORE INTO image_tags (image_id, tag_id) VALUES (?,?)', [imageId, tagId]);
    }
  }

  /** 方法：根据ID获取图片 */
  static async GetImageById(id) {
    const db = Database.Get();
    return await db.Get('SELECT * FROM images WHERE id = ?', [id]);
  }

  /** 方法：删除图片 */
  static async DeleteImage(id) {
    const db = Database.Get();
    await db.Run('DELETE FROM images WHERE id = ?', [id]);
  }

  /** 方法：列出图片（可选标签过滤） */
  static async ListImagesByTags(tagNames = []) {
    const db = Database.Get();
    if (!tagNames || tagNames.length === 0) {
      return await db.All('SELECT * FROM images ORDER BY id DESC');
    }
    const placeholders = tagNames.map(() => '?').join(',');
    return await db.All(
      `SELECT DISTINCT i.* FROM images i
       JOIN image_tags it ON i.id = it.image_id
       JOIN tags t ON t.id = it.tag_id
       WHERE t.name IN (${placeholders})
       ORDER BY i.id DESC`,
      tagNames
    );
  }

  /** 方法：随机获取图片（可选择标签过滤与数量限制） */
  static async RandomImages(tagNames = [], count = 1) {
    const db = Database.Get();
    let rows;
    if (!tagNames || tagNames.length === 0) {
      rows = await db.All('SELECT * FROM images ORDER BY RANDOM() LIMIT ?', [count]);
    } else {
      const placeholders = tagNames.map(() => '?').join(',');
      rows = await db.All(
        `SELECT DISTINCT i.* FROM images i
         JOIN image_tags it ON i.id = it.image_id
         JOIN tags t ON t.id = it.tag_id
         WHERE t.name IN (${placeholders})
         ORDER BY RANDOM() LIMIT ?`,
        [...tagNames, count]
      );
    }
    return rows;
  }
}

module.exports = { ImageRepository };