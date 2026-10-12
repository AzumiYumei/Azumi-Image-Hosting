const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

test('生产启动要求安全密钥，健康检查与正常停止关闭数据库', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'azumi-lifecycle-'));
  const env = { ...process.env, DATA_DIR: path.join(root, 'data'), BACKUPS_DIR: path.join(root, 'backups'), NODE_ENV: 'production', JWT_SECRET: '', ADMIN_PASSWORD: '', PORT: '0', HOST: '127.0.0.1', ACCESS_LOG: 'false' };
  const run = (script, environment) => {
    const child = spawn(process.execPath, ['-e', script], { env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    return new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve({ code, output })); });
  };
  try {
    const missing = await run("require('./src/app/server').Bootstrap().catch(e=>{console.error(e.message);process.exit(1)})", env);
    assert.equal(missing.code, 1); assert.match(missing.output, /生产环境必须配置/);
    const script = `
      const {Bootstrap}=require('./src/app/server');
      const {Database}=require('./src/db/sqlite');
      Bootstrap().then(async server=>{
        await new Promise(resolve=>server.once('listening',resolve));
        const response=await fetch('http://127.0.0.1:'+server.address().port+'/healthz');
        if(response.status!==200) throw new Error('health failed');
        await response.json();
        process.emit('SIGTERM');
        setTimeout(()=>{if(Database.Get().m_Db!==null) process.exitCode=2},100);
      }).catch(e=>{console.error(e);process.exit(1)});
    `;
    const good = await run(script, { ...env, JWT_SECRET: 'a'.repeat(64) });
    assert.equal(good.code, 0, good.output);
  } finally {
    // 仅清理本测试创建并核对位于系统临时目录的路径。
    if (path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(root).startsWith('azumi-lifecycle-')) await fsp.rm(root, { recursive: true, force: true });
  }
});
