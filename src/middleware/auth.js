// ================================================================
// Copyright (c) 2025 AZUMI 身份认证中间件
// 
// 文件名称: AuthMiddleware.js
// 作者: AzumiYumeichi
// 创建日期: 2025-11-06
// 版本: 1.0
// 
// 描述: 使用JWT进行身份认证，提供VerifyToken和RequireAdmin方法。
//       VerifyToken用于校验用户登录态，RequireAdmin用于限制管理员接口。
// 
// 修改历史:
// 2025-11-06 - 初始版本
// ================================================================
const jwt = require('jsonwebtoken');
const { Config } = require('../config');

class AuthMiddleware {
  /** 方法：校验JWT并解析用户信息到req.user */
  static VerifyToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.startsWith('Bearer ')
      ? authHeader.substring(7)
      : null;
    if (!token) return res.status(401).json({ error: '未提供令牌' });
    try {
      const payload = jwt.verify(token, Config.Get().m_JwtSecret);
      req.user = payload; // { id, username, role }
      next();
    } catch (err) {
      return res.status(401).json({ error: '令牌无效或已过期' });
    }
  }

  /** 方法：限制管理员访问 */
  static RequireAdmin(req, res, next) {
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ error: '需要管理员权限' });
    }
    next();
  }
}

module.exports = { AuthMiddleware };