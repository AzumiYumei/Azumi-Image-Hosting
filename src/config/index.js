const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

function integer(name, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} 配置无效`);
  return value;
}

class Config {
  constructor() {
    this.m_Port = integer('PORT', 3000, 0, 65535);
    this.m_Host = process.env.HOST || '0.0.0.0';
    this.m_AdminUsername = process.env.ADMIN_USERNAME || 'admin';
    this.m_AdminPassword = process.env.ADMIN_PASSWORD || '';
    if (!this.m_AdminUsername.trim() || this.m_AdminUsername.trim() !== this.m_AdminUsername || this.m_AdminUsername.length > 64 || Buffer.byteLength(this.m_AdminPassword) > 72) throw new Error('管理员用户名或密码配置无效');
    this.m_DataDir = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
    this.m_UploadsDir = path.join(this.m_DataDir, 'uploads');
    this.m_TempDir = path.join(this.m_DataDir, 'tmp');
    this.m_BackupsDir = path.resolve(process.env.BACKUPS_DIR || path.join(process.cwd(), 'backups'));
    this.m_DbFile = path.join(this.m_DataDir, 'db.sqlite');
    this.m_MaxFileBytes = integer('MAX_FILE_BYTES', 20 * 1024 * 1024);
    this.m_MaxFiles = integer('MAX_FILES', 20, 1, 50);
    this.m_MaxUploads = integer('MAX_CONCURRENT_UPLOADS', 2, 1, 16);
    this.m_MaxPixels = integer('MAX_IMAGE_PIXELS', 25 * 1000 * 1000);
    this.m_MaxFrames = integer('MAX_IMAGE_FRAMES', 100, 1, 1000);
    this.m_CompressBytes = integer('COMPRESS_TARGET_BYTES', 256 * 1024, 0);
    this.m_CompressAttempts = integer('COMPRESS_ATTEMPTS', 4, 1, 8);
    this.m_MaxDimension = integer('MAX_IMAGE_DIMENSION', 2048, 64, 16384);
    this.m_UrlTimeout = integer('URL_TIMEOUT_MS', 30000, 100, 120000);
    this.m_MaxBackupBytes = integer('MAX_BACKUP_BYTES', 1024 * 1024 * 1024);
    this.m_MaxManifestBytes = integer('MAX_BACKUP_MANIFEST_BYTES', 16 * 1024 * 1024);
    this.m_MaxBackupEntries = integer('MAX_BACKUP_ENTRIES', 100000);
    this.m_BackupKeep = integer('BACKUP_KEEP', 3, 1, 100);
    this.m_MaxTags = integer('MAX_TAGS', 32, 1, 100);
    this.m_RegisterEnabled = process.env.REGISTRATION_ENABLED !== 'false';
    this.EnsureDirectories();
    const secret = process.env.JWT_SECRET;
    if (secret && (Buffer.byteLength(secret) < 32 || secret === 'azumi-image-host-secret')) throw new Error('JWT_SECRET 必须是至少 32 字节的随机密钥');
    if (!secret && process.env.NODE_ENV === 'production') throw new Error('生产环境必须配置 JWT_SECRET');
    // 开发环境持久保存随机密钥，避免公开默认密钥和重启后退出登录。
    const secretFile = path.join(this.m_DataDir, '.jwt-secret');
    if (!secret) {
      try { fs.writeFileSync(secretFile, randomBytes(48).toString('hex'), { flag: 'wx', mode: 0o600 }); }
      catch (err) { if (err.code !== 'EEXIST') throw err; }
    }
    this.m_JwtSecret = secret || fs.readFileSync(secretFile, 'utf8').trim();
    if (Buffer.byteLength(this.m_JwtSecret) < 32) throw new Error('持久 JWT 密钥无效');
  }

  EnsureDirectories() {
    for (const dir of [this.m_DataDir, this.m_UploadsDir, this.m_TempDir, this.m_BackupsDir]) fs.mkdirSync(dir, { recursive: true });
  }

  static Get() { return this.m_Instance ||= new Config(); }
}

module.exports = { Config };
