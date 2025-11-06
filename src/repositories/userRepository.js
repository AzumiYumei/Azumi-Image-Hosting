// ================================================================
// Copyright (c) 2025 AZUMI 用户数据访问
// 
// 文件名称: UserRepository.js
// 作者: AzumiYumeichi
// 创建日期: 2025-11-06
// 版本: 1.0
// 
// 描述: 封装用户相关的数据库访问逻辑，包括创建用户、查询用户、
//       更新状态、列出用户、管理员种子初始化。
// 
// 修改历史:
// 2025-11-06 - 初始版本
// ================================================================
const bcrypt = require('bcryptjs');
const { Database } = require('../db/sqlite');
const { Config } = require('../config');

class UserRepository {
  /** 方法：按用户名查询用户 */
  static async FindByUsername(username) {
    const db = Database.Get();
    return await db.Get('SELECT * FROM users WHERE username = ?', [username]);
  }

  /** 方法：创建新用户（默认角色user，状态active） */
  static async CreateUser(username, passwordHash, role = 'user') {
    const db = Database.Get();
    const now = new Date().toISOString();
    const result = await db.Run(
      'INSERT INTO users (username, password_hash, role, status, created_at) VALUES (?,?,?,?,?)',
      [username, passwordHash, role, 'active', now]
    );
    return result.lastID;
  }

  /** 方法：更新用户状态 */
  static async SetStatus(userId, status) {
    const db = Database.Get();
    await db.Run('UPDATE users SET status = ? WHERE id = ?', [status, userId]);
  }

  /** 方法：列出所有用户 */
  static async ListUsers() {
    const db = Database.Get();
    return await db.All('SELECT id, username, role, status, created_at FROM users ORDER BY id ASC');
  }

  /** 方法：确保管理员种子（根据环境变量） */
  static async EnsureAdminSeed() {
    const cfg = Config.Get();
    const adminPassword = cfg.m_AdminPassword;
    const adminUsername = cfg.m_AdminUsername;
    if (!adminPassword) return; // 未配置则跳过
    const exists = await this.FindByUsername(adminUsername);
    if (exists) return; // 已存在则跳过
    const hash = bcrypt.hashSync(adminPassword, 10);
    await this.CreateUser(adminUsername, hash, 'admin');
    // 管理员创建后，即可用于登录管理系统
  }
}

module.exports = { UserRepository };