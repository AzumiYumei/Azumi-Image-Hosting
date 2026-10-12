const fs = require('node:fs');
const { createHash } = require('node:crypto');

// 流式计算文件内容摘要，文件名、来源地址和标签不参与查重。
async function hashImage(file) {
  const digest = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return digest.digest('hex');
}

module.exports = { hashImage };
