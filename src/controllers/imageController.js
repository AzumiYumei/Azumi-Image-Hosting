// ================================================================
// Copyright (c) 2025 AZUMI 图片控制器
// 
// 文件名称: ImageController.js
// 作者: AzumiYumeichi
// 创建日期: 2025-11-06
// 版本: 1.0
// 
// 描述: 提供图片上传（本地/URL/ZIP整文件夹）、删除、检索（标签与随机）、
//       以及原图获取的API。
// 
// 修改历史:
// 2025-11-06 - 初始版本
// ================================================================
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const AdmZip = require('adm-zip');
const { v4: uuidv4 } = require('uuid');
const { TagRepository } = require('../repositories/tagRepository');
const { ImageRepository } = require('../repositories/imageRepository');
const { Config } = require('../config');

class ImageController {
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

  /** 方法：上传ZIP压缩包（整文件夹）并为其中所有图片打标签 */
  static async UploadZipFolder(req, res) {
    const zipFile = req.file; // 字段：folderZip
    const tags = Array.isArray(req.body.tags) ? req.body.tags : (req.body.tags ? String(req.body.tags).split(',') : []);
    if (!zipFile) return res.status(400).json({ error: '未提供ZIP文件' });
    const tagIds = await TagRepository.EnsureTags(tags);
    const zip = new AdmZip(zipFile.path);
    const entries = zip.getEntries();
    const uploadsDir = Config.Get().m_UploadsDir;
    const created = [];
    for (const e of entries) {
      if (e.isDirectory) continue;
      const name = e.entryName;
      const ext = path.extname(name).toLowerCase();
      // 简单图片类型判断
      if (!['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)) continue;
      const newName = `${uuidv4()}${ext}`;
      const outPath = path.join(uploadsDir, newName);
      fs.writeFileSync(outPath, e.getData());
      const id = await ImageRepository.CreateImage({
        ownerId: req.user?.id,
        filename: newName,
        originalName: path.basename(name),
        mimeType: null,
        size: fs.statSync(outPath).size,
        storagePath: outPath,
        remoteUrl: null,
      });
      await ImageRepository.AttachTags(id, tagIds);
      created.push({ id });
    }
    return res.json({ created });
  }

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

  /** 方法：按标签检索或随机获取图片 */
  static async GetImages(req, res) {
    const tags = (req.query.tags ? String(req.query.tags).split(',').filter(Boolean) : []);
    const random = String(req.query.random || 'false').toLowerCase() === 'true';
    const count = Math.max(1, Math.min(100, parseInt(req.query.count || '1', 10)));
    if (random) {
      const rows = await ImageRepository.RandomImages(tags, count);
      return res.json({ images: rows });
    } else {
      const rows = await ImageRepository.ListImagesByTags(tags);
      return res.json({ images: rows });
    }
  }

  /** 方法：获取任意图片原始内容 */
  static async GetRaw(req, res) {
    const id = parseInt(req.params.id, 10);
    const img = await ImageRepository.GetImageById(id);
    if (!img) return res.status(404).send('图片不存在');
    if (!fs.existsSync(img.storage_path)) return res.status(404).send('文件缺失');
    return res.sendFile(path.resolve(img.storage_path));
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