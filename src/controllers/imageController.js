// ================================================================
// Copyright (c) 2025 AZUMI 图片控制器
// 
// 文件名称: ImageController.js
// 作者: AzumiYumeichi
// 创建日期: 2025-11-06
// 版本: 1.8
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
// 2025-11-07 - 标签自动 UTF-8 规范化与乱码兼容修复（Latin-1 → UTF-8 回退）
// 2025-11-07 - 上传图片超过 256KB 时自动压缩至不超过 256KB（保留原格式）
// ================================================================
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
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
   * 方法：尝试修复常见的 UTF-8 乱码（Latin-1 → UTF-8 回退）
   * 说明：当客户端未显式声明 charset 或控制台非 UTF-8（如 Windows 未 chcp 65001）
   *      导致中文出现 "Ã"、"Â" 等伪字节时，尝试将字符串视作 Latin-1 字节序列并按 UTF-8 解码。
   * 用法：const fixed = ImageController.FixUtf8Mojibake(tag);
   */
  static FixUtf8Mojibake(text) {
    try {
      const s = String(text || '');
      const trial = Buffer.from(s, 'latin1').toString('utf8');
      const baseScore = ImageController.ScoreString(s);
      const trialScore = ImageController.ScoreString(trial);
      return trialScore > baseScore ? trial : s;
    } catch (_) {
      return String(text || '');
    }
  }

  /** 方法：对字符串进行简单评分，用于判断修复后是否更优（更多 CJK，较少伪字节） */
  static ScoreString(text) {
    const s = String(text || '');
    const cjk = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
    const mojibake = (s.match(/[ÃÂæçè]/g) || []).length;
    return (cjk * 2) - mojibake;
  }

  /**
   * 方法：规范化标签数组为 UTF-8（去除空白、兼容全角逗号、NFC 归一化、去重）
   * 说明：支持传入字符串或字符串数组；若某元素含多个标签（逗号/全角逗号分隔），会拆分。
   * 用法：const tags = ImageController.NormalizeTagsUtf8(rawTags);
   */
  static NormalizeTagsUtf8(rawTags) {
    const list = [];
    const parts = Array.isArray(rawTags) ? rawTags : (rawTags != null ? [rawTags] : []);
    for (const t of parts) {
      const s = String(t || '');
      const segs = s.split(/[\,\uFF0C]/).map((x) => x.trim()).filter(Boolean);
      for (let seg of segs) {
        // 乱码回退修复 + Unicode 规范化
        seg = ImageController.FixUtf8Mojibake(seg).normalize('NFC');
        if (seg.length > 0) list.push(seg);
      }
    }
    // 去重（保持原始大小写与顺序，首见优先）
    const seen = new Set();
    const dedup = [];
    for (const item of list) {
      if (!seen.has(item)) { seen.add(item); dedup.push(item); }
    }
    return dedup;
  }

  /**
   * 方法：确保图片大小不超过目标字节（默认 256KB），必要时进行压缩与缩放，且保持原格式不变
   * 说明：
   * - 根据原始格式选择合适的压缩策略（JPEG/PNG/WebP/TIFF/GIF），不改变扩展名与 MIME。
   * - 逐步降低质量（若格式支持），若仍超限则按比例缩小分辨率，最低宽度 64 像素。
   * - 对 PNG 使用调色板与较高压缩级别；GIF 不保证保留动画质量，仅尝试缩放以减小体积。
   * - 对不支持输出的格式（如 BMP），保持原文件不变。
   * 返回：{ changed, newSize }
   */
  static async EnsureMaxSize(filePath, maxBytes = 256 * 1024) {
    try {
      const origStat = fs.statSync(filePath);
      if (origStat.size <= maxBytes) {
        return { changed: false, newSize: origStat.size };
      }

      // 读取元数据与扩展名，准备保持原格式压缩
      const input = sharp(filePath, { animated: true });
      const meta = await input.metadata();
      let width = meta.width || null;
      let bestBuf = null;
      let bestSize = Number.MAX_SAFE_INTEGER;

      const ext = path.extname(filePath).toLowerCase();
      let format = (meta.format || '').toLowerCase();
      const map = { '.jpg': 'jpeg', '.jpeg': 'jpeg', '.png': 'png', '.webp': 'webp', '.gif': 'gif', '.tif': 'tiff', '.tiff': 'tiff', '.bmp': 'bmp' };
      if (!format) format = map[ext] || 'jpeg';

      // 不支持原格式输出（如 bmp）时，保持原文件不变
      if (format === 'bmp') {
        return { changed: false, newSize: origStat.size };
      }

      // 宽度递减序列（若未知宽度则仅一次尝试）
      const widthSteps = [];
      if (width && Number.isFinite(width)) {
        let w = width;
        while (w > 64) { widthSteps.push(Math.round(w)); w = Math.round(w * 0.85); }
        widthSteps.push(64);
      } else {
        widthSteps.push(null);
      }

      // 质量序列（仅用于支持质量的格式）
      const qualitySeq = [85, 75, 65, 55, 45, 35, 25, 20];
      // PNG 压缩级别序列
      const pngLevels = [6, 7, 8, 9];

      for (const w of widthSteps) {
        if (format === 'png') {
          for (const cl of pngLevels) {
            const pipe = sharp(filePath, { animated: true });
            if (w) pipe.resize({ width: Math.max(64, w), withoutEnlargement: true });
            const buf = await pipe.png({ compressionLevel: cl, palette: true }).toBuffer();
            if (buf.length < bestSize) { bestBuf = buf; bestSize = buf.length; }
            if (buf.length <= maxBytes) break;
          }
        } else if (format === 'jpeg') {
          for (const q of qualitySeq) {
            const pipe = sharp(filePath, { animated: true });
            if (w) pipe.resize({ width: Math.max(64, w), withoutEnlargement: true });
            const buf = await pipe.jpeg({ quality: q, mozjpeg: true }).toBuffer();
            if (buf.length < bestSize) { bestBuf = buf; bestSize = buf.length; }
            if (buf.length <= maxBytes) break;
          }
        } else if (format === 'webp') {
          for (const q of qualitySeq) {
            const pipe = sharp(filePath, { animated: true });
            if (w) pipe.resize({ width: Math.max(64, w), withoutEnlargement: true });
            const buf = await pipe.webp({ quality: q, effort: 6 }).toBuffer();
            if (buf.length < bestSize) { bestBuf = buf; bestSize = buf.length; }
            if (buf.length <= maxBytes) break;
          }
        } else if (format === 'tiff') {
          for (const q of qualitySeq) {
            const pipe = sharp(filePath, { animated: true });
            if (w) pipe.resize({ width: Math.max(64, w), withoutEnlargement: true });
            const buf = await pipe.tiff({ compression: 'jpeg', quality: q }).toBuffer();
            if (buf.length < bestSize) { bestBuf = buf; bestSize = buf.length; }
            if (buf.length <= maxBytes) break;
          }
        } else if (format === 'gif') {
          // GIF 无质量参数，尝试缩放减小体积；动画 GIF 不保证压缩效果
          const pipe = sharp(filePath, { animated: true });
          if (w) pipe.resize({ width: Math.max(64, w), withoutEnlargement: true });
          const buf = await pipe.gif().toBuffer();
          if (buf.length < bestSize) { bestBuf = buf; bestSize = buf.length; }
          // 若仍超限，继续下一宽度步
        } else {
          // 其它格式：不改变格式要求下无法进一步压缩
        }
        if (bestBuf && bestBuf.length <= maxBytes) break;
      }

      if (!bestBuf) {
        return { changed: false, newSize: origStat.size };
      }

      // 原地覆盖写入，保持路径与扩展名不变
      fs.writeFileSync(filePath, bestBuf);
      return { changed: true, newSize: bestBuf.length };
    } catch (_) {
      // 压缩失败，保留原始文件
      try {
        const st = fs.statSync(filePath);
        return { changed: false, newSize: st.size };
      } catch (_) {
        return { changed: false, newSize: 0 };
      }
    }
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
    // 统一将标签规范化为 UTF-8，支持逗号/全角逗号分隔与数组输入
    const tagsRaw = Array.isArray(req.body.tags) ? req.body.tags : (req.body.tags != null ? [req.body.tags] : []);
    const tags = ImageController.NormalizeTagsUtf8(tagsRaw);
    if (!files.length) return res.status(400).json({ error: '未选择文件' });
    const tagIds = await TagRepository.EnsureTags(tags);
    const created = [];
    for (const f of files) {
      // 若文件超过 256KB，自动压缩至不超过 256KB（保留原格式，仅覆盖文件）
      const result = await ImageController.EnsureMaxSize(f.path, 256 * 1024);
      if (result.changed) {
        // 保留原路径、文件名与 MIME，仅更新大小
        f.size = result.newSize;
      }
      const { id, accessToken } = await ImageRepository.CreateImage({
        ownerId: req.user?.id,
        filename: f.filename,
        originalName: f.originalname,
        mimeType: f.mimetype,
        size: f.size,
        storagePath: f.path,
        remoteUrl: null,
      });
      await ImageRepository.AttachTags(id, tagIds);
      created.push({ id, url: `/api/images/${accessToken}` });
    }
    return res.json({ images: created });
  }

  // ZIP上传功能已移除，若需批量上传请使用多文件上传或URL批量上传接口

  /** 方法：通过URL批量上传图片，并为其打标签 */
  static async UploadByUrl(req, res) {
    const { urls = [], tags = [] } = req.body || {};
    const tagsNorm = ImageController.NormalizeTagsUtf8(Array.isArray(tags) ? tags : (tags != null ? [tags] : []));
    if (!Array.isArray(urls) || urls.length === 0) return res.status(400).json({ error: '未提供URL列表' });
    const tagIds = await TagRepository.EnsureTags(tagsNorm);
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

        // 压缩至不超过 256KB（保留原格式，仅覆盖文件），并更新 size
        const result = await ImageController.EnsureMaxSize(outPath, 256 * 1024);
        let finalPath = outPath;
        let finalName = newName;
        let finalMime = mainType || rawType;
        let finalSize = fs.statSync(outPath).size;
        if (result.changed) {
          // 保留路径、文件名与 MIME，仅更新大小
          finalSize = result.newSize;
        }
        const { id, accessToken } = await ImageRepository.CreateImage({
          ownerId: req.user?.id,
          filename: finalName,
          originalName,
          mimeType: finalMime,
          size: finalSize,
          storagePath: finalPath,
          remoteUrl: url,
        });
        await ImageRepository.AttachTags(id, tagIds);
        created.push({ id, url: `/api/images/${accessToken}` });
      } catch (err) {
        // 单个URL失败不影响整体，记录错误
        created.push({ error: `下载失败: ${url}` });
      }
    }
    return res.json({ images: created });
  }

  /**
   * 方法：获取图片列表（JSON格式）
   */
  static async ListImages(req, res) {
    const tags = (req.query.tags ? String(req.query.tags).split(',').filter(Boolean) : []);
    const rows = await ImageRepository.ListImagesByTags(tags);
    const images = (rows || [])
      .filter(r => {
        const filePath = r.storage_path && path.resolve(r.storage_path);
        return filePath && fs.existsSync(filePath);
      })
      .map(r => ({
        id: r.id,
        filename: r.filename,
        tags: r.tags || '',
        url: `/api/images/${r.access_token}`,
        created_at: r.created_at
      }));
    return res.json({ images });
  }

  /** 方法：通过访问令牌获取图片 */
  static async GetImageByToken(req, res) {
    const token = req.params.token;
    const img = await ImageRepository.GetImageByToken(token);
    if (!img) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.status(404).send('图片不存在');
    }
    return await ImageController.SendImageFile(res, img);
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