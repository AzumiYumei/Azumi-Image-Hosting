// ================================================================
// Copyright (c) 2025 AZUMI 管理员控制器
// 
// 文件名称: AdminController.js
// 作者: AzumiYumeichi
// 创建日期: 2025-11-06
// 版本: 1.0
// 
// 描述: 提供管理员相关接口：用户状态管理、数据库状态查看、
//       数据与图片备份的导出与导入。
// 
// 修改历史:
// 2025-11-06 - 初始版本
// ================================================================
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const { Database } = require('../db/sqlite');
const { Config } = require('../config');
const { UserRepository } = require('../repositories/userRepository');

class AdminController {
  /** 方法：列出所有用户 */
  static async ListUsers(req, res) {
    const users = await UserRepository.ListUsers();
    return res.json({ users });
  }

  /** 方法：更新用户状态（active/disabled） */
  static async UpdateUserStatus(req, res) {
    const { id } = req.params;
    const { status } = req.body || {};
    if (!['active', 'disabled'].includes(status)) {
      return res.status(400).json({ error: '状态无效' });
    }
    await UserRepository.SetStatus(id, status);
    return res.json({ id, status });
  }

  /** 方法：查看数据库状态（表行数与DB文件大小） */
  static async DbStatus(req, res) {
    const db = Database.Get();
    const users = await db.Get('SELECT COUNT(*) as c FROM users');
    const images = await db.Get('SELECT COUNT(*) as c FROM images');
    const tags = await db.Get('SELECT COUNT(*) as c FROM tags');
    const stat = fs.statSync(Config.Get().m_DbFile);
    return res.json({
      users: users.c,
      images: images.c,
      tags: tags.c,
      dbFileSizeBytes: stat.size,
      dbPath: Config.Get().m_DbFile
    });
  }

  /** 方法：导出备份（生成ZIP：data.json + images/*） */
  static async ExportBackup(req, res) {
    const db = Database.Get();
    const backupsDir = Config.Get().m_BackupsDir;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outZip = path.join(backupsDir, `backup-${stamp}.zip`);

    const users = await db.All('SELECT * FROM users');
    const images = await db.All('SELECT * FROM images');
    const tags = await db.All('SELECT * FROM tags');
    const imageTags = await db.All('SELECT * FROM image_tags');

    const zip = new AdmZip();
    zip.addFile('data.json', Buffer.from(JSON.stringify({ users, images, tags, imageTags }, null, 2), 'utf8'));

    // 打包图片文件
    for (const img of images) {
      const filePath = img.storage_path;
      if (fs.existsSync(filePath)) {
        const relative = path.join('images', path.basename(filePath));
        zip.addLocalFile(filePath, path.dirname(relative), path.basename(relative));
      }
    }
    zip.writeZip(outZip);

    if (String(req.query.download || 'false').toLowerCase() === 'true') {
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename=${path.basename(outZip)}`);
      return res.sendFile(outZip);
    }
    return res.json({ backupZip: outZip });
  }

  /** 方法：导入备份（上传ZIP） */
  static async ImportBackup(req, res) {
    const file = req.file; // 单文件上传字段：backupZip
    if (!file) return res.status(400).json({ error: '未提供备份文件' });
    const tempZip = file.path;
    const zip = new AdmZip(tempZip);
    const entries = zip.getEntries();
    const dataEntry = entries.find(e => e.entryName === 'data.json');
    if (!dataEntry) return res.status(400).json({ error: '备份文件缺少data.json' });
    const json = JSON.parse(zip.readAsText('data.json'));
    const imagesDir = path.join(Config.Get().m_UploadsDir);

    const db = Database.Get();
    // 简单合并策略：若用户名存在则跳过；若图片文件名存在则跳过
    for (const u of json.users || []) {
      const ex = await db.Get('SELECT id FROM users WHERE username = ?', [u.username]);
      if (!ex) {
        await db.Run('INSERT INTO users (id, username, password_hash, role, status, created_at) VALUES (?,?,?,?,?,?)',
          [u.id, u.username, u.password_hash, u.role, u.status, u.created_at]);
      }
    }
    // 导入图片文件
    for (const e of entries.filter(x => x.entryName.startsWith('images/'))) {
      const outPath = path.join(imagesDir, path.basename(e.entryName));
      if (!fs.existsSync(outPath)) {
        fs.writeFileSync(outPath, e.getData());
      }
    }
    for (const img of json.images || []) {
      const ex = await db.Get('SELECT id FROM images WHERE filename = ?', [img.filename]);
      if (!ex) {
        await db.Run(`INSERT INTO images (id, owner_id, filename, original_name, mime_type, size, storage_path, remote_url, created_at)
                      VALUES (?,?,?,?,?,?,?,?,?)`,
          [img.id, img.owner_id, img.filename, img.original_name, img.mime_type, img.size, img.storage_path, img.remote_url, img.created_at]);
      }
    }
    for (const t of json.tags || []) {
      const ex = await db.Get('SELECT id FROM tags WHERE name = ?', [t.name]);
      if (!ex) {
        await db.Run('INSERT INTO tags (id, name) VALUES (?,?)', [t.id, t.name]);
      }
    }
    for (const it of json.imageTags || []) {
      await db.Run('INSERT OR IGNORE INTO image_tags (image_id, tag_id) VALUES (?,?)', [it.image_id, it.tag_id]);
    }

    return res.json({ imported: true });
  }
}

module.exports = { AdminController };