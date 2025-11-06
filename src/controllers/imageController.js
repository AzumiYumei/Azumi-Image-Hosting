// ================================================================
// Copyright (c) 2025 AZUMI 图片控制器
// 
// 文件名称: ImageController.js
// 作者: AzumiYumeichi
// 创建日期: 2025-11-06
// 版本: 1.2
// 
// 描述: 提供图片上传（本地/URL）、删除、检索（标签与随机）、以及原图获取的API。
// 
// 修改历史:
// 2025-11-06 - 初始版本
// 2025-11-06 - 删除ZIP压缩包上传接口（UploadZipFolder），保留图片获取行为不变
// 2025-11-06 - 移除 GetImages 中的 count 参数，始终返回单张图片
// ================================================================
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const { TagRepository } = require('../repositories/tagRepository');
const { ImageRepository } = require('../repositories/imageRepository');
const { Config } = require('../config');

class ImageController {
  /**
   * 方法：根据数据库记录与文件扩展名推断 MIME 类型
   * 说明：优先使用数据库中的 mime_type；若为空则根据扩展名进行简单映射。
   */
  static ResolveMimeType(img) {
    const ext = path.extname(img.original_name || img.filename || '')?.toLowerCase();
    if (img.mime_type && typeof img.mime_type === 'string' && img.mime_type.length > 0) {
      return img.mime_type;
    }
    switch (ext) {
      case '.png': return 'image/png';
      case '.jpg':
      case '.jpeg': return 'image/jpeg';
      case '.gif': return 'image/gif';
      case '.webp': return 'image/webp';
      case '.bmp': return 'image/bmp';
      default: return 'application/octet-stream';
    }
  }

  /**
   * 方法：直接以原始文件名与格式返回图片（二进制流）
   * 用法：ImageController.SendImageFile(res, img)
   */
  static SendImageFile(res, img) {
    const filePath = path.resolve(img.storage_path);
    const filename = img.original_name || img.filename || path.basename(filePath);
    if (!fs.existsSync(filePath)) {
      return res.status(404).send('文件缺失');
    }
    const stat = fs.statSync(filePath);
    const mime = ImageController.ResolveMimeType(img);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', stat.size);
    // inline 显示并保留原始文件名；浏览器会使用此文件名保存
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`);
    const stream = fs.createReadStream(filePath);
    stream.on('error', () => res.status(500).end());
    return stream.pipe(res);
  }
  /** 方法：上传本地文件（支持多文件）并打标签 */
  static async UploadLocal(req, res) {
    const files = req.files || [];
    const tags = Array.isArray(req.body.tags) ? req.body.tags : (req.body.tags ? String(req.body.tags).split(',') : []);
    if (!files.length) return res.status(400).json({ error: '未选择文件' });
    const tagIds = await TagRepository.EnsureTags(tags);
    const created = [];
    for (const f of files) {
      const id = await ImageRepository.CreateImage({
        ownerId: req.user?.id,
        filename: f.filename,
        originalName: f.originalname,
        mimeType: f.mimetype,
        size: f.size,
        storagePath: f.path,
        remoteUrl: null,
      });
      await ImageRepository.AttachTags(id, tagIds);
      created.push({ id });
    }
    return res.json({ created });
  }

  // ZIP上传功能已移除，若需批量上传请使用多文件上传或URL批量上传接口

  /** 方法：通过URL批量上传图片，并为其打标签 */
  static async UploadByUrl(req, res) {
    const { urls = [], tags = [] } = req.body || {};
    if (!Array.isArray(urls) || urls.length === 0) return res.status(400).json({ error: '未提供URL列表' });
    const tagIds = await TagRepository.EnsureTags(tags);
    const uploadsDir = Config.Get().m_UploadsDir;
    const created = [];
    for (const url of urls) {
      try {
        const resp = await axios.get(url, { responseType: 'arraybuffer' });
        const contentType = String(resp.headers['content-type'] || '');
        const ext = contentType.includes('image/') ? `.${contentType.split('/')[1]}` : '.img';
        const newName = `${uuidv4()}${ext}`;
        const outPath = path.join(uploadsDir, newName);
        fs.writeFileSync(outPath, Buffer.from(resp.data));
        const id = await ImageRepository.CreateImage({
          ownerId: req.user?.id,
          filename: newName,
          originalName: path.basename(url),
          mimeType: contentType,
          size: fs.statSync(outPath).size,
          storagePath: outPath,
          remoteUrl: url,
        });
        await ImageRepository.AttachTags(id, tagIds);
        created.push({ id });
      } catch (err) {
        // 单个URL失败不影响整体，记录错误
        created.push({ error: `下载失败: ${url}` });
      }
    }
    return res.json({ created });
  }

  /**
   * 方法：按标签检索或随机获取图片（始终返回单张）
   * 说明：
   * - 当 random=true 时，从匹配集合中随机选择 1 张并直接返回二进制（保留原名与格式）
   * - 当 random=false 时，按时间倒序选择最新的一张并返回
   * - 不支持多张获取，忽略任何 count 参数
   */
  static async GetImages(req, res) {
    const tags = (req.query.tags ? String(req.query.tags).split(',').filter(Boolean) : []);
    const random = String(req.query.random || 'false').toLowerCase() === 'true';
    if (random) {
      const rows = await ImageRepository.RandomImages(tags, 1);
      if (!rows || rows.length === 0) return res.status(404).send('未找到匹配图片');
      return ImageController.SendImageFile(res, rows[0]);
    } else {
      const rows = await ImageRepository.ListImagesByTags(tags);
      if (!rows || rows.length === 0) return res.status(404).send('未找到匹配图片');
      // 按时间倒序（实现中为 id DESC），取第一张
      return ImageController.SendImageFile(res, rows[0]);
    }
  }

  /** 方法：获取任意图片原始内容 */
  static async GetRaw(req, res) {
    const id = parseInt(req.params.id, 10);
    const img = await ImageRepository.GetImageById(id);
    if (!img) return res.status(404).send('图片不存在');
    return ImageController.SendImageFile(res, img);
  }

  /** 方法：删除图片（普通用户仅可删除自己图片，管理员可删除任意图片） */
  static async DeleteImage(req, res) {
    const id = parseInt(req.params.id, 10);
    const img = await ImageRepository.GetImageById(id);
    if (!img) return res.status(404).json({ error: '图片不存在' });
    const isOwner = req.user && req.user.id === img.owner_id;
    const isAdmin = req.user && req.user.role === 'admin';
    if (!isOwner && !isAdmin) return res.status(403).json({ error: '无权删除该图片' });
    try {
      if (fs.existsSync(img.storage_path)) fs.unlinkSync(img.storage_path);
    } catch (_) {}
    await ImageRepository.DeleteImage(id);
    return res.json({ deleted: id });
  }
}

module.exports = { ImageController };