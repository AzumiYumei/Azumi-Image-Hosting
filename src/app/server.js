const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('node:path');
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const multer = require('multer');
const sharp = require('sharp');
const { Config } = require('../config');
const { Database } = require('../db/sqlite');
const { AuthMiddleware } = require('../middleware/auth');
const { AuthController } = require('../controllers/authController');
const { ImageController } = require('../controllers/imageController');
const { AdminController } = require('../controllers/adminController');
const { UserRepository } = require('../repositories/userRepository');
const { TagRepository } = require('../repositories/tagRepository');
const { WorkGate, ByteLimit, error, safeName } = require('../utils/resources');

function authLimit() {
  const attempts = new Map();
  let active = 0;
  const timer = setInterval(() => {
    for (const [key, item] of attempts) if (item.until <= Date.now()) attempts.delete(key);
  }, 60000).unref();
  return {
    close: () => clearInterval(timer),
    get active() { return active; },
    middleware(req, res, next) {
      const key = req.ip;
      const now = Date.now();
      let item = attempts.get(key);
      if (!item || item.until <= now) {
        if (!item && attempts.size >= 10000) return res.status(503).json({ error: '服务繁忙' });
        item = { count: 0, until: now + 60000 }; attempts.set(key, item);
      }
      if (++item.count > 20) { res.setHeader('Retry-After', '60'); return res.status(429).json({ error: '认证请求过于频繁' }); }
      if (active >= 4) return res.status(503).json({ error: '认证服务繁忙' });
      active++;
      req.releaseAuth = () => { if (req.releaseAuth) { active--; req.releaseAuth = null; } };
      next();
    }
  };
}

function uploadStorage(cfg) {
  return {
    _handleFile(req, file, callback) {
      const filename = `${randomUUID()}.upload`;
      const destination = path.join(cfg.m_TempDir, filename);
      req.uploadPaths ||= [];
      req.uploadPaths.push(destination);
      const abort = new AbortController();
      const cancelled = () => abort.abort();
      req.once('aborted', cancelled);
      const limiter = new ByteLimit(file.fieldname === 'backupZip' ? cfg.m_MaxBackupBytes : cfg.m_MaxFileBytes);
      pipeline(file.stream, limiter, fs.createWriteStream(destination, { flags: 'wx' }), { signal: abort.signal })
        .then(() => callback(null, { filename, path: destination, size: limiter.bytes }))
        .catch(async err => { await fsp.rm(destination, { force: true }).catch(() => {}); callback(err); })
        .finally(() => req.off('aborted', cancelled));
    },
    _removeFile(req, file, callback) { fsp.rm(file.path, { force: true }).then(() => callback(null), callback); }
  };
}

async function cleanStaleTemps(cfg) {
  // 服务单实例启动时清理超过一天的中断上传，不触碰图片和备份。
  for (const name of await fsp.readdir(cfg.m_TempDir)) {
    const file = path.join(cfg.m_TempDir, name);
    const stat = await fsp.lstat(file);
    if (Date.now() - stat.mtimeMs < 86400000 || stat.isSymbolicLink()) continue;
    if (stat.isFile() && /^[0-9a-f-]+\.(upload|download)(\.[0-9a-f-]+\.compressed)?$/.test(name)) await fsp.unlink(file);
    if (stat.isDirectory() && /^backup-/.test(name)) {
      const entries = await fsp.readdir(file, { withFileTypes: true });
      if (entries.every(item => item.isFile())) {
        for (const entry of entries) await fsp.unlink(path.join(file, entry.name));
        await fsp.rmdir(file);
      }
    }
  }
  for (const name of await fsp.readdir(cfg.m_BackupsDir)) {
    if (!/^backup-[0-9T-]+Z-[0-9a-f-]+\.zip\.partial$/.test(name)) continue;
    const file = path.join(cfg.m_BackupsDir, name);
    const stat = await fsp.lstat(file);
    if (stat.isFile() && !stat.isSymbolicLink() && Date.now() - stat.mtimeMs >= 86400000) await fsp.unlink(file);
  }
}

async function recoverDeletions(cfg) {
  for (const name of await fsp.readdir(cfg.m_TempDir)) {
    const match = /^deleted-(\d+)-(.+)$/.exec(name);
    if (!match) continue;
    const source = path.join(cfg.m_TempDir, name);
    const stat = await fsp.lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    const filename = safeName(match[2]);
    const row = await Database.Get().Get('SELECT filename FROM images WHERE id=?', [Number(match[1])]);
    if (!row) { await fsp.unlink(source); continue; }
    if (row.filename !== filename) { console.error('删除暂存记录不匹配，保留文件:', name); continue; }
    const target = path.join(cfg.m_UploadsDir, filename);
    try {
      await fsp.copyFile(source, target, fs.constants.COPYFILE_EXCL);
      await fsp.unlink(source);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      console.error('删除暂存目标已存在，保留文件供检查:', name);
    }
  }
}

