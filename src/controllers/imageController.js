const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, randomBytes } = require('node:crypto');
const sharp = require('sharp');
const { Config } = require('../config');
const { Database } = require('../db/sqlite');
const { TagRepository } = require('../repositories/tagRepository');
const { ImageRepository } = require('../repositories/imageRepository');
const { download } = require('../utils/download');
const { error, imagePath } = require('../utils/resources');
const { hashImage } = require('../utils/imageHash');

const formats = { jpeg: ['.jpg', 'image/jpeg'], png: ['.png', 'image/png'], webp: ['.webp', 'image/webp'], gif: ['.gif', 'image/gif'], tiff: ['.tiff', 'image/tiff'], avif: ['.avif', 'image/avif'], heif: ['.heif', 'image/heif'], bmp: ['.bmp', 'image/bmp'] };

class ImageController {
  static SanitizeName(name) { return String(name || 'image').split(/[?#]/)[0].replace(/[^A-Za-z0-9._\-\u4e00-\u9fa5]/g, '_').slice(0, 180); }
  static ResolveMimeType(img) {
    const ext = path.extname(img.filename).toLowerCase();
    if (ext === '.jpeg') return 'image/jpeg';
    if (ext === '.tif') return 'image/tiff';
    return Object.values(formats).find(([suffix]) => suffix === ext)?.[1] || 'application/octet-stream';
  }
  static BuildDownloadName(img) {
    let name = this.SanitizeName(img.original_name || img.filename);
    const ext = path.extname(img.filename);
    if (path.extname(name).toLowerCase() !== ext.toLowerCase()) name += ext;
    return { ascii: name.replace(/[^\x20-\x7e]/g, '_'), utf8: encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`) };
  }

  static ScoreString(s) { return (s.match(/[\u4e00-\u9fa5]/g) || []).length * 2 - (s.match(/[ÃÂæçè]/g) || []).length; }
  static FixUtf8Mojibake(text) {
    const original = String(text || '');
    const trial = Buffer.from(original, 'latin1').toString('utf8');
    return this.ScoreString(trial) > this.ScoreString(original) ? trial : original;
  }
  static NormalizeTagsUtf8(raw) {
    const tags = [...new Set((Array.isArray(raw) ? raw : [raw ?? '']).flatMap(item => String(item).split(/[,，]/)).map(item => this.FixUtf8Mojibake(item.trim()).normalize('NFC')).filter(Boolean))];
    if (tags.length > Config.Get().m_MaxTags || tags.some(tag => tag.length > 100)) throw error(400, '标签数量或长度超过限制');
    return tags;
  }

  static async Inspect(filePath) {
    const cfg = Config.Get();
    const stat = await fsp.stat(filePath);
    if (!stat.size || stat.size > cfg.m_MaxFileBytes) throw error(413, '图片为空或超过大小限制');
    const input = await fsp.readFile(filePath);
    const signature = input.subarray(0, 12);
    const raster = signature.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
      || signature.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      || /^GIF8[79]a/.test(signature.toString('ascii'))
      || (signature.toString('ascii', 0, 4) === 'RIFF' && signature.toString('ascii', 8, 12) === 'WEBP')
      || [[73, 73, 42, 0], [77, 77, 0, 42], [73, 73, 43, 0], [77, 77, 0, 43]].some(bytes => signature.subarray(0, 4).equals(Buffer.from(bytes)))
      || signature.toString('ascii', 4, 8) === 'ftyp' || signature.toString('ascii', 0, 2) === 'BM';
    if (!raster) throw error(400, '文件不是支持的位图图片');
    const options = { animated: true, limitInputPixels: cfg.m_MaxPixels, failOn: 'warning' };
    let meta;
    try { meta = await sharp(input, options).metadata(); }
    catch { throw error(400, '文件不是有效图片，或图片像素超过限制'); }
    if (meta.format === 'heif' && meta.compression === 'av1') meta.format = 'avif';
    if (!formats[meta.format] || !meta.width || !meta.height || meta.width * meta.height > cfg.m_MaxPixels || (meta.pages || 1) > cfg.m_MaxFrames) throw error(400, '图片格式、像素或帧数不符合限制');
    // 校验像素解码，避免只含合法头部的截断文件被当作有效图片保存。
    try { await sharp(input, options).stats(); }
    catch { throw error(400, '图片内容损坏或无法解码'); }
    return meta;
  }

  static async EnsureMaxSize(filePath, maxBytes = Config.Get().m_CompressBytes, meta) {
    const cfg = Config.Get();
    const size = (await fsp.stat(filePath)).size;
    if (!maxBytes || size <= maxBytes) return { changed: false, newSize: size };
    meta ||= await this.Inspect(filePath);
    // 动画和不支持的输出格式保留原内容，避免破坏帧和透明度。
    if ((meta.pages || 1) > 1 || !['jpeg', 'png', 'webp', 'tiff', 'avif'].includes(meta.format)) return { changed: false, newSize: size };
    // 使用已限大小的输入缓冲，避免 Windows 上解码器持有源文件句柄导致替换失败。
    const source = await fsp.readFile(filePath);
    let best;
    for (let attempt = 0; attempt < cfg.m_CompressAttempts; attempt++) {
      const width = Math.max(64, Math.round(Math.min(meta.width, cfg.m_MaxDimension) * Math.pow(0.75, attempt)));
      const height = Math.max(64, Math.round(Math.min(meta.height, cfg.m_MaxDimension) * Math.pow(0.75, attempt)));
      const quality = Math.max(35, 80 - attempt * 15);
      let pipe = sharp(source, { limitInputPixels: cfg.m_MaxPixels, failOn: 'warning' }).rotate().resize({ width, height, fit: 'inside', withoutEnlargement: true });
      if (meta.format === 'jpeg') pipe = pipe.jpeg({ quality });
      if (meta.format === 'png') pipe = pipe.png({ compressionLevel: 6, palette: true, quality });
      if (meta.format === 'webp') pipe = pipe.webp({ quality, effort: 3 });
      if (meta.format === 'tiff') pipe = pipe.tiff({ compression: 'jpeg', quality });
      if (meta.format === 'avif') pipe = pipe.avif({ quality, effort: 2 });
      const buffer = await pipe.toBuffer();
      if (buffer.length < (best?.length ?? size)) best = buffer;
      if (best && best.length <= maxBytes) break;
    }
    if (!best) return { changed: false, newSize: size };
    const temp = `${filePath}.${randomUUID()}.compressed`;
    try {
      await fsp.writeFile(temp, best, { flag: 'wx' });
      await fsp.rename(temp, filePath);
    } finally { await fsp.rm(temp, { force: true }); }
    return { changed: true, newSize: best.length };
  }

  static async Save(filePath, originalName, ownerId, tags, remoteUrl = null, meta) {
    meta ||= await this.Inspect(filePath);
    const sourceHash = await hashImage(filePath);
    const result = image => ({ id: image.id, accessToken: image.access_token, url: `/api/images/${image.access_token}`, duplicate: true });
    const existing = await ImageRepository.FindDuplicate(sourceHash);
    if (existing) return result(existing);
    const compressed = await this.EnsureMaxSize(filePath, Config.Get().m_CompressBytes, meta);
    const contentHash = compressed.changed ? await hashImage(filePath) : sourceHash;
    const [ext, mimeType] = formats[meta.format];
    const filename = `${randomUUID()}${ext}`;
    const finalPath = path.join(Config.Get().m_UploadsDir, filename);
    const accessToken = randomBytes(16).toString('hex');
    let installed = false;
    try {
      return await Database.Get().Transaction(async () => {
        // 事务内再次查重，避免并发请求在首次查询后各自保存同一图片。
        const duplicate = await ImageRepository.FindDuplicate(sourceHash, contentHash);
        if (duplicate) return result(duplicate);
        await fsp.rename(filePath, finalPath);
        installed = true;
        const tagIds = await TagRepository.EnsureTags(tags);
        const id = await ImageRepository.CreateImage({ ownerId, filename, originalName: this.SanitizeName(originalName), mimeType, size: compressed.newSize, storagePath: filename, remoteUrl, accessToken, sourceHash, contentHash });
        await ImageRepository.AttachTags(id, tagIds);
        return { id, accessToken, url: `/api/images/${accessToken}`, duplicate: false };
      });
    } catch (err) { if (installed) await fsp.rm(finalPath, { force: true }); throw err; }
  }

  static async UploadLocal(req, res) {
    const files = req.files || [];
    const created = [];
    try {
      const tags = ImageController.NormalizeTagsUtf8(req.body?.tags);
      if (!files.length) throw error(400, '未选择文件');
      // 批量校验先于入库，避免混入非图片的批次被部分接受。
      const metadata = new Map();
      for (const file of files) metadata.set(file.path, await ImageController.Inspect(file.path));
      for (const file of files) {
        if (req.aborted || res.destroyed) throw error(408, '上传已取消');
        created.push(await ImageController.Save(file.path, file.originalname, req.user.id, tags, null, metadata.get(file.path)));
      }
    } finally {
      try { await Promise.all(files.map(file => fsp.rm(file.path, { force: true }))); }
      finally { req.releaseWork?.(); }
    }
    return res.json({ created, images: created });
  }

  static async UploadByUrl(req, res) {
    const abort = new AbortController();
    const onClose = () => { if (!res.writableFinished) abort.abort(); };
    res.on('close', onClose);
    try {
      const { urls, tags } = req.body || {};
      if (!Array.isArray(urls) || !urls.length || urls.length > Config.Get().m_MaxFiles || urls.some(url => typeof url !== 'string' || url.length > 2048)) throw error(400, 'URL 数量或格式不符合限制');
      const normalized = ImageController.NormalizeTagsUtf8(tags);
      const created = [];
      for (const url of urls) {
        if (abort.signal.aborted) break;
        const temp = path.join(Config.Get().m_TempDir, `${randomUUID()}.download`);
        try {
          const name = await download(url, temp, abort.signal);
          created.push(await ImageController.Save(temp, name, req.user.id, normalized, url));
        } catch (err) {
          if (!err.status && !['ECONNABORTED', 'ERR_CANCELED', 'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ERR_BAD_RESPONSE'].includes(err.code) && err.name !== 'AbortError') throw err;
          created.push({ error: err.status ? err.message : '下载失败或超时' });
        } finally { await fsp.rm(temp, { force: true }); }
      }
      if (!abort.signal.aborted) return res.json({ created, images: created.filter(item => item.id) });
    } finally { res.off('close', onClose); req.releaseWork?.(); }
  }

  static async SendImageFile(res, img, req) {
    let filePath;
    try { filePath = await imagePath(img); }
    catch (err) { if (err.code === 'ENOENT') return res.status(404).type('text/plain').send('文件缺失'); throw err; }
    const { ascii, utf8 } = ImageController.BuildDownloadName(img);
    res.setHeader('Content-Disposition', `inline; filename="${ascii}"; filename*=UTF-8''${utf8}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type(ImageController.ResolveMimeType(img));
    // 固定地址可缓存；随机和最新图片的地址每次重新校验。
    const stable = !!(req?.params?.id || req?.params?.token);
    res.setHeader('Cache-Control', stable ? 'public, max-age=3600' : 'no-cache');
    return new Promise((resolve, reject) => res.sendFile(filePath, { acceptRanges: true, lastModified: true, cacheControl: false }, err => {
      if (!err || err.code === 'ECONNABORTED') resolve();
      else reject(err);
    }));
  }

  static async GetImages(req, res) {
    const tags = ImageController.NormalizeTagsUtf8(req.query.tags);
    if (String(req.query.random).toLowerCase() === 'true') {
      // 一次获取有限随机候选，避免缺失文件反复触发全表随机排序。
      const rows = await ImageRepository.RandomImages(tags, 32);
      for (const row of rows) {
        try { await imagePath(row); return ImageController.SendImageFile(res, row, req); }
        catch (err) { if (err.code !== 'ENOENT') throw err; }
      }
    } else {
      let before = Number.MAX_SAFE_INTEGER;
      for (let batch = 0; batch < 16; batch++) {
        const rows = await ImageRepository.ListImagesByTags(tags, before, 32);
        if (!rows.length) break;
        for (const row of rows) {
          try { await imagePath(row); return ImageController.SendImageFile(res, row, req); }
          catch (err) { if (err.code !== 'ENOENT') throw err; }
        }
        before = rows.at(-1).id;
      }
    }
    return res.status(404).type('text/plain').send('未找到匹配图片');
  }

  static async GetRaw(req, res) {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) throw error(400, '图片编号无效');
    const image = await ImageRepository.GetImageById(id);
    if (!image) return res.status(404).type('text/plain').send('图片不存在');
    return ImageController.SendImageFile(res, image, req);
  }

  static async GetImageByToken(req, res) {
    if (!/^[0-9a-f]{32}$/.test(req.params.token)) throw error(400, '图片访问令牌无效');
    const image = await ImageRepository.GetImageByToken(req.params.token);
    if (!image) return res.status(404).type('text/plain').send('图片不存在');
    return ImageController.SendImageFile(res, image, req);
  }

  static async ListImages(req, res) {
    const before = Number(req.query.before || Number.MAX_SAFE_INTEGER);
    const limit = Number(req.query.limit || 50);
    if (!Number.isSafeInteger(before) || before < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw error(400, '分页参数无效');
    const tags = ImageController.NormalizeTagsUtf8(req.query.search ?? req.query.tags);
    const rows = await ImageRepository.GalleryImages(tags, before, limit);
    const images = [];
    for (const image of rows) {
      try { await imagePath(image); }
      catch (err) { if (err.code === 'ENOENT') continue; throw err; }
      images.push({ id: image.id, filename: image.filename, tags: image.tags || '', url: `/api/images/${image.access_token}`, created_at: image.created_at });
    }
    return res.json({ images, nextBefore: rows.length === limit ? rows.at(-1).id : null });
  }

  static async DeleteImage(req, res) {
    let staged;
    let original;
    try {
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id < 1) throw error(400, '图片编号无效');
      const img = await ImageRepository.GetImageById(id);
      if (!img) throw error(404, '图片不存在');
      if (req.user.id !== img.owner_id && req.user.role !== 'admin') throw error(403, '无权删除该图片');
      try {
        original = await imagePath(img);
        // 暂存名保留编号和文件名，进程中断后可根据数据库恢复或完成删除。
        staged = path.join(Config.Get().m_TempDir, `deleted-${id}-${img.filename}`);
        await fsp.rename(original, staged);
      } catch (err) { if (err.code !== 'ENOENT') throw err; }
      try { await ImageRepository.DeleteImage(id); }
      catch (err) { if (staged) await fsp.rename(staged, original); staged = null; throw err; }
      if (staged) await fsp.rm(staged, { force: true });
      return res.json({ deleted: id });
    } finally { req.releaseWork?.(); }
  }
}

module.exports = { ImageController };
