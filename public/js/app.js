const API_BASE = '/api';
const token = localStorage.getItem('token');
const username = localStorage.getItem('username');
const isAdmin = localStorage.getItem('isAdmin') === 'true';
if (!token) window.location.href = '/login.html';
document.getElementById('username').textContent = username;
if (isAdmin) document.querySelectorAll('.admin-only').forEach(element => element.classList.remove('hidden'));

async function request(endpoint, options = {}) {
  const response = await fetch(`${API_BASE}${endpoint}`, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers } });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) { localStorage.clear(); window.location.href = '/login.html'; }
    throw new Error(data.error || '请求失败');
  }
  return data;
}

function showMessage(text, type) {
  const message = document.getElementById('uploadMessage');
  message.textContent = text;
  message.className = `message ${type}`;
}

document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => {
  const target = tab.dataset.tab;
  document.querySelectorAll('.tab').forEach(item => item.classList.toggle('active', item === tab));
  for (const name of ['upload', 'gallery', 'admin']) document.getElementById(`${name}Tab`).classList.toggle('hidden', target !== name);
  if (target === 'gallery') loadImages();
  if (target === 'admin') loadUsers();
}));

document.getElementById('logoutBtn').addEventListener('click', () => { localStorage.clear(); window.location.href = '/login.html'; });

// 上传结果兼容两套接口，URL 单项失败时显示实际成功和失败数量。
function uploaded(data) {
  const results = data.created || data.images || [];
  const succeeded = results.filter(item => item.id).length;
  const failed = results.filter(item => item.error);
  showMessage(`成功上传 ${succeeded} 张图片${failed.length ? `，失败 ${failed.length} 张：${failed[0].error}` : ''}`, failed.length ? 'error' : 'success');
}

document.getElementById('uploadBtn').addEventListener('click', async event => {
  const files = document.getElementById('fileInput').files;
  if (!files.length) return showMessage('请选择文件', 'error');
  const form = new FormData();
  for (const file of files) form.append('files', file);
  const tags = document.getElementById('fileTags').value;
  if (tags) form.append('tags', tags);
  event.currentTarget.disabled = true;
  try {
    uploaded(await request('/images/upload', { method: 'POST', body: form }));
    document.getElementById('fileInput').value = ''; document.getElementById('fileTags').value = '';
  } catch (err) { showMessage(err.message, 'error'); }
  finally { document.getElementById('uploadBtn').disabled = false; }
});

document.getElementById('uploadUrlBtn').addEventListener('click', async () => {
  const urls = document.getElementById('urlInput').value.split('\n').map(value => value.trim()).filter(Boolean);
  if (!urls.length) return showMessage('请输入URL', 'error');
  const button = document.getElementById('uploadUrlBtn'); button.disabled = true;
  try {
    const data = await request('/images/upload-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ urls, tags: document.getElementById('urlTags').value }) });
    uploaded(data);
    if (!(data.created || []).some(item => item.error)) { document.getElementById('urlInput').value = ''; document.getElementById('urlTags').value = ''; }
  } catch (err) { showMessage(err.message, 'error'); }
  finally { button.disabled = false; }
});

let gallery = { keyword: '', before: Number.MAX_SAFE_INTEGER, previous: [], next: null };
let gallerySequence = 0;

// 通过文本节点显示名称和标签，防止上传内容被当成 HTML 执行。
function imageCard(image) {
  const card = document.createElement('div'); card.className = 'image-card';
  const preview = document.createElement('img'); preview.src = image.url; preview.alt = image.filename; preview.loading = 'lazy';
  const info = document.createElement('div'); info.className = 'image-info';
  const tags = document.createElement('div'); tags.className = 'image-tags'; tags.textContent = image.tags || '无标签';
  const actions = document.createElement('div'); actions.className = 'image-actions';
  const copy = document.createElement('button'); copy.textContent = '复制链接';
  copy.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(new URL(image.url, location.origin).href); showMessage('链接已复制', 'success'); }
    catch { showMessage('无法访问剪贴板，请在 HTTPS 或本机环境使用', 'error'); }
  });
  const remove = document.createElement('button'); remove.textContent = '删除';
  remove.addEventListener('click', async () => {
    if (!confirm('确定删除这张图片？')) return;
    try { await request(`/images/${image.id}`, { method: 'DELETE' }); showMessage('删除成功', 'success'); await loadImages(gallery.keyword, gallery.before, gallery.previous); }
    catch (err) { showMessage(err.message, 'error'); }
  });
  actions.append(copy, remove); info.append(tags, actions); card.append(preview, info); return card;
}

