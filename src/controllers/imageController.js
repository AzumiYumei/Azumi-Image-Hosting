// ================================================================
// Copyright (c) 2025 AZUMI 图片控制器
// 
// 文件名称: ImageController.js
// 作者: AzumiYumeichi
// 创建日期: 2025-11-06
// 版本: 1.5
// 
// 描述: 提供图片上传（本地/URL）、删除、检索（标签与随机）、以及原图获取的API。
// 
// 修改历史:
// 2025-11-06 - 初始版本
// 2025-11-06 - 删除ZIP压缩包上传接口（UploadZipFolder），保留图片获取行为不变
// 2025-11-06 - 移除 GetImages 中的 count 参数，始终返回单张图片
// 2025-11-06 - 修正 URL 上传的扩展名推断与返回文件名构造，避免后缀丢失
// 2025-11-06 - 随机与标签检索过滤失联文件；缺失文件 404 返回 text/plain
// 2025-11-06 - 缺失文件检测时自动删除图片记录；随机获取循环重试直到合法图片或无图
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
    // 优先使用数据库中的 mime_type（去除参数，如 charset）
    if (img.mime_type && typeof img.mime_type === 'string' && img.mime_type.length > 0) {
      const main = String(img.mime_type).split(';')[0].trim();
      if (main) return main;
    }
    // 退化：基于文件名（去除查询串/片段）推断扩展名
    const name = ImageController.SanitizeName(img.original_name || img.filename || '');
    const ext = path.extname(name)?.toLowerCase();
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

  /** 方法：清理名称中的查询串与片段，移除不安全字符 */
  static SanitizeName(name) {
    const base = String(name || '');
    // 去除查询串与片段（? 和 # 之后的内容）
    const cut = base.split('?')[0].split('#')[0];
    // 简易清理不安全字符（保留常见字符）
    return cut.replace(/[^A-Za-z0-9._\-\u4e00-\u9fa5]/g, '_');
  }

  /** 方法：根据记录构造安全可下载的文件名，保证包含扩展名 */
  static BuildDownloadName(img) {
    const raw = ImageController.SanitizeName(img.original_name || img.filename || path.basename(String(img.storage_path || '')) || 'image');
    let name = raw;
    const hasExt = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(path.extname(raw).toLowerCase());
    if (!hasExt) {
      const mime = ImageController.ResolveMimeType(img);
      const extMap = {
        'image/png': '.png',
        'image/jpeg': '.jpg',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'image/bmp': '.bmp'
      };
      const ext = extMap[mime] || '';
      if (ext && !raw.endsWith(ext)) {
        name = raw + ext;
      }
    }
    // 生成 ASCII 回退名（移除非 ASCII）
    const ascii = name.replace(/[^\x20-\x7E]/g, '_');
    // RFC 5987 编码用于 filename*
    const utf8 = encodeURIComponent(name).replace(/['()]/g, escape).replace(/\*/g, '%2A');
    return { ascii, utf8 };
  }

  /**
   * 方法：直接以原始文件名与格式返回图片（二进制流）
   * 用法：ImageController.SendImageFile(res, img)
   */
  static async SendImageFile(res, img) {
    const filePath = path.resolve(img.storage_path);
    const { ascii, utf8 } = ImageController.BuildDownloadName(img);
    if (!fs.existsSync(filePath)) {
      // 文件不存在时，明确返回 404 与 text/plain，避免客户端误保存为图片后缀
      // 同时执行数据清理：删除该图片记录（ON DELETE CASCADE 自动清理关联标签）
      try {
        if (img.id) await ImageRepository.DeleteImage(img.id);
      } catch (_) {}
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(404).send('文件缺失');
    }
    const stat = fs.statSync(filePath);
    const mime = ImageController.ResolveMimeType(img);
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Length', stat.size);
    // inline 显示并保留原始文件名，提供 ASCII 回退与 UTF-8 文件名
    res.setHeader('Content-Disposition', `inline; filename="${ascii}"; filename*=UTF-8''${utf8}`);
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
        const rawType = String(resp.headers['content-type'] || '');
        const mainType = rawType.split(';')[0].trim();
        const ext = mainType.startsWith('image/') ? `.${mainType.split('/')[1]}` : '.img';
        const newName = `${uuidv4()}${ext}`;
        const outPath = path.join(uploadsDir, newName);
        fs.writeFileSync(outPath, Buffer.from(resp.data));
        // 原始名称：尽量取 URL 路径的基名（去除查询与片段）
        let originalName = path.basename(String(url).split('?')[0].split('#')[0]);
        if (!path.extname(originalName)) originalName = newName; // 无扩展名则回退为新名
        const id = await ImageRepository.CreateImage({
          ownerId: req.user?.id,
          filename: newName,
          originalName,
          mimeType: mainType || rawType,
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
      // 随机场景：循环随机，若命中缺失文件则删除记录并继续随机，直到合法图片或无图
      // 为避免极端情况导致无限循环，限定最大尝试次数（上限与现有匹配数量相近）
      let tries = 0;
      const maxTries = 50;
      while (tries < maxTries) {
        const pick = await ImageRepository.RandomImages(tags, 1);
        const candidate = (pick && pick[0]) || null;
        if (!candidate) break; // 无匹配记录
        const filePath = candidate.storage_path && path.resolve(candidate.storage_path);
        if (filePath && fs.existsSync(filePath)) {
          return await ImageController.SendImageFile(res, candidate);
        }
        // 缺失：删除记录并继续随机
        try {
          if (candidate.id) await ImageRepository.DeleteImage(candidate.id);
        } catch (_) {}
        tries++;
      }
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(404).send('未找到匹配图片');
    } else {
      // 非随机场景：按时间倒序，遇到缺失文件则删除记录并继续找下一张
      const rows = await ImageRepository.ListImagesByTags(tags);
      for (const r of (rows || [])) {
        const filePath = r.storage_path && path.resolve(r.storage_path);
        if (filePath && fs.existsSync(filePath)) {
          return await ImageController.SendImageFile(res, r);
        }
        try {
          if (r.id) await ImageRepository.DeleteImage(r.id);
        } catch (_) {}
      }
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(404).send('未找到匹配图片');
    }
  }

  /** 方法：获取任意图片原始内容 */
  static async GetRaw(req, res) {
    const id = parseInt(req.params.id, 10);
    const img = await ImageRepository.GetImageById(id);
    if (!img) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(404).send('图片不存在');
    }
    return await ImageController.SendImageFile(res, img);
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