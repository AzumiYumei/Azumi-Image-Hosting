const fsp = require('node:fs/promises');
const path = require('node:path');
const { Config } = require('../config');
const { Database } = require('../db/sqlite');
const { UserRepository } = require('../repositories/userRepository');
const { exportBackup, importBackup } = require('../utils/backup');
const { error } = require('../utils/resources');

class AdminController {
  static async ListUsers(req, res) {
    const after = Number(req.query.after || 0);
    const limit = Number(req.query.limit || 100);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw error(400, '分页参数无效');
    const users = await Database.Get().All('SELECT id,username,role,status,created_at FROM users WHERE id>? ORDER BY id LIMIT ?', [after, limit]);
    return res.json({ users, nextAfter: users.length === limit ? users.at(-1).id : null });
  }
  static async UpdateUserStatus(req, res) {
    const id = Number(req.params.id);
    const { status } = req.body || {};
    if (!Number.isSafeInteger(id) || id < 1 || !['active', 'disabled'].includes(status)) throw error(400, '编号或状态无效');
    if (id === req.user.id && status === 'disabled') throw error(400, '不能禁用当前管理员');
    if (!await UserRepository.FindById(id)) throw error(404, '用户不存在');
    await UserRepository.SetStatus(id, status);
    return res.json({ id, status });
  }
  static async DbStatus(req, res) {
    const db = Database.Get();
    const totals = await db.Get(`SELECT (SELECT COUNT(*) FROM users) AS users,
      (SELECT COUNT(*) FROM images) AS images, (SELECT COUNT(*) FROM tags) AS tags`);
    const sizes = await Promise.all(['', '-wal', '-shm'].map(async suffix => {
      try { return (await fsp.stat(Config.Get().m_DbFile + suffix)).size; }
      catch (err) { if (err.code === 'ENOENT') return 0; throw err; }
    }));
    return res.json({ ...totals, dbFileSizeBytes: sizes[0], dbTotalSizeBytes: sizes.reduce((a, b) => a + b, 0) });
  }
  static async ExportBackup(req, res) {
    try {
      const output = await exportBackup();
      if (String(req.query.download).toLowerCase() === 'true') {
        return await new Promise((resolve, reject) => res.download(output, path.basename(output), err => err && err.code !== 'ECONNABORTED' ? reject(err) : resolve()));
      }
      return res.json({ backupZip: output });
    } finally { req.releaseWork?.(); }
  }
  static async ImportBackup(req, res) {
    let counts;
    try {
      if (!req.file) throw error(400, '未提供备份文件');
      counts = await importBackup(req.file.path);
    } finally {
      try { if (req.file) await fsp.rm(req.file.path, { force: true }); }
      finally { req.releaseWork?.(); }
    }
    return res.json({ imported: true, counts });
  }
}

module.exports = { AdminController };
