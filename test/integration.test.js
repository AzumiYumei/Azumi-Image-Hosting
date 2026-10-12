const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const sharp = require('sharp');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const yazl = require('yazl');
const { pipeline } = require('node:stream/promises');
const { Config } = require('../src/config');
const { Database } = require('../src/db/sqlite');
const { CreateApp } = require('../src/app/server');
const { ImageController } = require('../src/controllers/imageController');
const { TagRepository } = require('../src/repositories/tagRepository');
const { ImageRepository } = require('../src/repositories/imageRepository');
const { WorkGate, ByteLimit } = require('../src/utils/resources');
const { publicAddress, download } = require('../src/utils/download');
const { importBackup, exportBackup } = require('../src/utils/backup');

let root, cfg, db, server, runtime, base, admin, user, png, passwordHash;
const token = (id, role = 'user') => jwt.sign({ id, role }, Config.Get().m_JwtSecret);
const auth = value => ({ Authorization: `Bearer ${value}` });

before(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'azumi-tests-'));
  process.env.DATA_DIR = path.join(root, 'data');
  process.env.BACKUPS_DIR = path.join(root, 'backups');
  process.env.JWT_SECRET = randomBytes(48).toString('hex');
  process.env.ACCESS_LOG = 'false';
  process.env.MAX_FILE_BYTES = '524288';
  process.env.MAX_BACKUP_BYTES = '4194304';
  process.env.COMPRESS_ATTEMPTS = '2';
  process.env.CORS_ORIGINS = 'https://allowed.example';
  cfg = Config.Get();
  runtime = await CreateApp(); db = Database.Get();
  server = runtime.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  png = await sharp({ create: { width: 32, height: 32, channels: 4, background: '#ff000080' } }).png().toBuffer();
  passwordHash = await bcrypt.hash('test-password', 10);
});

beforeEach(async () => {
  for (const table of ['image_tags', 'images', 'tags', 'users']) await db.Run(`DELETE FROM ${table}`);
  for (const dir of [cfg.m_UploadsDir, cfg.m_TempDir, cfg.m_BackupsDir]) {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) if (entry.isFile()) await fsp.unlink(path.join(dir, entry.name));
  }
  await db.Run("INSERT INTO users(id,username,password_hash,role,status,created_at) VALUES(1,'admin',?,'admin','active','2026-01-01')", [passwordHash]);
  await db.Run("INSERT INTO users(id,username,password_hash,role,status,created_at) VALUES(2,'user',?,'user','active','2026-01-01')", [passwordHash]);
  admin = token(1, 'admin'); user = token(2);
});

after(async () => {
  runtime?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  if (db) await db.Close();
  // 仅递归清理本测试在系统临时目录创建且已核对边界的目录。
  if (root && path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('azumi-tests-')) await fsp.rm(root, { recursive: true, force: true });
});

async function upload(content = png, name = 'a.png', tag = '中文标签', owner = user) {
  const form = new FormData();
  form.append('files', new Blob([content]), name);
  if (tag) form.append('tags', tag);
  return fetch(`${base}/api/images/upload`, { method: 'POST', headers: auth(owner), body: form });
}

async function zipFile(data, images = {}) {
  const output = path.join(root, `${randomBytes(6).toString('hex')}.zip`);
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify(data)), 'data.json');
  for (const [name, content] of Object.entries(images)) zip.addBuffer(content, `images/${name}`);
  const writing = pipeline(zip.outputStream, fs.createWriteStream(output));
  zip.end(); await writing; return output;
}

function fixture() {
  return {
    users: [{ id: 99, username: 'user', password_hash: passwordHash, role: 'user', status: 'active', created_at: '2026-01-01' }],
    images: [{ id: 1, owner_id: 99, filename: 'restored.png', original_name: '恢复.png', storage_path: '/old-host/images/restored.png', created_at: '2026-01-01' }],
    tags: [{ id: 1, name: '恢复标签' }], imageTags: [{ image_id: 1, tag_id: 1 }]
  };
}

