// ================================================================
// Copyright (c) 2025 AZUMI 应用服务器
// 
// 文件名称: Server.js
// 作者: AzumiYumeichi
// 创建日期: 2025-11-06
// 版本: 1.0
// 
// 描述: Express服务入口。初始化配置与数据库，种子管理员账号，
//       提供认证、图片、管理员相关API。支持Windows与Ubuntu部署，
//       直接通过IP:PORT访问，无需域名。
// 
// 修改历史:
// 2025-11-06 - 初始版本
// ================================================================
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const multer = require('multer');

const { Config } = require('../config');
const { Database } = require('../db/sqlite');
const { AuthMiddleware } = require('../middleware/auth');
const { AuthController } = require('../controllers/authController');
const { ImageController } = require('../controllers/imageController');
const { AdminController } = require('../controllers/adminController');
const { UserRepository } = require('../repositories/userRepository');

async function Bootstrap() {
  const cfg = Config.Get();
  await Database.Get().Init();
  await UserRepository.EnsureAdminSeed();

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(morgan('dev'));

  // 静态文件服务
  app.use(express.static(path.join(__dirname, '../../public')));

  // 文件上传存储配置
  const storage = multer.diskStorage({
    destination: function (req, file, cb) {
      cb(null, cfg.m_UploadsDir);
    },
    filename: function (req, file, cb) {
      const ext = path.extname(file.originalname) || '';
      const name = Date.now() + '-' + Math.random().toString(36).slice(2) + ext;
      cb(null, name);
    }
  });
  const upload = multer({ storage });

  // ------------------ 认证 ------------------
  app.post('/api/auth/register', AuthController.Register);
  app.post('/api/auth/login', AuthController.Login);

  // ------------------ 图片上传与管理 ------------------
  app.post('/api/images/upload', AuthMiddleware.VerifyToken, upload.array('files', 50), ImageController.UploadLocal);
  app.post('/api/images/upload-url', AuthMiddleware.VerifyToken, ImageController.UploadByUrl);

  app.get('/api/images/list', ImageController.ListImages); // 获取图片列表（JSON）
  app.get('/api/images', ImageController.GetImages); // 获取单张图片或随机
  app.get('/api/images/:id/raw', ImageController.GetRaw); // 获取原图
  app.delete('/api/images/:id', AuthMiddleware.VerifyToken, ImageController.DeleteImage); // 删除图片

  // ------------------ 标签 ------------------
  const { TagRepository } = require('../repositories/tagRepository');
  app.get('/api/tags', async (req, res) => {
    const tags = await TagRepository.ListTags();
    res.json({ tags });
  });

  // ------------------ 管理员接口 ------------------
  app.get('/api/users', AuthMiddleware.VerifyToken, AuthMiddleware.RequireAdmin, AdminController.ListUsers);
  app.patch('/api/users/:id/status', AuthMiddleware.VerifyToken, AuthMiddleware.RequireAdmin, AdminController.UpdateUserStatus);
  app.get('/api/admin/status/db', AuthMiddleware.VerifyToken, AuthMiddleware.RequireAdmin, AdminController.DbStatus);
  app.post('/api/admin/backup/export', AuthMiddleware.VerifyToken, AuthMiddleware.RequireAdmin, AdminController.ExportBackup);
  app.post('/api/admin/backup/import', AuthMiddleware.VerifyToken, AuthMiddleware.RequireAdmin, upload.single('backupZip'), AdminController.ImportBackup);

  app.listen(cfg.m_Port, '0.0.0.0', () => {
    console.log(`Azumi Image Host 运行中: http://localhost:${cfg.m_Port}/`);
  });
}

Bootstrap().catch((err) => {
  console.error('启动失败:', err);
  process.exit(1);
});