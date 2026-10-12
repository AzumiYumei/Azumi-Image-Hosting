const { Transform } = require('node:stream');
const fs = require('node:fs/promises');
const path = require('node:path');

function error(status, message) { return Object.assign(new Error(message), { status }); }

class ByteLimit extends Transform {
  constructor(limit) { super(); this.limit = limit; this.bytes = 0; }
  _transform(chunk, encoding, callback) {
    this.bytes += chunk.length;
    if (this.bytes > this.limit) return callback(error(413, '文件超过大小限制'));
    callback(null, chunk);
  }
}

function safeName(name) {
  if (typeof name !== 'string' || !name || name.length > 200 || name === '.' || name === '..' || /[\\/\x00-\x1f<>:"|?*]/.test(name) || /[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(name)) throw error(400, '文件名无效');
  return name;
}

// 所有文件访问限制在上传目录内，并拒绝符号链接。
async function imagePath(image) {
  const { Config } = require('../config');
  const candidate = path.join(Config.Get().m_UploadsDir, safeName(image.filename));
  const stat = await fs.lstat(candidate);
  if (!stat.isFile() || stat.isSymbolicLink()) throw error(400, '图片路径无效');
  return candidate;
}

class WorkGate {
  constructor() { this.active = 0; this.exclusive = false; this.stopping = false; }
  middleware(exclusive = false) {
    return (req, res, next) => {
      const { Config } = require('../config');
      if (this.stopping || this.exclusive || (exclusive && this.active) || (!exclusive && this.active >= Config.Get().m_MaxUploads)) {
        res.setHeader('Retry-After', '5');
        return res.status(503).json({ error: '服务繁忙，请稍后重试' });
      }
      this.active++;
      if (exclusive) this.exclusive = true;
      let released = false;
      // 客户端断开后后台任务可能尚未结束，由处理函数最终释放资源。
      req.releaseWork = () => {
        if (released) return;
        released = true;
        this.active--;
        if (exclusive) this.exclusive = false;
      };
      next();
    };
  }
}

module.exports = { error, ByteLimit, safeName, imagePath, WorkGate };
