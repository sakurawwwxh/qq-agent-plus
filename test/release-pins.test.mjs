// 发版版本号必须与 compose/README 的默认镜像 pin 一致：否则 tag/package 校验通过，
// `docker compose up -d` 仍拉旧版本，用户以为升级了其实没有。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
const compose = fs.readFileSync(path.join(repo, 'docker-compose.yml'), 'utf8');
const readme = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
const dockerDoc = fs.readFileSync(path.join(repo, 'docs/DOCKER.md'), 'utf8');

test('compose 默认 Agent 镜像 tag 与 package.json 版本一致', () => {
  assert.match(compose, new RegExp(`wangxinhong/qq-agent-plus:${pkg.version.replace(/\./g, '\\.')}`));
});

test('Docker 手动发布也会校验版本号', () => {
  const docker = fs.readFileSync(path.join(repo, '.github/workflows/docker.yml'), 'utf8');
  assert.match(docker, /手动发布版本与 package\.json 一致/);
  // 只匹配中文文案会把“删掉 exit 1、只告警”的退化改动静默放过。
  assert.match(docker, /if \[ "\$VERSION" != "\$PKG_VERSION" \]; then[\s\S]*?exit 1/);
});

test('容器相关 PR 只构建冒烟，不登录也不推送', () => {
  const docker = fs.readFileSync(path.join(repo, '.github/workflows/docker.yml'), 'utf8');
  assert.match(docker, /pull_request:\n    paths:/, 'PR 也应触发镜像构建检查');
  assert.match(docker, /build:\n    needs: \[verify, smoke, windows\]\n    if: github\.event_name != 'pull_request'/,
    'PR 上必须跳过推送 job');
  assert.match(docker, /windows:\n    # tag 发布同样要过 Windows 门禁；PR 只做容器 smoke[\s\S]*?if: github\.event_name != 'pull_request'/,
    'PR 上不跑 Windows job（推送 build 也跳过）');
});

test('所有文档里的 Agent 镜像 tag 都与 package.json 版本一致', () => {
  const readmeEn = fs.readFileSync(path.join(repo, 'README.en.md'), 'utf8');
  for (const [name, text] of [['README.md', readme], ['README.en.md', readmeEn], ['docs/DOCKER.md', dockerDoc]]) {
    const tags = [...text.matchAll(/qq-agent-plus:(\d+\.\d+\.\d+)/g)].map((m) => m[1]);
    assert.ok(tags.length > 0, `${name} 至少要有拉取/固定示例`);
    assert.deepEqual([...new Set(tags)], [pkg.version], `${name} 里还有旧版本 tag：${tags.join(', ')}`);
  }
});

test('Node 版本 pin：.nvmrc / Dockerfile / deploy.sh / 运维文档一致', () => {
  const nvm = fs.readFileSync(path.join(repo, '.nvmrc'), 'utf8').trim();
  const dockerfile = fs.readFileSync(path.join(repo, 'Dockerfile'), 'utf8');
  const deploy = fs.readFileSync(path.join(repo, 'deploy.sh'), 'utf8');
  const dockerNode = /node:(\d+\.\d+\.\d+)-bookworm-slim/.exec(dockerfile)?.[1];
  const deployNode = /QQ_AGENT_NODE_VERSION:-(\d+\.\d+\.\d+)/.exec(deploy)?.[1];
  assert.equal(dockerNode, nvm, 'Dockerfile 基础镜像 Node 版本要与 .nvmrc 一致');
  assert.equal(deployNode, nvm, 'deploy.sh 默认 Node 版本要与 .nvmrc 一致');
  for (const doc of ['docs/BAOTA.md', 'docs/DOCKER.md']) {
    const text = fs.readFileSync(path.join(repo, doc), 'utf8');
    assert.doesNotMatch(text, /22\.23\.2/, `${doc} 还写着旧 Node 版本`);
  }
});
