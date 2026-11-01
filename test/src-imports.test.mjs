// 静态 import 环守卫（结构守卫，零依赖）。
//
// 背景：src/ 目前没有静态 import 环；按域拆模块时最容易犯的错是"新模块反向 import
// app.js"或域之间互相 import。这里只匹配**静态** import/export-from（不解析动态
// import()、字符串、注释），支持多行写法；发现环就列出完整路径。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** 去掉块注释与整行注释（不做完整词法分析：只服务"行首 import"这类语句）。 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => (line.trimStart().startsWith('//') ? '' : line))
    .join('\n');
}

function staticSpecifiers(text) {
  const lines = stripComments(text).split('\n');
  const specs = [];
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trimStart();
    if (/^import\s*\(/.test(trimmed)) continue;                 // 动态 import()
    const sideEffect = /^import\s*['"]([^'"]+)['"]/.exec(trimmed); // import 'x'
    if (sideEffect) { specs.push(sideEffect[1]); continue; }
    const isImport = /^import\b/.test(trimmed);
    const isExportFrom = /^export\s+(?:\*|\{)/.test(trimmed);     // export * / export {...} from
    if (!isImport && !isExportFrom) continue;
    // 多行写法：累加到出现 from '...' 为止（最多 30 行，避免跨语句吞掉后面的 import）
    let statement = trimmed;
    for (let j = i; j < lines.length && j < i + 30; j += 1) {
      if (j > i) statement += ` ${lines[j].trim()}`;
      const m = /\bfrom\s*['"]([^'"]+)['"]/.exec(statement);
      if (m) { specs.push(m[1]); i = j; break; }
    }
  }
  return specs;
}

const files = walk('src');
const nodes = new Map();   // absPath -> { rel, deps:Set<absPath> }

for (const file of files) {
  const abs = path.resolve(file);
  const deps = new Set();
  for (const spec of staticSpecifiers(fs.readFileSync(file, 'utf8'))) {
    if (!spec.startsWith('.')) continue;
    const target = path.resolve(path.dirname(abs), spec);
    if (fs.existsSync(target) && target.endsWith('.js')) deps.add(target);
  }
  nodes.set(abs, { rel: path.relative('.', abs).split(path.sep).join('/'), deps });
}

/** Tarjan：返回所有大小 >1 的强连通分量（以及自环）。 */
function findCycles(graph) {
  let index = 0;
  const indices = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const cycles = [];

  const strongConnect = (node) => {
    indices.set(node, index);
    low.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const dep of graph.get(node)?.deps || []) {
      if (!graph.has(dep)) continue;
      if (!indices.has(dep)) {
        strongConnect(dep);
        low.set(node, Math.min(low.get(node), low.get(dep)));
      } else if (onStack.has(dep)) {
        low.set(node, Math.min(low.get(node), indices.get(dep)));
      }
    }
    if (low.get(node) !== indices.get(node)) return;
    const component = [];
    let current;
    do {
      current = stack.pop();
      onStack.delete(current);
      component.push(current);
    } while (current !== node);
    if (component.length > 1 || graph.get(node)?.deps.has(node)) cycles.push(component);
  };

  for (const node of graph.keys()) {
    if (!indices.has(node)) strongConnect(node);
  }
  return cycles;
}

test('src/ 的静态 import 没有环', () => {
  const cycles = findCycles(nodes);
  const readable = cycles.map((component) =>
    component.map((node) => nodes.get(node)?.rel || node).sort().join(' ↔ '));
  assert.deepEqual(readable, [], `发现 import 环：\n${readable.join('\n')}`);
});

test('只有 server.js 可以 import console/app.js（防止路由模块反向依赖组合根）', () => {
  const offenders = [];
  for (const info of nodes.values()) {
    if (info.rel === 'src/server.js') continue;
    for (const dep of info.deps) {
      if (nodes.get(dep)?.rel === 'src/console/app.js') offenders.push(info.rel);
    }
  }
  assert.deepEqual(offenders, [], `以下模块不应 import console/app.js：${offenders.join(', ')}`);
});

test('多行 import 也能被解析（守卫自身有效）', () => {
  // 用拼接生成相对路径：避免 test/layout.test.mjs 的"相对 import 必须存在"扫描
  // 把用例里的示例路径当成真 import。
  const p = (name) => `.${'/'}${name}.js`;
  const specs = staticSpecifiers([
    'import {',
    '  a,',
    '  b',
    `} from '${p('multi')}';`,
    `import x from '${p('single')}';`,
    `import '${p('side-effect')}';`,
    'export {',
    '  c',
    `} from '${p('re-export')}';`
  ].join('\n'));
  assert.deepEqual(specs, [p('multi'), p('single'), p('side-effect'), p('re-export')]);
});
