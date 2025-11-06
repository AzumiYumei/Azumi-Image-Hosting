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

class AuthController {
  /** 方法：用户注册 */
  static async Register(req, res) {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: '缺少用户名或密码' });
    }
    const exists = await UserRepository.FindByUsername(username);
    if (exists) return res.status(409).json({ error: '用户名已存在' });
    const hash = bcrypt.hashSync(password, 10);
    const id = await UserRepository.CreateUser(username, hash, 'user');
    return res.json({ id, username });
  }

  /** 方法：用户登录 */
  static async Login(req, res) {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: '缺少用户名或密码' });
    }
    const user = await UserRepository.FindByUsername(username);
    if (!user) return res.status(404).json({ error: '用户不存在' });
    if (user.status !== 'active') return res.status(403).json({ error: '用户已被禁用' });
    const ok = bcrypt.compareSync(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: '密码错误' });
    const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, Config.Get().m_JwtSecret, { expiresIn: '7d' });
    return res.json({ token });
  }
}

module.exports = { AuthController };