test('上传、标签、原图缓存、范围请求和所有权控制', async () => {
  const response = await upload(); assert.equal(response.status, 200);
  const id = (await response.json()).created[0].id;
  const raw = await fetch(`${base}/api/images/${id}/raw`);
  assert.equal(raw.status, 200); assert.equal(raw.headers.get('content-type'), 'image/png');
  assert.ok(raw.headers.get('last-modified')); assert.equal(raw.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await raw.arrayBuffer()), png);
  const cached = await fetch(`${base}/api/images/${id}/raw`, { headers: { 'If-Modified-Since': raw.headers.get('last-modified'), 'Cache-Control': 'max-age=0' } });
  assert.equal(cached.status, 304);
  const ranged = await fetch(`${base}/api/images/${id}/raw`, { headers: { Range: 'bytes=0-9' } });
  assert.equal(ranged.status, 206); assert.equal((await ranged.arrayBuffer()).byteLength, 10);
  const tagged = await fetch(`${base}/api/images?tags=${encodeURIComponent('中文标签')}`);
  assert.equal(tagged.status, 200); await tagged.arrayBuffer();
  const random = await fetch(`${base}/api/images?random=true`); assert.equal(random.status, 200); await random.arrayBuffer();
  const row = await ImageRepository.GetImageById(id); assert.equal(row.storage_path, row.filename);
  await db.Run("INSERT INTO users(id,username,password_hash,role,status,created_at) VALUES(3,'other',?,'user','active','2026-01-01')", [passwordHash]);
  assert.equal((await fetch(`${base}/api/images/${id}`, { method: 'DELETE', headers: auth(token(3)) })).status, 403);
  const forbidden = await fetch(`${base}/api/images/${id}`, { method: 'DELETE', headers: auth(token(1)) });
  assert.equal(forbidden.status, 200);
  assert.equal(await ImageRepository.GetImageById(id), undefined);
  assert.deepEqual(await fsp.readdir(cfg.m_TempDir), []);
});

test('拒绝非图片、超限文件及批量非法文件，清理临时文件', async () => {
  assert.equal((await upload('not an image', 'fake.png')).status, 400);
  assert.equal((await upload(png.subarray(0, 40), 'truncated.png')).status, 400);
  assert.equal((await upload(Buffer.alloc(cfg.m_MaxFileBytes + 1), 'huge.png')).status, 413);
  const form = new FormData();
  form.append('files', new Blob([png]), 'valid.png'); form.append('files', new Blob(['bad']), 'bad.png');
  assert.equal((await fetch(`${base}/api/images/upload`, { method: 'POST', headers: auth(user), body: form })).status, 400);
  assert.equal((await db.Get('SELECT COUNT(*) AS c FROM images')).c, 0);
  assert.deepEqual(await fsp.readdir(cfg.m_TempDir), []);
  assert.deepEqual(await fsp.readdir(cfg.m_UploadsDir), []);
  assert.equal(runtime.gate.active, 0);
});

test('立即禁用旧令牌，角色使用当前数据库值，拒绝默认密钥伪造', async () => {
  const loggedIn = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'test-password' }) });
  const session = await loggedIn.json(); assert.equal(session.isAdmin, true); assert.equal(session.username, 'admin');
  const forgedRole = await fetch(`${base}/api/users`, { headers: auth(token(2, 'admin')) });
  assert.equal(forgedRole.status, 403);
  const patch = await fetch(`${base}/api/users/2/status`, { method: 'PATCH', headers: { ...auth(admin), 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'disabled' }) });
  assert.equal(patch.status, 200);
  assert.equal((await upload(png, 'a.png', '', user)).status, 403);
  const forged = jwt.sign({ id: 1, role: 'admin' }, 'azumi-image-host-secret');
  assert.equal((await fetch(`${base}/api/users`, { headers: auth(forged) })).status, 401);
});

