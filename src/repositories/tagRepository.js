// ================================================================
// Copyright (c) 2025 AZUMI 标签数据访问
// 
// 文件名称: TagRepository.js
// 作者: AzumiYumeichi
// 创建日期: 2025-11-06
// 版本: 1.0
// 
// 描述: 封装标签相关数据库访问逻辑，包括批量确保标签存在、列出标签。
// 
// 修改历史:
// 2025-11-06 - 初始版本
// ================================================================
const { Database } = require('../db/sqlite');

class TagRepository {
  /** 方法：批量确保标签存在并返回其ID列表 */
  static async EnsureTags(tagNames = []) {
    const db = Database.Get();
    const ids = [];
    for (const name of tagNames) {
      const trimmed = String(name || '').trim();
      if (!trimmed) continue;
      let tag = await db.Get('SELECT id FROM tags WHERE name = ?', [trimmed]);
      if (!tag) {
        const res = await db.Run('INSERT INTO tags (name) VALUES (?)', [trimmed]);
        ids.push(res.lastID);
      } else {
        ids.push(tag.id);
      }
    }
    return ids;
  }

  /** 方法：列出所有标签 */
  static async ListTags() {
    const db = Database.Get();
    return await db.All('SELECT id, name FROM tags ORDER BY name ASC');
  }
}

module.exports = { TagRepository };