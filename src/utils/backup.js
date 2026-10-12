const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { crc32 } = require('node:zlib');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const yazl = require('yazl');
const yauzl = require('yauzl');
const { Config } = require('../config');
const { Database } = require('../db/sqlite');
const { error, ByteLimit, imagePath, safeName } = require('./resources');

async function temporary() { return fsp.mkdtemp(path.join(Config.Get().m_TempDir, 'backup-')); }

// 分页生成清单，图片内容通过 ZIP 流读取，不整体放入内存。
async function manifest(destination) {
  const handle = await fsp.open(destination, 'wx');
  let bytes = 0;
  const write = async value => {
    bytes += Buffer.byteLength(value);
    if (bytes > Config.Get().m_MaxManifestBytes) throw error(413, '备份清单超过限制');
    await handle.write(value);
  };
  try {
    await Database.Get().ReadSnapshot(async db => {
      await write('{"version":2');
      for (const [name, table] of [['users', 'users'], ['images', 'images'], ['tags', 'tags'], ['imageTags', 'image_tags']]) {
        await write(`,"${name}":[`);
        let after = 0;
        let first = true;
        let count = 0;
        while (true) {
          const rows = await db.All(`SELECT rowid AS cursor, * FROM ${table} WHERE rowid > ? ORDER BY rowid LIMIT 256`, [after]);
          if (!rows.length) break;
          for (const row of rows) {
            after = row.cursor;
            delete row.cursor;
            if (table === 'images') { await imagePath(row); row.storage_path = row.filename; }
            if (++count > Config.Get().m_MaxBackupEntries) throw error(413, '备份记录数量超过限制');
            await write(`${first ? '' : ','}${JSON.stringify(row)}`);
            first = false;
          }
        }
        await write(']');
      }
      await write('}');
    });
  } finally { await handle.close(); }
}

async function exportBackup() {
  const cfg = Config.Get();
  const tempDir = await temporary();
  const output = path.join(cfg.m_BackupsDir, `backup-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.zip`);
  const partial = `${output}.partial`;
  let completed = false;
  try {
    const data = path.join(tempDir, 'data.json');
    await manifest(data);
    const zip = new yazl.ZipFile();
    zip.on('error', err => zip.outputStream.destroy(err));
    const writing = pipeline(zip.outputStream, new ByteLimit(cfg.m_MaxBackupBytes), fs.createWriteStream(partial, { flags: 'wx' }));
    // 立即观察拒绝，添加大量条目期间也不会出现未处理的异常。
    writing.catch(() => {});
    try {
      zip.addFile(data, 'data.json');
      let unpackedBytes = (await fsp.stat(data)).size;
      const names = new Set();
      let after = 0;
      while (true) {
        const rows = await Database.Get().All('SELECT * FROM images WHERE id > ? ORDER BY id LIMIT 256', [after]);
        if (!rows.length) break;
        for (const img of rows) {
          const file = await imagePath(img);
          const name = safeName(img.filename);
          if (names.has(name.toLowerCase())) throw error(409, '图片文件名重复，无法生成可靠备份');
          names.add(name.toLowerCase());
          unpackedBytes += (await fsp.stat(file)).size;
          if (unpackedBytes > cfg.m_MaxBackupBytes) throw error(413, '备份解压大小超过限制');
          zip.addFile(file, `images/${name}`, { compress: false });
          after = img.id;
        }
      }
      zip.end();
      await writing;
    } catch (err) { zip.outputStream.destroy(err); await writing.catch(() => {}); throw err; }
    await fsp.rename(partial, output);
    completed = true;
    const existing = (await fsp.readdir(cfg.m_BackupsDir)).filter(name => /^backup-[0-9T-]+Z-[0-9a-f-]+\.zip$/.test(name)).sort().reverse();
    for (const name of existing.slice(cfg.m_BackupKeep)) await fsp.rm(path.join(cfg.m_BackupsDir, name), { force: true });
    return output;
  } finally {
    await cleanup(tempDir);
    if (!completed) await fsp.rm(partial, { force: true });
  }
}

async function cleanup(directory) {
  // 只删除本次任务创建目录中的普通文件，避免递归删除未知路径。
  for (const item of await fsp.readdir(directory, { withFileTypes: true })) {
    if (!item.isFile()) throw new Error('临时目录存在非预期内容');
    await fsp.unlink(path.join(directory, item.name));
  }
  await fsp.rmdir(directory);
}