async function CreateApp() {
  const cfg = Config.Get();
  await Database.Get().Init();
  await recoverDeletions(cfg);
  await cleanStaleTemps(cfg);
  await UserRepository.EnsureAdminSeed();
  sharp.cache({ memory: 16, files: 0, items: 32 });
  sharp.concurrency(1);
  const app = express();
  const gate = new WorkGate();
  const auth = authLimit();
  app.disable('x-powered-by');
  // 只有明确配置时才信任代理，避免客户端伪造地址绕过限流。
  if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
  const origins = (process.env.CORS_ORIGINS || '').split(',').map(value => value.trim()).filter(Boolean);
  app.use(cors({ origin: origins.length ? origins : false }));
  if (process.env.ACCESS_LOG !== 'false') app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
  app.use((req, res, next) => {
    if (gate.stopping) return res.status(503).json({ error: '服务正在停止' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.use(express.static(path.join(__dirname, '../../public'), { maxAge: 0, dotfiles: 'deny' }));
  const json = express.json({ limit: '64kb', strict: true });
  const handle = controller => async (req, res, next) => {
    try { await controller(req, res); }
    catch (err) { next(err); }
    finally { req.releaseAuth?.(); req.releaseWork?.(); }
  };
  const storage = uploadStorage(cfg);
  const images = multer({ storage, limits: { fileSize: cfg.m_MaxFileBytes, files: cfg.m_MaxFiles, fields: cfg.m_MaxTags + 1, fieldSize: 4096, parts: cfg.m_MaxFiles + cfg.m_MaxTags + 1 } });
  const backups = multer({ storage, limits: { fileSize: cfg.m_MaxBackupBytes, files: 1, fields: 0, parts: 1 } });

  app.get('/healthz', async (req, res) => {
    await Database.Get().Get('SELECT 1');
    res.json({ status: 'ok' });
  });
  app.post('/api/auth/register', auth.middleware, json, handle(AuthController.Register));
  app.post('/api/auth/login', auth.middleware, json, handle(AuthController.Login));
  app.post('/api/images/upload', AuthMiddleware.VerifyToken, gate.middleware(), images.array('files', cfg.m_MaxFiles), handle(ImageController.UploadLocal));
  app.post('/api/images/upload-url', AuthMiddleware.VerifyToken, gate.middleware(), json, handle(ImageController.UploadByUrl));
  app.get('/api/images', ImageController.GetImages);
  app.get('/api/images/list', ImageController.ListImages);
  app.get('/api/images/:id/raw', ImageController.GetRaw);
  app.get('/api/images/:token', ImageController.GetImageByToken);
  app.delete('/api/images/:id', AuthMiddleware.VerifyToken, gate.middleware(), handle(ImageController.DeleteImage));
  app.get('/api/tags', async (req, res) => {
    const limit = Number(req.query.limit || 100);
    const after = Number(req.query.after || 0);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(after) || after < 0) throw error(400, '分页参数无效');
    const tags = await TagRepository.ListTags(after, limit);
    res.json({ tags, nextAfter: tags.length === limit ? tags.at(-1).id : null });
  });
  const admin = [AuthMiddleware.VerifyToken, AuthMiddleware.RequireAdmin];
  app.get('/api/users', ...admin, AdminController.ListUsers);
  app.patch('/api/users/:id/status', ...admin, json, AdminController.UpdateUserStatus);
  app.get('/api/admin/status/db', ...admin, AdminController.DbStatus);
  app.post('/api/admin/backup/export', ...admin, gate.middleware(true), handle(AdminController.ExportBackup));
  app.post('/api/admin/backup/import', ...admin, gate.middleware(true), backups.single('backupZip'), handle(AdminController.ImportBackup));
  app.use((req, res) => res.status(404).json({ error: '接口不存在' }));
  app.use(async (err, req, res, next) => {
    try { await Promise.all((req.uploadPaths || []).map(file => fsp.rm(file, { force: true }))); }
    catch (cleanupError) { console.error('清理上传失败:', cleanupError.message); }
    finally { req.releaseWork?.(); req.releaseAuth?.(); }
    if (req.aborted || res.destroyed) return;
    if (res.headersSent) return next(err);
    const status = err instanceof multer.MulterError ? (err.code === 'LIMIT_FILE_SIZE' ? 413 : 400) : (err.status >= 400 && err.status < 600 ? err.status : 500);
    if (status === 500) console.error('请求处理失败:', err.message);
    const message = err instanceof multer.MulterError ? '上传文件大小、数量或字段超过限制' : status === 500 ? '服务内部错误' : err.type === 'entity.parse.failed' ? 'JSON 格式无效' : err.message;
    res.status(status).json({ error: message });
  });
  return { app, gate, auth, close: auth.close };
}

async function Bootstrap() {
  const cfg = Config.Get();
  const runtime = await CreateApp();
  const server = runtime.app.listen(cfg.m_Port, cfg.m_Host);
  server.requestTimeout = 120000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 1000;
  server.on('error', err => { console.error('监听失败:', err.message); process.exitCode = 1; runtime.close(); Database.Get().Close().catch(closeError => console.error('数据库关闭失败:', closeError.message)); });
  server.on('listening', () => console.log(`Azumi Image Host 运行中: http://${cfg.m_Host}:${server.address().port}/`));
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    runtime.gate.stopping = true;
    runtime.close();
    const forced = setTimeout(() => { console.error('服务停止超时'); process.exit(1); }, 30000).unref();
    server.close(async () => {
      // 连接关闭后仍等待已开始的压缩或备份任务完成。
      while (runtime.gate.active || runtime.auth.active) await new Promise(resolve => setTimeout(resolve, 50));
      try { await Database.Get().Close(); clearTimeout(forced); }
      catch (err) { console.error('数据库关闭失败:', err.message); process.exitCode = 1; }
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  return server;
}

if (require.main === module) Bootstrap().catch(err => { console.error('启动失败:', err.message); process.exit(1); });
module.exports = { CreateApp, Bootstrap, recoverDeletions };
