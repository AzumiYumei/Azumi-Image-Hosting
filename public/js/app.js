const API_BASE = '/api';
const token = localStorage.getItem('token');
const username = localStorage.getItem('username');
const isAdmin = localStorage.getItem('isAdmin') === 'true';

// 检查登录状态
if (!token) {
  window.location.href = '/login.html';
}

// 初始化
document.getElementById('username').textContent = username;
if (isAdmin) {
  document.querySelectorAll('.admin-only').forEach(el => el.classList.remove('hidden'));
}

// 标签切换
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');

    document.getElementById('uploadTab').classList.toggle('hidden', target !== 'upload');
    document.getElementById('galleryTab').classList.toggle('hidden', target !== 'gallery');
    document.getElementById('adminTab').classList.toggle('hidden', target !== 'admin');

    if (target === 'gallery') loadImages();
    if (target === 'admin') loadUsers();
  });
});

// 退出登录
document.getElementById('logoutBtn').addEventListener('click', () => {
  localStorage.clear();
  window.location.href = '/login.html';
});

// 本地上传
document.getElementById('uploadBtn').addEventListener('click', async () => {
  const files = document.getElementById('fileInput').files;
  const tags = document.getElementById('fileTags').value;

  if (!files.length) {
    showMessage('请选择文件', 'error');
    return;
  }

  const formData = new FormData();
  for (let file of files) {
    formData.append('files', file);
  }
  if (tags) formData.append('tags', tags);

  try {
    const res = await fetch(`${API_BASE}/images/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData
    });

    const data = await res.json();
    if (res.ok) {
      showMessage(`成功上传 ${data.images.length} 张图片`, 'success');
      document.getElementById('fileInput').value = '';
      document.getElementById('fileTags').value = '';
    } else {
      showMessage(data.error || '上传失败', 'error');
    }
  } catch (err) {
    showMessage('网络错误', 'error');
  }
});

// URL上传
document.getElementById('uploadUrlBtn').addEventListener('click', async () => {
  const urls = document.getElementById('urlInput').value.split('\n').filter(u => u.trim());
  const tags = document.getElementById('urlTags').value;

  if (!urls.length) {
    showMessage('请输入URL', 'error');
    return;
  }

  try {
    const res = await fetch(`${API_BASE}/images/upload-url`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ urls, tags })
    });

    const data = await res.json();
    if (res.ok) {
      showMessage(`成功上传 ${data.images.length} 张图片`, 'success');
      document.getElementById('urlInput').value = '';
      document.getElementById('urlTags').value = '';
    } else {
      showMessage(data.error || '上传失败', 'error');
    }
  } catch (err) {
    showMessage('网络错误', 'error');
  }
});

// 加载图片列表
async function loadImages(tags = '') {
  try {
    const url = tags ? `${API_BASE}/images/list?tags=${encodeURIComponent(tags)}` : `${API_BASE}/images/list`;
    const res = await fetch(url);
    const data = await res.json();

    const grid = document.getElementById('imageGrid');
    grid.innerHTML = '';

    if (!data.images || !data.images.length) {
      grid.innerHTML = '<p>暂无图片</p>';
      return;
    }

    data.images.forEach(img => {
      const card = document.createElement('div');
      card.className = 'image-card';
      card.innerHTML = `
        <img src="${API_BASE}/images/${img.id}/raw" alt="${img.filename}">
        <div class="image-info">
          <div class="image-tags">${img.tags || '无标签'}</div>
          <div class="image-actions">
            <button onclick="copyUrl(${img.id})">复制链接</button>
            <button onclick="deleteImage(${img.id})">删除</button>
          </div>
        </div>
      `;
      grid.appendChild(card);
    });
  } catch (err) {
    showMessage('加载失败', 'error');
  }
}

// 搜索图片
document.getElementById('searchBtn').addEventListener('click', () => {
  const tags = document.getElementById('searchTags').value;
  loadImages(tags);
});

document.getElementById('refreshBtn').addEventListener('click', () => {
  document.getElementById('searchTags').value = '';
  loadImages();
});

// 复制图片链接
window.copyUrl = function(id) {
  const url = `${window.location.origin}${API_BASE}/images/${id}/raw`;
  navigator.clipboard.writeText(url).then(() => {
    showMessage('链接已复制', 'success');
  });
};

// 删除图片
window.deleteImage = async function(id) {
  if (!confirm('确定删除这张图片？')) return;

  try {
    const res = await fetch(`${API_BASE}/images/${id}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (res.ok) {
      showMessage('删除成功', 'success');
      loadImages();
    } else {
      const data = await res.json();
      showMessage(data.error || '删除失败', 'error');
    }
  } catch (err) {
    showMessage('网络错误', 'error');
  }
};

// 加载用户列表
async function loadUsers() {
  try {
    const res = await fetch(`${API_BASE}/users`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();

    const list = document.getElementById('userList');
    list.innerHTML = '';

    data.users.forEach(user => {
      const item = document.createElement('div');
      item.className = 'user-item';
      item.innerHTML = `
        <span>${user.username} ${user.is_admin ? '(管理员)' : ''}</span>
        <button onclick="toggleUserStatus(${user.id}, '${user.status}')">
          ${user.status === 'active' ? '禁用' : '启用'}
        </button>
      `;
      list.appendChild(item);
    });
  } catch (err) {
    showMessage('加载失败', 'error');
  }
}

// 切换用户状态
window.toggleUserStatus = async function(id, currentStatus) {
  const newStatus = currentStatus === 'active' ? 'disabled' : 'active';

  try {
    const res = await fetch(`${API_BASE}/users/${id}/status`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ status: newStatus })
    });

    if (res.ok) {
      showMessage('状态已更新', 'success');
      loadUsers();
    } else {
      const data = await res.json();
      showMessage(data.error || '操作失败', 'error');
    }
  } catch (err) {
    showMessage('网络错误', 'error');
  }
};

// 查看数据库状态
document.getElementById('dbStatusBtn').addEventListener('click', async () => {
  try {
    const res = await fetch(`${API_BASE}/admin/status/db`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();

    document.getElementById('dbStatus').textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    showMessage('加载失败', 'error');
  }
});

// 导出备份
document.getElementById('exportBtn').addEventListener('click', async () => {
  try {
    const res = await fetch(`${API_BASE}/admin/backup/export`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` }
    });

    if (res.ok) {
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `backup-${Date.now()}.zip`;
      a.click();
      showMessage('备份已导出', 'success');
    } else {
      showMessage('导出失败', 'error');
    }
  } catch (err) {
    showMessage('网络错误', 'error');
  }
});

// 导入备份
document.getElementById('importBtn').addEventListener('click', async () => {
  const file = document.getElementById('importInput').files[0];
  if (!file) {
    showMessage('请选择备份文件', 'error');
    return;
  }

  const formData = new FormData();
  formData.append('backupZip', file);

  try {
    const res = await fetch(`${API_BASE}/admin/backup/import`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData
    });

    const data = await res.json();
    if (res.ok) {
      showMessage('备份已导入', 'success');
      document.getElementById('importInput').value = '';
    } else {
      showMessage(data.error || '导入失败', 'error');
    }
  } catch (err) {
    showMessage('网络错误', 'error');
  }
});

function showMessage(text, type) {
  const msg = document.getElementById('uploadMessage');
  msg.textContent = text;
  msg.className = `message ${type}`;
  setTimeout(() => msg.className = 'message', 3000);
}
