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
const path = require('path');
const { Config } = require('../config');

class Database {
  /** 构造函数：初始化数据库连接路径 */
  constructor() {
    /** @type {sqlite3.Database|null} */ this.m_Db = null;
    /** @type {string} */ this.m_DbPath = Config.Get().m_DbFile;
  }

  /** 方法：初始化数据库（创建连接、表结构、外键） */
  async Init() {
    await this.Open();
    await this.Run('PRAGMA foreign_keys = ON;');
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
  }

  /** 方法：打开数据库连接 */
  Open() {
    return new Promise((resolve, reject) => {
      if (this.m_Db) return resolve();
      const sqlite = sqlite3.verbose();
      this.m_Db = new sqlite.Database(this.m_DbPath, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  /** 方法：执行写入/更新SQL */
  Run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.m_Db.run(sql, params, function (err) {
        if (err) return reject(err);
        resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  }

  /** 方法：查询单行SQL */
  Get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.m_Db.get(sql, params, function (err, row) {
        if (err) return reject(err);
        resolve(row);
      });
    });
  }

  /** 方法：查询多行SQL */
  All(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.m_Db.all(sql, params, function (err, rows) {
        if (err) return reject(err);
        resolve(rows);
      });
    });
  }

  /** 方法：关闭数据库连接 */
  Close() {
    return new Promise((resolve, reject) => {
      if (!this.m_Db) return resolve();
      this.m_Db.close((err) => {
        if (err) return reject(err);
        this.m_Db = null;
        resolve();
      });
    });
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