test('缺失图片只返回错误，不删除记录，最新查询跳过缺失文件', async () => {
  const id = (await (await upload()).json()).created[0].id;
  await db.Run("INSERT INTO images(filename,storage_path,created_at) VALUES('missing.png','/missing','2026-01-01')");
  const missing = await db.Get("SELECT id FROM images WHERE filename='missing.png'");
  assert.equal((await fetch(`${base}/api/images/${missing.id}/raw`)).status, 404);
  assert.ok(await ImageRepository.GetImageById(missing.id));
  const latest = await fetch(`${base}/api/images`); assert.equal(latest.status, 200); await latest.arrayBuffer();
  assert.ok(await ImageRepository.GetImageById(id));
});

test('并发标签幂等，事务回滚与其他请求相互隔离', async () => {
  const results = await Promise.all(Array.from({ length: 8 }, () => TagRepository.EnsureTags(['并发标签'])));
  assert.ok(results.every(ids => ids[0] === results[0][0]));
  let started; const entered = new Promise(resolve => { started = resolve; });
  let release; const wait = new Promise(resolve => { release = resolve; });
  const transaction = db.Transaction(async () => { await db.Run("INSERT INTO tags(name) VALUES('rolled-back')"); started(); await wait; throw new Error('rollback'); });
  const rejected = assert.rejects(transaction, /rollback/);
  await entered;
  const outside = db.Run("INSERT INTO tags(name) VALUES('outside')");
  release(); await rejected; await outside;
  assert.equal(await db.Get("SELECT id FROM tags WHERE name='rolled-back'"), undefined);
  assert.ok(await db.Get("SELECT id FROM tags WHERE name='outside'"));
});

test('恢复旧备份映射编号和路径，可重复导入且保留现有权限', async () => {
  const backup = await zipFile(fixture(), { 'restored.png': png });
  const counts = await importBackup(backup); assert.equal(counts.images, 1);
  const row = await db.Get("SELECT * FROM images WHERE filename='restored.png'");
  assert.equal(row.owner_id, 2); assert.equal(row.storage_path, row.filename);
  assert.deepEqual(await fsp.readFile(path.join(cfg.m_UploadsDir, row.filename)), png);
  assert.equal((await importBackup(backup)).images, 0);
  const tagged = await ImageRepository.ListImagesByTags(['恢复标签']); assert.equal(tagged.length, 1);
  assert.deepEqual(await fsp.readdir(cfg.m_TempDir), []);
});

test('恢复失败回滚数据库和本次新增文件', async () => {
  const backup = await zipFile(fixture(), { 'restored.png': png });
  const original = db.Run.bind(db);
  db.Run = function (sql, params) { if (sql.startsWith('INSERT OR IGNORE INTO image_tags')) return Promise.reject(new Error('模拟导入写入失败')); return original(sql, params); };
  try { await assert.rejects(importBackup(backup), /模拟导入/); } finally { db.Run = original; }
  assert.equal((await db.Get('SELECT COUNT(*) AS c FROM images')).c, 0);
  assert.equal((await db.Get('SELECT COUNT(*) AS c FROM tags')).c, 0);
  assert.deepEqual(await fsp.readdir(cfg.m_UploadsDir), []);
  assert.deepEqual(await fsp.readdir(cfg.m_TempDir), []);
});

test('拒绝损坏备份、缺失图片、异常关联和危险文件名', async () => {
  const missing = await zipFile(fixture()); await assert.rejects(importBackup(missing), /缺失/);
  const data = fixture(); data.images[0].filename = '../escape.png';
  const traversal = await zipFile(data); await assert.rejects(importBackup(traversal), /文件名无效/);
  const invalid = fixture(); invalid.imageTags[0].tag_id = 999;
  const invalidZip = await zipFile(invalid, { 'restored.png': png }); await assert.rejects(importBackup(invalidZip), /关联无效/);
  const bad = path.join(root, 'bad.zip'); await fsp.writeFile(bad, 'invalid'); await assert.rejects(importBackup(bad), /ZIP 无效/);
  assert.deepEqual(await fsp.readdir(cfg.m_TempDir), []);
});

