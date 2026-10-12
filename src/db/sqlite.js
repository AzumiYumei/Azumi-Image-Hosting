// ================================================================
// Copyright (c) 2025 AZUMI 数据库模块
// 
// 文件名称: Sqlite.js
// 作者: AzumiYumeichi
// 创建日期: 2025-11-06
// 版本: 1.0
// 
// 描述: 管理SQLite数据库连接与初始化，提供基本的Run/Get/All方法。
//       自动创建用户、图片、标签及关联表。启用外键约束，确保数据一致性。
// 
// 修改历史:
// 2025-11-06 - 初始版本
// ================================================================
const sqlite3 = require('sqlite3');
const { AsyncLocalStorage } = require('node:async_hooks');
const { randomBytes } = require('node:crypto');
const { Config } = require('../config');

class Database {
  /** 构造函数：初始化数据库连接路径 */
  constructor(filename) {
    /** @type {sqlite3.Database|null} */ this.m_Db = null;
    /** @type {string} */ this.m_DbPath = filename || Config.Get().m_DbFile;
    this.m_Queue = Promise.resolve();
    this.m_Context = new AsyncLocalStorage();
  }

  /** 方法：初始化数据库（创建连接、表结构、外键） */
  async Init() {
    await this.Open();
    await this.Run('PRAGMA foreign_keys = ON;');
    await this.Run('PRAGMA journal_mode = WAL;');
    await this.Run('PRAGMA synchronous = FULL;');
    await this.Run('PRAGMA busy_timeout = 5000;');
    await this.Run(`CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    );`);
    await this.Run(`CREATE TABLE IF NOT EXISTS images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER,
      filename TEXT NOT NULL,
      original_name TEXT,
      mime_type TEXT,
      size INTEGER,
      storage_path TEXT NOT NULL,
      remote_url TEXT,
      access_token TEXT UNIQUE,
      created_at TEXT NOT NULL,
      FOREIGN KEY(owner_id) REFERENCES users(id) ON DELETE SET NULL
    );`);
    await this.Run(`CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL
    );`);
    await this.Run(`CREATE TABLE IF NOT EXISTS image_tags (
      image_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY (image_id, tag_id),
      FOREIGN KEY(image_id) REFERENCES images(id) ON DELETE CASCADE,
      FOREIGN KEY(tag_id) REFERENCES tags(id) ON DELETE CASCADE
    );`);
    await this.Run('CREATE INDEX IF NOT EXISTS idx_image_tags_tag ON image_tags(tag_id, image_id)');
    await this.Run('CREATE INDEX IF NOT EXISTS idx_images_filename ON images(filename)');
    // 兼容尚未添加令牌列的旧数据库，并保留现有图片链接。
    const columns = await this.All('PRAGMA table_info(images)');
    if (!columns.some(column => column.name === 'access_token')) await this.Run('ALTER TABLE images ADD COLUMN access_token TEXT');
    // 旧记录允许重复内容，因此使用普通索引并由保存事务保证新增图片不重复。
    for (const name of ['source_hash', 'content_hash']) {
      if (!columns.some(column => column.name === name)) await this.Run(`ALTER TABLE images ADD COLUMN ${name} TEXT`);
      await this.Run(`CREATE INDEX IF NOT EXISTS idx_images_${name} ON images(${name})`);
    }
    await this.Run('CREATE UNIQUE INDEX IF NOT EXISTS idx_images_access_token ON images(access_token)');
    await this.Transaction(async () => {
      while (true) {
        const missing = await this.All("SELECT id FROM images WHERE access_token IS NULL OR access_token='' LIMIT 256");
        if (!missing.length) break;
        for (const image of missing) await this.Run('UPDATE images SET access_token=? WHERE id=?', [randomBytes(16).toString('hex'), image.id]);
      }
    });
    await this.Run('PRAGMA optimize;');
  }

  /** 方法：打开数据库连接 */
  Open(mode = sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE) {
    return new Promise((resolve, reject) => {
      if (this.m_Db) return resolve();
      const sqlite = sqlite3;
      this.m_Db = new sqlite.Database(this.m_DbPath, mode, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  /** 方法：执行写入/更新SQL */
  Run(sql, params = []) {
    return this.Schedule(() => new Promise((resolve, reject) => {
      this.m_Db.run(sql, params, function (err) {
        if (err) return reject(err);
        resolve({ lastID: this.lastID, changes: this.changes });
      });
    }));
  }

  /** 方法：查询单行SQL */
  Get(sql, params = []) {
    return this.Schedule(() => new Promise((resolve, reject) => {
      this.m_Db.get(sql, params, function (err, row) {
        if (err) return reject(err);
        resolve(row);
      });
    }));
  }

  /** 方法：查询多行SQL */
  All(sql, params = []) {
    return this.Schedule(() => new Promise((resolve, reject) => {
      this.m_Db.all(sql, params, function (err, rows) {
        if (err) return reject(err);
        resolve(rows);
      });
    }));
  }

  // 单连接事务独占队列，防止其他请求的写入混进事务或被一起回滚。
  Schedule(operation) {
    if (this.m_Context.getStore() === this) return operation();
    const result = this.m_Queue.then(operation);
    this.m_Queue = result.catch(() => {});
    return result;
  }

  Transaction(operation, readOnly = false) {
    if (this.m_Context.getStore() === this) return operation(this);
    return this.Schedule(() => this.m_Context.run(this, async () => {
      await this.Run(readOnly ? 'BEGIN' : 'BEGIN IMMEDIATE');
      try {
        const result = await operation(this);
        await this.Run('COMMIT');
        return result;
      } catch (err) {
        await this.Run('ROLLBACK');
        throw err;
      }
    }));
  }

  // 备份用独立只读连接取得一致快照，避免清单写盘阻塞正常查询和认证。
  async ReadSnapshot(operation) {
    const snapshot = new Database(this.m_DbPath);
    await snapshot.Open(sqlite3.OPEN_READONLY);
    try { return await snapshot.Transaction(operation, true); }
    finally { await snapshot.Close(); }
  }

  /** 方法：关闭数据库连接 */
  Close() {
    return this.Schedule(() => new Promise((resolve, reject) => {
      if (!this.m_Db) return resolve();
      this.m_Db.close((err) => {
        if (err) return reject(err);
        this.m_Db = null;
        resolve();
      });
    }));
  }

  /** 方法：获取单例 */
  static Get() {
    if (!this.m_Instance) {
      this.m_Instance = new Database();
    }
    return /** @type {Database} */ (this.m_Instance);
  }
}

module.exports = { Database };
