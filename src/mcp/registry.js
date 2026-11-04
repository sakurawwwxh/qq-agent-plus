// 官方 MCP Registry 导入：只取 stdio 包并映射成本项目的 server 配置。
// 目录里有大量只支持远程 HTTP 的 server，当前客户端只支持 stdio，这类会标记 unsupported。

import { safeFetch } from '../llm/safe-fetch.js';

const REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0/servers';
// npm 分支只会生成 `npx -y pkg@version`；node/python/uvx 等运行器不认这套参数，
// 放行它们只会生成必然起不来的配置。runtimeHint 是远端可控字段，只认 basename；
// 未知值一律回落 npx（2026-11-03 复核 P0）。
const RUNTIME_ALLOWLIST = new Set(['npx', 'npx.cmd']);

function safeRuntimeCommand(hint) {
  const base = String(hint || '').trim().split(/[\\/]/).pop().toLowerCase();
  return RUNTIME_ALLOWLIST.has(base) ? base : 'npx';
}

function safeId(name) {
  return String(name || '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'server';
}

/** npm 位置参数只能是包名：以 - 开头会被 npx 当成选项（--package=evil 可换包）。 */
function safeNpmIdentifier(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 214 || text.startsWith('-')) return '';
  if (/[\s\u0000-\u001f\u007f]/.test(text)) return '';
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(text)) return '';
  return text;
}

/** 版本只接受明确的 semver（含 rc/beta 与 build 元数据），拒绝范围、空白和选项形态。 */
function safeNpmVersion(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 128 || text.startsWith('-')) return '';
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(text)) return '';
  return text;
}

function versionScore(version) {
  return String(version || '').split('.').reduce((sum, part, index) => {
    const n = Number(String(part).replace(/\D/g, '')) || 0;
    return sum + n / (1000 ** index);
  }, 0);
}

const ENV_DENY = /^(?:PATH|HOME|USER|SHELL|LANG|LC_|LD_|NODE_OPTIONS|NODE_PATH|NODE_TLS_REJECT_UNAUTHORIZED|NODE_EXTRA_CA_CERTS|SSL_|OPENSSL_|CURL_|REQUESTS_CA_BUNDLE|PIP_CERT|GIT_SSL_|DOCKER_|NPM_CONFIG_|BASH_ENV|TMP|TEMP|COMSPEC|SYSTEMROOT|UV_|PIP_|PYTHON|[A-Z0-9_]+_PROXY)/i;

function safeEnv(entryEnv) {
  const env = {};
  for (const item of Array.isArray(entryEnv) ? entryEnv : []) {
    const name = String(item?.name || '');
    // registry 的 env 键和默认值都是发布者可控：不允许覆盖启动器自己的 PATH/HOME/NODE_OPTIONS 等。
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || ENV_DENY.test(name)) continue;
    env[name] = String(item.default ?? '');
  }
  return env;
}

function packageConfig(entry, pkg) {
  const env = safeEnv(pkg.environmentVariables);
  if (pkg.registryType === 'oci') {
    const rawIdentifier = String(pkg.identifier || '').trim();
    // docker run 的最后一个位置参数不能是选项；空值或不合法引用直接拒绝。
    if (!rawIdentifier || rawIdentifier.startsWith('-')) return null;
    const version = String(pkg.version || entry.version || '').trim();
    const lastSlash = rawIdentifier.lastIndexOf('/');
    const lastColon = rawIdentifier.lastIndexOf(':');
    const hasDigest = rawIdentifier.includes('@');
    const hasTag = lastColon > lastSlash;
    let identifier = rawIdentifier;
    if (!hasDigest && !hasTag) {
      // 没有 tag/digest 时 docker 会静默跑 latest；没有可钉版本就不导入。
      if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(version)) return null;
      identifier = `${rawIdentifier}:${version}`;
    }
    const dockerEnv = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
    return {
      command: 'docker',
      // OCI 的变量必须交给容器，不能污染启动器进程。
      args: ['run', '-i', '--rm', ...dockerEnv, identifier],
      env: {}
    };
  }
  const identifier = safeNpmIdentifier(pkg.identifier);
  if (!identifier) return null;
  const version = safeNpmVersion(pkg.version || entry.version);
  // 没有明确版本就不导入：否则 npx 会执行 latest，卡片上显示的版本与实际执行的包不一致。
  if (!version) return null;
  const pinned = `${identifier}@${version}`;
  // runtimeArguments 也只能接受不带 flag 的位置参数：`--package=evil` / `-c` 能把实际执行的包换掉。
  const runtime = Array.isArray(pkg.runtimeArguments)
    ? pkg.runtimeArguments.map((arg) => String(arg?.value ?? '')).filter((arg) => arg && !arg.startsWith('-'))
    : [];
  const args = ['-y', pinned, ...runtime];
  return { command: safeRuntimeCommand(pkg.runtimeHint), args, env };
}

export function mapRegistryEntry(entry) {
  const name = String(entry?.name || '').trim();
  if (!name) return null;
  const packages = Array.isArray(entry.packages) ? entry.packages : [];
  const stdio = packages.find((pkg) =>
    pkg?.transport?.type === 'stdio' && ['npm', 'oci'].includes(pkg.registryType)
    && (pkg.registryType === 'oci' || pkg.identifier));
  if (!stdio) {
    return {
      id: safeId(name),
      title: String(entry.title || name),
      name,
      description: String(entry.description || ''),
      repository: String(entry.repository?.url || ''),
      version: String(entry.version || ''),
      category: '官方目录',
      source: 'registry',
      unsupported: true,
      reason: '只提供远程 HTTP 或未声明可运行的 stdio 包'
    };
  }
  const config = packageConfig(entry, stdio);
  if (!config) return null;
  return {
    id: safeId(name),
    title: String(entry.title || name),
    name,
    description: String(entry.description || ''),
    repository: String(entry.repository?.url || ''),
    version: String(entry.version || ''),
    category: '官方目录',
    source: 'registry',
    unsupported: false,
    config: {
      id: safeId(name),
      enabled: false,
      transport: 'stdio',
      command: config.command,
      args: config.args,
      env: config.env,
      timeoutMs: 30000,
      maxCallsPerMinute: 30,
      toolMounting: 'direct'
    }
  };
}

export async function searchRegistry(query, { fetchImpl = safeFetch, limit = 20 } = {}) {
  const q = String(query || '').trim();
  const size = Math.max(1, Math.min(50, Number(limit) || 20));
  const url = q
    ? `${REGISTRY_URL}?search=${encodeURIComponent(q)}&limit=${size}`
    : `${REGISTRY_URL}?limit=${size}`;
  const res = await fetchImpl(url, { maxBytes: 500000, signal: AbortSignal.timeout(15000) });
  if (!res || res.statusCode >= 400) throw new Error(`MCP Registry 返回 ${res?.statusCode || '未知状态'}`);
  let data = null;
  try { data = JSON.parse(res.body || '{}'); } catch { throw new Error('MCP Registry 返回的不是 JSON'); }
  const list = Array.isArray(data) ? data : (Array.isArray(data.servers) ? data.servers : []);
  const byName = new Map();
  for (const item of list) {
    const entry = item?.server || item;
    const mapped = mapRegistryEntry(entry);
    if (!mapped) continue;
    const old = byName.get(mapped.name);
    if (!old || versionScore(mapped.version) > versionScore(old.version)) byName.set(mapped.name, mapped);
  }
  return [...byName.values()].slice(0, 50);
}
