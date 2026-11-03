// tar 头里的负长度不能把解析器带进死循环（2026-10-31 盲审 P2）。
import assert from 'node:assert/strict';
import { test } from 'node:test';

const { parseTarGz } = await import('../src/plugins/install.js');

function tarHeader(name, sizeField) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 'utf8');
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(sizeField, 124);          // 12 字节 size 字段
  header.write('00000000000\0', 136);    // mtime
  header.fill(0x20, 148, 156);           // checksum 先当空格
  header[156] = 0x30;                    // 普通文件
  header.write('ustar\0', 257);
  header.write('00', 263);
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += header[i];
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return header;
}

test('负 size 的 tar 条目被拒绝，不进入死循环', () => {
  const archive = Buffer.concat([
    tarHeader('evil.txt', '-0000001000'),
    Buffer.alloc(512)
  ]);
  assert.throws(() => parseTarGz(archive), (error) => error.code === 'E_ARCHIVE' && /长度非法|数字字段/.test(error.message));
});
