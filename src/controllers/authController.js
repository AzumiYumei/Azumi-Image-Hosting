// ================================================================
// Copyright (c) 2025 AZUMI 认证控制器
// 
// 文件名称: AuthController.js
// 作者: AzumiYumeichi
// 创建日期: 2025-11-06
// 版本: 1.0
// 
// 描述: 提供用户注册与登录API。注册时校验用户名唯一，密码采用
//       bcryptjs进行哈希存储。登录成功返回JWT令牌，用于后续接口认证。
// 
// 修改历史:
// 2025-11-06 - 初始版本
// ================================================================
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { UserRepository } = require('../repositories/userRepository');
const { Config } = require('../config');
const { error } = require('../utils/resources');

function credentials(body) {
  const { username, password } = body || {};
  if (typeof username !== 'string' || username.length < 1 || username.length > 64 || username.trim() !== username || typeof password !== 'string' || !password || Buffer.byteLength(password) > 72) throw error(400, '用户名或密码格式无效（密码最多 72 字节）');
  return { username, password };
}

class AuthController {
  /** 方法：用户注册 */
  static async Register(req, res) {
    if (!Config.Get().m_RegisterEnabled) return res.status(403).json({ error: '注册已关闭' });
    const { username, password } = credentials(req.body);
    const exists = await UserRepository.FindByUsername(username);
    if (exists) return res.status(409).json({ error: '用户名已存在' });
    const hash = await bcrypt.hash(password, 10);
    let id;
    try { id = await UserRepository.CreateUser(username, hash, 'user'); }
    catch (err) { if (err.code === 'SQLITE_CONSTRAINT') throw error(409, '用户名已存在'); throw err; }
    return res.json({ id, username });
  }

  /** 方法：用户登录 */
  static async Login(req, res) {
    const { username, password } = credentials(req.body);
    const user = await UserRepository.FindByUsername(username);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    if (user.status !== 'active') return res.status(403).json({ error: '用户已被禁用' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: '密码错误' });
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, Config.Get().m_JwtSecret, { expiresIn: '7d' });
    return res.json({ token, username: user.username, isAdmin: user.role === 'admin' });
  }
}

module.exports = { AuthController };
