const { Database } = require('../db/sqlite');
const { randomBytes } = require('node:crypto');

class ImageRepository {
  static async CreateImage({ ownerId, filename, originalName, mimeType, size, storagePath, remoteUrl, accessToken = randomBytes(16).toString('hex') }) {
    const result = await Database.Get().Run(`INSERT INTO images
      (owner_id, filename, original_name, mime_type, size, storage_path, remote_url, access_token, created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`, [ownerId || null, filename, originalName || null, mimeType, size, storagePath, remoteUrl || null, accessToken, new Date().toISOString()]);
    return result.lastID;
  }

  static async AttachTags(imageId, tagIds = []) {
    for (const id of tagIds) await Database.Get().Run('INSERT OR IGNORE INTO image_tags (image_id,tag_id) VALUES (?,?)', [imageId, id]);
  }

  static GetImageById(id) { return Database.Get().Get('SELECT * FROM images WHERE id=?', [id]); }
  static GetImageByToken(token) { return Database.Get().Get('SELECT * FROM images WHERE access_token=?', [token]); }
  static DeleteImage(id) { return Database.Get().Run('DELETE FROM images WHERE id=?', [id]); }

  // 标签反向索引先找图片编号，再按编号取有限记录。
  static Filter(tags = []) {
    return tags.length ? ` AND id IN (SELECT it.image_id FROM image_tags it
      JOIN tags t ON t.id=it.tag_id WHERE ${tags.map(() => "t.name LIKE ? ESCAPE '\\'").join(' OR ')} )` : '';
  }

  static TagParams(tags) { return tags.map(tag => `%${tag.replace(/[\\%_]/g, value => `\\${value}`)}%`); }

  static ListImagesByTags(tags = [], before = Number.MAX_SAFE_INTEGER, limit = 32) {
    return Database.Get().All(`SELECT * FROM images WHERE id < ?${this.Filter(tags)} ORDER BY id DESC LIMIT ?`, [before, ...this.TagParams(tags), limit]);
  }

  static GalleryImages(tags = [], before = Number.MAX_SAFE_INTEGER, limit = 50) {
    return Database.Get().All(`SELECT images.*,
      (SELECT GROUP_CONCAT(t.name, ', ') FROM tags t JOIN image_tags it ON t.id=it.tag_id WHERE it.image_id=images.id) AS tags
      FROM images WHERE id < ?${this.Filter(tags)} ORDER BY id DESC LIMIT ?`, [before, ...this.TagParams(tags), limit]);
  }

  static RandomImages(tags = [], count = 1) {
    // 只随机排序编号，避免排序完整图片记录；保持等概率选择和标签语义。
    return Database.Get().All(`SELECT * FROM images WHERE id IN
      (SELECT id FROM images WHERE 1=1${this.Filter(tags)} ORDER BY RANDOM() LIMIT ?) ORDER BY RANDOM()`, [...this.TagParams(tags), count]);
  }
}

module.exports = { ImageRepository };