test('流式备份往返及保留数量，备份失败不遗留半成品', async () => {
  await upload();
  cfg.m_BackupKeep = 2;
  let latest;
  for (let i = 0; i < 3; i++) latest = await exportBackup();
  assert.equal((await fsp.readdir(cfg.m_BackupsDir)).length, 2);
  await db.Run('DELETE FROM images');
  for (const file of await fsp.readdir(cfg.m_UploadsDir)) await fsp.unlink(path.join(cfg.m_UploadsDir, file));
  assert.equal((await importBackup(latest)).images, 1);
  await db.Run("INSERT INTO images(filename,storage_path,created_at) VALUES('missing.png','missing','2026-01-01')");
  await assert.rejects(exportBackup(), { code: 'ENOENT' });
  assert.ok((await fsp.readdir(cfg.m_BackupsDir)).every(name => name.endsWith('.zip')));
});

test('备份接口上传后清理 ZIP，维护期间拒绝图片写入', async () => {
  const zip = await zipFile(fixture(), { 'restored.png': png });
  const form = new FormData(); form.append('backupZip', new Blob([await fsp.readFile(zip)]), 'backup.zip');
  assert.equal((await fetch(`${base}/api/admin/backup/import`, { method: 'POST', headers: auth(admin), body: form })).status, 200);
  assert.deepEqual(await fsp.readdir(cfg.m_TempDir), []);
  runtime.gate.exclusive = true;
  try { assert.equal((await upload()).status, 503); } finally { runtime.gate.exclusive = false; }
  const exported = await fetch(`${base}/api/admin/backup/export?download=true`, { method: 'POST', headers: auth(admin) });
  assert.equal(exported.status, 200); assert.equal(Buffer.from(await exported.arrayBuffer()).subarray(0, 2).toString(), 'PK');
});

test('URL 上传拒绝私网，流大小限制覆盖未知长度输入', async () => {
  for (const address of ['127.0.0.1', '10.1.1.1', '169.254.169.254', '172.16.1.1', '192.168.1.1', '::1', '::ffff:127.0.0.1', 'fc00::1']) assert.equal(publicAddress(address), false);
  assert.equal(publicAddress('8.8.8.8'), true);
  await assert.rejects(download('http://127.0.0.1/private', path.join(root, 'blocked')), /禁止/);
  const response = await fetch(`${base}/api/images/upload-url`, { method: 'POST', headers: { ...auth(user), 'Content-Type': 'application/json' }, body: JSON.stringify({ urls: ['http://127.0.0.1/private'] }) });
  assert.equal(response.status, 200); assert.match((await response.json()).created[0].error, /禁止/);
  const { Readable, Writable } = require('node:stream');
  await assert.rejects(pipeline(Readable.from([Buffer.alloc(5), Buffer.alloc(6)]), new ByteLimit(10), new Writable({ write(chunk, encoding, callback) { callback(); } })), { status: 413 });
});

test('压缩限制尝试次数，拒绝超像素图片，失败不留压缩临时文件', async () => {
  const file = path.join(root, 'noise.png');
  await sharp(randomBytes(256 * 256 * 3), { raw: { width: 256, height: 256, channels: 3 } }).png().toFile(file);
  const before = (await fsp.stat(file)).size;
  const result = await ImageController.EnsureMaxSize(file, 1024);
  assert.equal(result.changed, true); assert.ok(result.newSize < before);
  assert.ok(!(await fsp.readdir(root)).some(name => name.endsWith('.compressed')));
  const limit = cfg.m_MaxPixels; cfg.m_MaxPixels = 10;
  try { await assert.rejects(ImageController.Inspect(file), { status: 400 }); } finally { cfg.m_MaxPixels = limit; }
});