async function extract(source, directory) {
  const cfg = Config.Get();
  let zip;
  try { zip = await yauzl.openPromise(source, { lazyEntries: true, strictFileNames: true }); }
  catch { throw error(400, '备份 ZIP 无效'); }
  const seen = new Set();
  let total = 0;
  let count = 0;
  try {
    if (zip.entryCount > cfg.m_MaxBackupEntries + 2) throw error(413, '备份条目过多');
    for await (const entry of zip.eachEntry()) {
      const name = entry.fileName;
      if (++count > cfg.m_MaxBackupEntries + 2 || seen.has(name.toLowerCase())) throw error(400, '备份条目重复或过多');
      seen.add(name.toLowerCase());
      if (name === 'images/' && entry.uncompressedSize === 0) continue;
      const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
      if (mode && mode !== 0x8000 || entry.isEncrypted()) throw error(400, '不支持符号链接或加密备份');
      const isManifest = name === 'data.json';
      if (!isManifest && !/^images\/[^/]+$/.test(name)) throw error(400, '备份包含非预期路径');
      const base = isManifest ? 'data.json' : safeName(name.slice(7));
      if (!isManifest && base.toLowerCase() === 'data.json') throw error(400, '备份文件名冲突');
      const limit = isManifest ? cfg.m_MaxManifestBytes : cfg.m_MaxFileBytes;
      total += entry.uncompressedSize;
      if (entry.uncompressedSize > limit || total > cfg.m_MaxBackupBytes) throw error(413, '解压大小超过限制');
      let checksum = 0;
      const verify = new Transform({
        transform(chunk, encoding, callback) { checksum = crc32(chunk, checksum); callback(null, chunk); },
        flush(callback) { callback(checksum === entry.crc32 ? null : error(400, '备份校验失败')); }
      });
      const stream = await zip.openReadStreamPromise(entry);
      await pipeline(stream, new ByteLimit(limit), verify, fs.createWriteStream(path.join(directory, base), { flags: 'wx' }));
    }
  } catch (err) { if (err.status) throw err; throw error(400, '备份 ZIP 损坏'); }
  finally { zip.close(); }
  if (!seen.has('data.json')) throw error(400, '备份缺少 data.json');
  return seen;
}

function validate(data) {
  if (!data || typeof data !== 'object' || (data.version !== undefined && data.version !== 2)) throw error(400, '备份版本无效');
  const sets = {};
  for (const table of ['users', 'images', 'tags', 'imageTags']) {
    if (!Array.isArray(data[table]) || data[table].length > Config.Get().m_MaxBackupEntries) throw error(400, '备份清单无效');
    sets[table] = new Set();
    for (const item of data[table]) {
      if (!item || typeof item !== 'object') throw error(400, '备份记录无效');
      if (table !== 'imageTags') {
        if (!Number.isSafeInteger(item.id) || item.id < 1 || sets[table].has(item.id)) throw error(400, '备份编号无效或重复');
        sets[table].add(item.id);
      }
    }
  }
  const usernames = new Set();
  for (const user of data.users) {
    if (typeof user.username !== 'string' || !user.username.trim() || user.username.length > 64 || usernames.has(user.username) || !/^\$2[aby]\$(0[4-9]|1[0-4])\$[./A-Za-z0-9]{53}$/.test(user.password_hash) || !['user', 'admin'].includes(user.role) || !['active', 'disabled'].includes(user.status)) throw error(400, '备份用户记录无效');
    usernames.add(user.username);
  }
  const filenames = new Set();
  const accessTokens = new Set();
  for (const image of data.images) {
    safeName(image.filename);
    if (image.source_hash != null && !/^[0-9a-f]{64}$/.test(image.source_hash)) throw error(400, '备份图片原始摘要无效');
    if (filenames.has(image.filename.toLowerCase()) || (image.owner_id != null && !sets.users.has(image.owner_id))) throw error(400, '备份图片记录无效');
    filenames.add(image.filename.toLowerCase());
    if (image.access_token != null) {
      if (!/^[0-9a-f]{32}$/.test(image.access_token) || accessTokens.has(image.access_token)) throw error(400, '备份图片访问令牌无效或重复');
      accessTokens.add(image.access_token);
    }
  }
  const tagNames = new Set();
  for (const tag of data.tags) {
    if (typeof tag.name !== 'string' || !tag.name.trim() || tag.name.length > 100 || tagNames.has(tag.name)) throw error(400, '备份标签记录无效');
    tagNames.add(tag.name);
  }
  for (const relation of data.imageTags) if (!sets.images.has(relation.image_id) || !sets.tags.has(relation.tag_id)) throw error(400, '备份标签关联无效');
}

