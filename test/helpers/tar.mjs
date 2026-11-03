// 测试用：手工拼一个 ustar 归档（不依赖系统 tar，Windows 上也能跑）。
// 只支持普通文件与目录 —— 正好也是安装器允许的类型；要构造"危险归档"时按需给 typeflag。
import zlib from 'node:zlib';

const BLOCK = 512;

function octal(value, length) {
  const text = Math.max(0, Number(value) || 0).toString(8);
  return `${'0'.repeat(Math.max(0, length - 1 - text.length))}${text}\0`;
}

function header({ name, size = 0, type = '0', mode = 0o644, linkname = '' }) {
  const buf = Buffer.alloc(BLOCK);
  buf.write(name.slice(0, 100), 0, 'utf8');
  buf.write(octal(mode, 8), 100, 'ascii');
  buf.write(octal(0, 8), 108, 'ascii');
  buf.write(octal(0, 8), 116, 'ascii');
  buf.write(octal(size, 12), 124, 'ascii');
  buf.write(octal(0, 12), 136, 'ascii');
  buf.write('        ', 148, 'ascii');            // 校验和先按空格算
  buf.write(type, 156, 'ascii');
  buf.write(String(linkname).slice(0, 100), 157, 'utf8');   // hardlink/symlink 的目标
  buf.write('ustar', 257, 'ascii');
  buf.write('00', 263, 'ascii');
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return buf;
}

/**
 * @param entries [{ name, data?, type? }]（type 默认 file，'5' 是目录）
 * @param compress 是否 gzip（默认 true）
 */
export function buildTar(entries, { compress = true, longNameHeader = false } = {}) {
  const chunks = [];
  for (const entry of entries) {
    const isDir = entry.type === '5';
    const data = isDir ? Buffer.alloc(0) : Buffer.from(entry.data ?? '', 'utf8');
    if (longNameHeader) {
      // 故意插一个 pax 扩展头：安装器必须拒绝（否则会解出错路径）
      const body = Buffer.from(`path=${entry.name}\n`, 'utf8');
      chunks.push(header({ name: 'PaxHeaders/x', size: body.length, type: 'x' }));
      chunks.push(body, Buffer.alloc((BLOCK - (body.length % BLOCK)) % BLOCK));
    }
    chunks.push(header({
      name: isDir ? `${entry.name}/` : entry.name,
      size: data.length,
      type: entry.type || '0',
      // 目录必须可进入/可删除：0644 目录在 Linux 上连 rm -r 都会 EACCES。
      mode: isDir ? 0o755 : 0o644,
      linkname: entry.linkname || ''
    }));
    if (!isDir) chunks.push(data, Buffer.alloc((BLOCK - (data.length % BLOCK)) % BLOCK));
  }
  chunks.push(Buffer.alloc(BLOCK * 2));            // 归档结束
  const raw = Buffer.concat(chunks);
  return compress ? zlib.gzipSync(raw) : raw;
}
