const dns = require('node:dns/promises');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const axios = require('axios');
const fs = require('node:fs');
const { pipeline } = require('node:stream/promises');
const { error, ByteLimit } = require('./resources');
const { Config } = require('../config');

function publicAddress(address) {
  if (net.isIP(address) === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  // 仅接受 IPv6 公网单播地址，拒绝映射地址、隧道、文档和私网范围。
  if (net.isIP(address) !== 6) return false;
  const canonical = new URL(`http://[${address}]`).hostname.slice(1, -1);
  const [first, second = 0] = canonical.split(':').map(value => parseInt(value || '0', 16));
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2002 && !(first === 0x2001 && (second < 0x200 || second === 0xdb8));
}

async function download(url, destination, outerSignal) {
  const cfg = Config.Get();
  const timeout = AbortSignal.timeout(cfg.m_UrlTimeout);
  const signal = outerSignal ? AbortSignal.any([timeout, outerSignal]) : timeout;
  let current;
  try { current = new URL(url); } catch { throw error(400, 'URL 无效'); }
  for (let redirect = 0; redirect <= 3; redirect++) {
    if (!['http:', 'https:'].includes(current.protocol) || current.username || current.password) throw error(400, 'URL 协议或凭据无效');
    const hostname = current.hostname.replace(/^\[|\]$/g, '');
    // DNS 校验与请求共用同一结果，避免再次解析导致地址变更。
    const addresses = await Promise.race([
      dns.lookup(hostname, { all: true }),
      new Promise((_, reject) => {
        if (signal.aborted) reject(error(408, '下载超时或已取消'));
        else signal.addEventListener('abort', () => reject(error(408, '下载超时或已取消')), { once: true });
      })
    ]);
    if (!addresses.length || addresses.some(item => !publicAddress(item.address))) throw error(400, '禁止访问内网或保留地址');
    const chosen = addresses[0];
    const lookup = (_, options, callback) => options?.all ? callback(null, [chosen]) : callback(null, chosen.address, chosen.family);
    const httpAgent = new http.Agent({ lookup });
    const httpsAgent = new https.Agent({ lookup });
    try {
      const response = await axios.get(current.href, { responseType: 'stream', signal, timeout: cfg.m_UrlTimeout, maxRedirects: 0, proxy: false, httpAgent, httpsAgent, validateStatus: () => true });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        response.data.destroy();
        if (!response.headers.location || redirect === 3) throw error(400, '重定向次数超限');
        current = new URL(response.headers.location, current);
        continue;
      }
      if (response.status !== 200) { response.data.destroy(); throw error(400, '下载响应无效'); }
      if (Number(response.headers['content-length']) > cfg.m_MaxFileBytes) { response.data.destroy(); throw error(413, '远程文件超过大小限制'); }
      await pipeline(response.data, new ByteLimit(cfg.m_MaxFileBytes), fs.createWriteStream(destination, { flags: 'wx' }), { signal });
      return pathName(current);
    } finally { httpAgent.destroy(); httpsAgent.destroy(); }
  }
}

function pathName(url) {
  try { return decodeURIComponent(url.pathname.split('/').pop()) || 'image'; }
  catch { return 'image'; }
}

module.exports = { download, publicAddress };