test('查询分页和数据库索引，错误返回 JSON，健康检查和 CORS', async () => {
  const tags = await fetch(`${base}/api/tags?limit=201`); assert.equal(tags.status, 400);
  const health = await fetch(`${base}/healthz`); assert.deepEqual(await health.json(), { status: 'ok' });
  const allowed = await fetch(`${base}/healthz`, { headers: { Origin: 'https://allowed.example' } }); assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://allowed.example');
  const denied = await fetch(`${base}/healthz`, { headers: { Origin: 'https://denied.example' } }); assert.equal(denied.headers.get('access-control-allow-origin'), null);
  assert.equal((await db.Get('PRAGMA journal_mode')).journal_mode, 'wal');
  const indexes = await db.All('PRAGMA index_list(image_tags)'); assert.ok(indexes.some(index => index.name === 'idx_image_tags_tag'));
  const malformed = await fetch(`${base}/api/users/2/status`, { method: 'PATCH', headers: { ...auth(admin), 'Content-Type': 'application/json' }, body: '{' }); assert.equal(malformed.status, 400); assert.equal((await malformed.json()).error, 'JSON 格式无效');
});

test('中断 multipart 上传释放资源并清理临时文件', async () => {
  await new Promise(resolve => {
    const req = http.request(`${base}/api/images/upload`, { method: 'POST', headers: { ...auth(user), 'Content-Type': 'multipart/form-data; boundary=abort-test' } });
    req.on('error', () => resolve());
    req.write('--abort-test\r\nContent-Disposition: form-data; name="files"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n');
    req.write(Buffer.alloc(10000));
    setTimeout(() => req.destroy(), 50);
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(runtime.gate.active, 0);
  assert.deepEqual(await fsp.readdir(cfg.m_TempDir), []);
});

test('URL 流下载、DNS 固定、跳转内网拦截、超限和超时', async () => {
  const dns = require('node:dns/promises');
  const axios = require('axios');
  const { Readable } = require('node:stream');
  const oldLookup = dns.lookup; const oldGet = axios.get;
  const output = path.join(root, 'download-success');
  dns.lookup = async () => [{ address: '8.8.8.8', family: 4 }];
  try {
    axios.get = async (url, options) => {
      assert.equal(options.proxy, false); assert.equal(options.maxRedirects, 0);
      assert.equal(options.responseType, 'stream');
      options.httpAgent.options.lookup('images.example', {}, (err, address) => { assert.equal(err, null); assert.equal(address, '8.8.8.8'); });
      return { status: 200, headers: {}, data: Readable.from([png.subarray(0, 10), png.subarray(10)]) };
    };
    assert.equal(await download('https://images.example/a.png', output), 'a.png');
    assert.deepEqual(await fsp.readFile(output), png);
    axios.get = async () => ({ status: 302, headers: { location: 'http://private.example/image' }, data: Readable.from([]) });
    let lookups = 0; dns.lookup = async () => [{ address: ++lookups === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }];
    await assert.rejects(download('https://images.example/a', path.join(root, 'redirect')), /禁止/);
    dns.lookup = async () => [{ address: '8.8.8.8', family: 4 }];
    axios.get = async () => ({ status: 200, headers: {}, data: Readable.from([Buffer.alloc(cfg.m_MaxFileBytes + 1)]) });
    await assert.rejects(download('https://images.example/a', path.join(root, 'overflow')), { status: 413 });
    const timeout = cfg.m_UrlTimeout; cfg.m_UrlTimeout = 100;
    dns.lookup = async () => new Promise(() => {});
    try {
      // 保持事件循环活动，验证 DNS 等待也包含在下载超时内。
      const timer = setTimeout(() => {}, 200);
      try { await assert.rejects(download('https://images.example/a', path.join(root, 'timeout')), { status: 408 }); }
      finally { clearTimeout(timer); }
    } finally { cfg.m_UrlTimeout = timeout; }
  } finally { dns.lookup = oldLookup; axios.get = oldGet; }
  assert.equal(publicAddress('2001:0000::1'), false);
});

test('拒绝异常条目、CRC 损坏和超限解压，导入不触碰正式文件', async () => {
  const source = await zipFile(fixture(), { 'restored.png': png });
  const limit = cfg.m_MaxBackupBytes; cfg.m_MaxBackupBytes = 10;
  try { await assert.rejects(importBackup(source), { status: 413 }); } finally { cfg.m_MaxBackupBytes = limit; }
  const bad = path.join(root, 'crc.zip');
  const zip = new yazl.ZipFile();
  const data = Buffer.from(JSON.stringify(fixture()));
  zip.addBuffer(data, 'data.json', { compress: false }); zip.addBuffer(png, 'images/restored.png', { compress: false });
  const writing = pipeline(zip.outputStream, fs.createWriteStream(bad)); zip.end(); await writing;
  const bytes = await fsp.readFile(bad); const index = bytes.indexOf(data); assert.ok(index >= 0); bytes[index + 1] ^= 1; await fsp.writeFile(bad, bytes);
  await assert.rejects(importBackup(bad), /校验失败/);
  assert.equal((await db.Get('SELECT COUNT(*) AS c FROM images')).c, 0);
  assert.deepEqual(await fsp.readdir(cfg.m_TempDir), []);
});

test('文件入库失败清理正式文件，注册限制与认证限流', async () => {
  const original = ImageRepository.AttachTags;
  ImageRepository.AttachTags = async () => { throw new Error('模拟标签关联失败'); };
  try { assert.equal((await upload()).status, 500); } finally { ImageRepository.AttachTags = original; }
  assert.equal((await db.Get('SELECT COUNT(*) AS c FROM images')).c, 0);
  assert.deepEqual(await fsp.readdir(cfg.m_UploadsDir), []);
  const enabled = cfg.m_RegisterEnabled; cfg.m_RegisterEnabled = false;
  try {
    assert.equal((await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"username":"new","password":"pass"}' })).status, 403);
  } finally { cfg.m_RegisterEnabled = enabled; }
  for (let i = 0; i < 21; i++) {
    const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    if (i === 20) assert.equal(response.status, 429);
  }
});

test('备份快照一致且不阻塞并发写入', async () => {
  let ready; const started = new Promise(resolve => { ready = resolve; });
  let release; const wait = new Promise(resolve => { release = resolve; });
  const snapshot = db.ReadSnapshot(async reader => {
    const initial = await reader.Get('SELECT COUNT(*) AS c FROM tags');
    ready(); await wait;
    const after = await reader.Get('SELECT COUNT(*) AS c FROM tags');
    assert.equal(after.c, initial.c);
  });
  await started;
  await db.Run("INSERT INTO tags(name) VALUES('snapshot-outside')");
  release(); await snapshot;
  assert.ok(await db.Get("SELECT id FROM tags WHERE name='snapshot-outside'"));
});

test('删除中断后按数据库状态恢复文件或完成清理', async () => {
  const { recoverDeletions } = require('../src/app/server');
  const id = (await (await upload()).json()).created[0].id;
  const image = await ImageRepository.GetImageById(id);
  const original = path.join(cfg.m_UploadsDir, image.filename);
  const staged = path.join(cfg.m_TempDir, `deleted-${id}-${image.filename}`);
  await fsp.rename(original, staged);
  await recoverDeletions(cfg);
  assert.deepEqual(await fsp.readFile(original), png);
  await fsp.rename(original, staged);
  await ImageRepository.DeleteImage(id);
  await recoverDeletions(cfg);
  assert.deepEqual(await fsp.readdir(cfg.m_TempDir), []);
  assert.deepEqual(await fsp.readdir(cfg.m_UploadsDir), []);
});

test('GitHub 管理页面、上传返回、令牌链接、模糊搜索与分页兼容', async () => {
  const homepage = await fetch(`${base}/`); assert.equal(homepage.status, 200); assert.match(await homepage.text(), /管理面板/);
  const javascript = await fetch(`${base}/js/app.js`); assert.equal(javascript.status, 200); assert.match(await javascript.text(), /nextBefore/);
  const response = await upload(png, 'one.png', 'Avatar-测试');
  const result = await response.json(); assert.deepEqual(result.images, result.created);
  const image = result.images[0]; assert.match(image.accessToken, /^[0-9a-f]{32}$/);
  const tokenResponse = await fetch(`${base}${image.url}`); assert.equal(tokenResponse.status, 200); assert.deepEqual(Buffer.from(await tokenResponse.arrayBuffer()), png);
  await upload(png, 'two.png', 'Avatar-测试');
  const first = await (await fetch(`${base}/api/images/list?search=avatar&limit=1`)).json();
  assert.equal(first.images.length, 1); assert.ok(first.nextBefore); assert.equal(first.images[0].tags, 'Avatar-测试');
  const next = await (await fetch(`${base}/api/images/list?search=avatar&limit=1&before=${first.nextBefore}`)).json();
  assert.equal(next.images.length, 1); assert.notEqual(next.images[0].id, first.images[0].id);
  const random = await fetch(`${base}/api/images?random=true&tags=avatar`); assert.equal(random.status, 200); await random.arrayBuffer();
  const literal = await (await fetch(`${base}/api/images/list?search=%25`)).json(); assert.equal(literal.images.length, 0);
});

test('GitHub 备份恢复保留原令牌链接，冲突不会覆盖现有图片', async () => {
  const data = fixture(); data.images[0].access_token = 'a'.repeat(32);
  const backup = await zipFile(data, { 'restored.png': png });
  await importBackup(backup);
  const existing = await ImageRepository.GetImageByToken('a'.repeat(32)); assert.ok(existing);
  const exported = await exportBackup();
  await ImageRepository.DeleteImage(existing.id); await fsp.unlink(path.join(cfg.m_UploadsDir, existing.filename));
  await importBackup(exported);
  assert.ok(await ImageRepository.GetImageByToken('a'.repeat(32)));
  const conflicting = fixture(); conflicting.images[0].filename = 'another.png'; conflicting.images[0].access_token = 'a'.repeat(32);
  const conflictZip = await zipFile(conflicting, { 'another.png': png });
  await assert.rejects(importBackup(conflictZip), { status: 409 });
  assert.equal((await db.Get('SELECT COUNT(*) AS c FROM images')).c, 1);
  assert.deepEqual(await fsp.readdir(cfg.m_UploadsDir), ['restored.png']);
});

test('GitHub 自动迁移无令牌列的旧数据库并保持链接稳定', async () => {
  const filename = path.join(root, 'legacy.sqlite');
  const legacy = new Database(filename); await legacy.Open();
  try {
    await legacy.Run(`CREATE TABLE images (id INTEGER PRIMARY KEY, owner_id INTEGER,filename TEXT NOT NULL,original_name TEXT,mime_type TEXT,size INTEGER,storage_path TEXT NOT NULL,remote_url TEXT,created_at TEXT NOT NULL)`);
    await legacy.Run("INSERT INTO images(id,filename,storage_path,created_at) VALUES(1,'legacy.png','legacy.png','2026-01-01')");
    await legacy.Init();
    const first = await legacy.Get('SELECT access_token FROM images WHERE id=1'); assert.match(first.access_token, /^[0-9a-f]{32}$/);
    await legacy.Init(); assert.equal((await legacy.Get('SELECT access_token FROM images WHERE id=1')).access_token, first.access_token);
  } finally { await legacy.Close(); }
});