async function hash(file) {
  const digest = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

async function importBackup(source) {
  const cfg = Config.Get();
  const directory = await temporary();
  const installed = [];
  try {
    await extract(source, directory);
    let data;
    try { data = JSON.parse(await fsp.readFile(path.join(directory, 'data.json'), 'utf8')); }
    catch { throw error(400, '备份 JSON 无效'); }
    validate(data);
    const referenced = new Set(['data.json', ...data.images.map(image => image.filename.toLowerCase())]);
    const extracted = await fsp.readdir(directory);
    if (extracted.some(name => !referenced.has(name.toLowerCase()))) throw error(400, '备份包含未引用的图片');
    const { ImageController } = require('../controllers/imageController');
    const metadata = new Map();
    for (const image of data.images) {
      const staged = path.join(directory, image.filename);
      try { metadata.set(image.id, await ImageController.Inspect(staged)); }
      catch { throw error(400, '备份图片缺失、损坏或超过限制'); }
    }
    const counts = { users: 0, images: 0, tags: 0 };
    await Database.Get().Transaction(async db => {
      const users = new Map();
      const tags = new Map();
      const images = new Map();
      for (const user of data.users) {
        let existing = await db.Get('SELECT id FROM users WHERE username=?', [user.username]);
        if (!existing) {
          const result = await db.Run('INSERT INTO users(username,password_hash,role,status,created_at) VALUES(?,?,?,?,?)', [user.username, user.password_hash, user.role, user.status, String(user.created_at || new Date().toISOString())]);
          existing = { id: result.lastID }; counts.users++;
        }
        users.set(user.id, existing.id);
      }
      for (const tag of data.tags) {
        const result = await db.Run('INSERT OR IGNORE INTO tags(name) VALUES(?)', [tag.name]);
        counts.tags += result.changes;
        tags.set(tag.id, (await db.Get('SELECT id FROM tags WHERE name=?', [tag.name])).id);
      }
      for (const image of data.images) {
        const staged = path.join(directory, image.filename);
        const existing = await db.Get('SELECT * FROM images WHERE filename=?', [image.filename]);
        if (existing) {
          try {
            const contentHash = await hash(staged);
            if (await hash(await imagePath(existing)) === contentHash) {
              if (image.access_token && image.access_token !== existing.access_token) throw error(409, '同名图片访问令牌不同，无法保留原链接');
              await db.Run('UPDATE images SET content_hash=?,source_hash=COALESCE(source_hash,?) WHERE id=?', [contentHash, image.source_hash || null, existing.id]);
              images.set(image.id, existing.id); continue;
            }
          } catch (err) { if (err.code !== 'ENOENT') throw err; }
        }
        let filename = existing ? `${randomUUID()}${path.extname(image.filename)}` : image.filename;
        let target = path.join(cfg.m_UploadsDir, filename);
        // 不覆盖未入库文件；用独占复制确保失败回滚只清理本次新增文件。
        try { await fsp.copyFile(staged, target, fs.constants.COPYFILE_EXCL); }
        catch (err) {
          if (err.code !== 'EEXIST') throw err;
          filename = `${randomUUID()}${path.extname(image.filename)}`;
          target = path.join(cfg.m_UploadsDir, filename);
          await fsp.copyFile(staged, target, fs.constants.COPYFILE_EXCL);
        }
        installed.push(target);
        const size = (await fsp.stat(target)).size;
        let accessToken = image.access_token;
        if (accessToken != null && !/^[0-9a-f]{32}$/.test(accessToken)) throw error(400, '备份访问令牌无效');
        if (accessToken && await db.Get('SELECT id FROM images WHERE access_token=?', [accessToken])) throw error(409, '备份图片访问令牌与现有图片冲突');
        accessToken ||= randomUUID().replaceAll('-', '');
        // 存储摘要从实际恢复文件计算，原始摘要随备份保留以兼容压缩前的重复上传。
        const contentHash = await hash(staged);
        const result = await db.Run(`INSERT INTO images(owner_id,filename,original_name,mime_type,size,storage_path,remote_url,access_token,source_hash,content_hash,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`, [users.get(image.owner_id) || null, filename, String(image.original_name || filename), `image/${metadata.get(image.id).format}`, size, filename, typeof image.remote_url === 'string' ? image.remote_url : null, accessToken, image.source_hash || null, contentHash, String(image.created_at || new Date().toISOString())]);
        images.set(image.id, result.lastID); counts.images++;
      }
      for (const relation of data.imageTags) await db.Run('INSERT OR IGNORE INTO image_tags(image_id,tag_id) VALUES(?,?)', [images.get(relation.image_id), tags.get(relation.tag_id)]);
    });
    return counts;
  } catch (err) {
    for (const file of installed) await fsp.rm(file, { force: true });
    throw err;
  } finally { await cleanup(directory); }
}

module.exports = { exportBackup, importBackup, validate };
