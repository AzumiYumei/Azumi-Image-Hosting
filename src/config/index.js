// ================================================================
// Copyright (c) 2025 AZUMI 配置模块
// 
// 文件名称: Config.js
// 作者: AzumiYumeichi
// 创建日期: 2025-11-06
// 版本: 1.0
// 
// 描述: 应用的配置中心，负责统一管理端口、JWT密钥、数据目录、
//       上传目录、备份目录以及数据库文件路径。初始化时自动创建
//       所需目录，避免部署复杂配置，确保Windows/Ubuntu均可运行。
// 
// 修改历史:
// 2025-11-06 - 初始版本
// ================================================================
const fs = require('fs');
const path = require('path');

class Config {
  /**
   * 构造函数：初始化配置并创建必要的目录结构
   */
  constructor() {
    /** @type {number} */ this.m_Port = parseInt(process.env.PORT || '8080', 10);
    /** @type {string} */ this.m_AdminPassword = process.env.ADMIN_PASSWORD || '';
    /** @type {string} */ this.m_AdminUsername = process.env.ADMIN_USERNAME || 'admin';
    /** @type {string} */ this.m_JwtSecret = process.env.JWT_SECRET || 'azumi-image-host-secret';

    // 数据目录（与git隔离，通过.gitignore忽略）
    /** @type {string} */ this.m_DataDir = path.resolve(process.cwd(), 'data');
    /** @type {string} */ this.m_UploadsDir = path.join(this.m_DataDir, 'uploads');
    /** @type {string} */ this.m_BackupsDir = path.join(process.cwd(), 'backups');
    /** @type {string} */ this.m_DbFile = path.join(this.m_DataDir, 'db.sqlite');

    this.EnsureDirectories();
  }

  /**
   * 方法：确保数据目录/上传目录/备份目录存在
   */
  EnsureDirectories() {
    [this.m_DataDir, this.m_UploadsDir, this.m_BackupsDir].forEach((dir) => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  /**
   * 方法：获取当前配置对象（用于路由及服务初始化）
   * 用法：const cfg = Config.Get();
   */
  static Get() {
    if (!this.m_Instance) {
      this.m_Instance = new Config();
    }
    return /** @type {Config} */ (this.m_Instance);
  }
}

module.exports = { Config };