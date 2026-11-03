// 备份密钥的读取/生成。独立成模块是为了让 ops.js 的备份状态机保持在体量闸门内，
// 也方便以后给 CLI 之外的入口复用同一套“绝不覆盖旧密钥”的规则。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function backupKeyFile(explicit = '') {
  return explicit
    || String(process.env.QQ_AGENT_BACKUP_KEY_FILE || '').trim()
    || path.join(os.homedir(), '.config', 'qq-agent', 'backup.key');
}

/**
 * 密钥来源：QQ_AGENT_BACKUP_KEY（64 位 hex 或口令）优先，其次密钥文件。
 * create=true 时只在文件**不存在**时生成；已存在但损坏/不可读时中止，不能覆盖旧密钥。
 */
export function loadBackupKey({ create = false, keyFile = '', note = () => {} } = {}) {
  const envKey = String(process.env.QQ_AGENT_BACKUP_KEY || '').trim();
  if (envKey) {
    if (/^[0-9a-fA-F]{64}$/.test(envKey)) return Buffer.from(envKey, 'hex');
    // 口令：固定 salt 是为了同一口令在不同机器上能解开同一份备份（备份恢复不依赖本机状态）。
    return crypto.scryptSync(envKey, 'qq-agent-backup-v1', 32);
  }
  const file = backupKeyFile(keyFile);
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch (error) {
    // 只有“文件不存在”才允许自动生成；存在但读不了/格式坏时覆盖它，
    // 会让用旧密钥加密的历史备份永久无法解密。
    if (error?.code !== 'ENOENT') {
      throw new Error(`备份密钥文件不可读：${file}（${error?.message || error}）。`
        + '已中止本次备份，不会覆盖原密钥');
    }
    if (!create) {
      throw new Error(`找不到可用的备份密钥：${file}。请设置 QQ_AGENT_BACKUP_KEY 或用 --key-file 指定`);
    }
    const key = crypto.randomBytes(32);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try { fs.writeFileSync(fd, `${key.toString('hex')}\n`); } finally { fs.closeSync(fd); }
    } catch (writeError) {
      if (writeError?.code === 'EEXIST') {
        throw new Error(`备份密钥文件在生成时被其他进程创建：${file}。已中止，不会覆盖`);
      }
      throw writeError;
    }
    note(`已生成备份密钥: ${file}（请与备份分开保管；丢了备份无法恢复）`);
    return key;
  }
  const textValue = raw.toString('utf8').trim();
  if (/^[0-9a-fA-F]{64}$/.test(textValue)) return Buffer.from(textValue, 'hex');
  if (raw.length === 32) return raw;
  throw new Error(`备份密钥文件格式不对：${file}（需要 64 位十六进制或 32 字节）。`
    + '已中止本次备份，不会覆盖原密钥');
}