async function loadImages(keyword = '', before = Number.MAX_SAFE_INTEGER, previous = []) {
  const sequence = ++gallerySequence;
  try {
    const query = new URLSearchParams({ search: keyword, before: String(before), limit: '50' });
    const data = await request(`/images/list?${query}`);
    if (sequence !== gallerySequence) return;
    gallery = { keyword, before, previous, next: data.nextBefore };
    const grid = document.getElementById('imageGrid'); grid.replaceChildren();
    if (!data.images.length) { const empty = document.createElement('p'); empty.textContent = '本页暂无匹配图片'; grid.append(empty); }
    else if (keyword) {
      const groups = new Map();
      for (const image of data.images) for (const tag of image.tags.split(',').map(value => value.trim())) {
        if (tag.toLowerCase().includes(keyword.toLowerCase())) {
          if (!groups.has(tag)) groups.set(tag, []);
          groups.get(tag).push(image);
        }
      }
      for (const [tag, images] of groups) {
        const group = document.createElement('div'); group.className = 'tag-group';
        const header = document.createElement('div'); header.className = 'tag-group-header'; header.textContent = `${tag} (${images.length})`;
        const cards = document.createElement('div'); cards.className = 'tag-group-grid';
        cards.append(...images.map(imageCard)); group.append(header, cards); grid.append(group);
      }
      if (!groups.size) grid.append(...data.images.map(imageCard));
    } else grid.append(...data.images.map(imageCard));
    document.getElementById('previousImages').disabled = !previous.length;
    document.getElementById('nextImages').disabled = !data.nextBefore;
  } catch (err) { showMessage(err.message, 'error'); }
}

document.getElementById('searchBtn').addEventListener('click', () => loadImages(document.getElementById('searchTags').value.trim()));
document.getElementById('refreshBtn').addEventListener('click', () => { document.getElementById('searchTags').value = ''; loadImages(); });
document.getElementById('nextImages').addEventListener('click', () => { if (gallery.next) loadImages(gallery.keyword, gallery.next, [...gallery.previous, gallery.before]); });
document.getElementById('previousImages').addEventListener('click', () => { const previous = [...gallery.previous]; const before = previous.pop(); if (before) loadImages(gallery.keyword, before, previous); });
document.getElementById('randomBtn').addEventListener('click', () => {
  const query = new URLSearchParams({ random: 'true', tags: document.getElementById('searchTags').value.trim() });
  window.open(`${API_BASE}/images?${query}`, '_blank', 'noopener');
});

let nextUser = null;
let currentUserPage = 0;
async function loadUsers(after = 0) {
  try {
    const data = await request(`/users?after=${after}&limit=100`);
    currentUserPage = after; nextUser = data.nextAfter;
    const list = document.getElementById('userList'); list.replaceChildren();
    for (const user of data.users) {
      const item = document.createElement('div'); item.className = 'user-item';
      const label = document.createElement('span'); label.textContent = `${user.username}${user.role === 'admin' ? ' (管理员)' : ''}`;
      const button = document.createElement('button'); button.textContent = user.status === 'active' ? '禁用' : '启用';
      button.addEventListener('click', async () => {
        try {
          await request(`/users/${user.id}/status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: user.status === 'active' ? 'disabled' : 'active' }) });
          showMessage('状态已更新', 'success'); await loadUsers(currentUserPage);
        } catch (err) { showMessage(err.message, 'error'); }
      });
      item.append(label, button); list.append(item);
    }
    document.getElementById('nextUsers').disabled = !nextUser;
  } catch (err) { showMessage(err.message, 'error'); }
}
document.getElementById('nextUsers').addEventListener('click', () => { if (nextUser) loadUsers(nextUser); });
document.getElementById('dbStatusBtn').addEventListener('click', async () => {
  try { document.getElementById('dbStatus').textContent = JSON.stringify(await request('/admin/status/db'), null, 2); }
  catch (err) { showMessage(err.message, 'error'); }
});

document.getElementById('exportBtn').addEventListener('click', async () => {
  const button = document.getElementById('exportBtn'); button.disabled = true;
  try {
    const response = await fetch(`${API_BASE}/admin/backup/export?download=true`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error((await response.json()).error || '导出失败');
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a'); link.href = url; link.download = `backup-${Date.now()}.zip`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showMessage('备份已导出', 'success');
  } catch (err) { showMessage(err.message, 'error'); }
  finally { button.disabled = false; }
});

document.getElementById('importBtn').addEventListener('click', async () => {
  const file = document.getElementById('importInput').files[0];
  if (!file) return showMessage('请选择备份文件', 'error');
  const form = new FormData(); form.append('backupZip', file);
  const button = document.getElementById('importBtn'); button.disabled = true;
  try { await request('/admin/backup/import', { method: 'POST', body: form }); showMessage('备份已导入', 'success'); document.getElementById('importInput').value = ''; }
  catch (err) { showMessage(err.message, 'error'); }
  finally { button.disabled = false; }
});
