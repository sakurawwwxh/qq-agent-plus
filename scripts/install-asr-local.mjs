// 一条命令装好本机语音转写：构建 whisper.cpp + 下模型，默认落到 <数据目录>/asr/。
//   node scripts/install-asr-local.mjs                 # 默认 small 模型（中文够用），自动写回配置
//   node scripts/install-asr-local.mjs --model base    # 小机器/省流量可以退到 base（中文质量会差些）
//   node scripts/install-asr-local.mjs --mirror https://huggingface.co   # 换模型源（默认国内镜像）
//   node scripts/install-asr-local.mjs --print-only    # 只打印要做的事，不下载不构建
// 为什么要有这个脚本：本机转写是"零 Key 的默认方案"，但模型与二进制没法塞进仓库，
// 装一次就没后面的事了（离线、无按量费用、音频不出机器）。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_URL = 'https://github.com/ggml-org/whisper.cpp.git';

/** 模型源：默认 hf-mirror（国内可直连），失败自动回退官方 HF。两者路径结构一致。 */
export const MODEL_MIRRORS = ['https://hf-mirror.com', 'https://huggingface.co'];

/** 可选模型与大致体积（whisper.cpp 官方 ggml 仓库里的文件名就是这些）。 */
export const MODEL_CHOICES = {
  tiny: { file: 'ggml-tiny.bin', mb: 75 },
  base: { file: 'ggml-base.bin', mb: 142 },
  small: { file: 'ggml-small.bin', mb: 466 }
};

/** 拼模型的下载地址（导出仅供测试）。 */
export function modelUrl(mirror, model) {
  const choice = MODEL_CHOICES[model] || MODEL_CHOICES.small;
  return `${String(mirror).replace(/\/+$/, '')}/ggerganov/whisper.cpp/resolve/main/${choice.file}`;
}

/** 解析命令行（导出仅供测试）：坏参数要报清楚，别默默用默认值。 */
export function parseArgs(argv = []) {
  const out = { model: 'small', mirror: '', dataDir: process.env.QQ_AGENT_DATA_DIR || path.join(ROOT, 'data'), writeConfig: true, printOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少取值`);
      i += 1;
      return value;
    };
    if (arg === '--model') out.model = next();
    else if (arg === '--mirror') out.mirror = next();
    else if (arg === '--data-dir') out.dataDir = path.resolve(next());
    else if (arg === '--write-config') out.writeConfig = true;
    else if (arg === '--no-write-config') out.writeConfig = false;
    else if (arg === '--print-only') out.printOnly = true;
    else if (arg === '-h' || arg === '--help') out.help = true;
    else throw new Error(`未知参数：${arg}`);
  }
  if (!MODEL_CHOICES[out.model]) {
    throw new Error(`不认识的模型：${out.model}（可选：${Object.keys(MODEL_CHOICES).join(' / ')}）`);
  }
  return out;
}

function run(cmd, args, { cwd = ROOT, allowFail = false, quiet = false } = {}) {
  const res = spawnSync(cmd, args, { cwd, stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit', encoding: 'utf8' });
  if (res.error) {
    if (allowFail) return { ok: false, error: res.error.message };
    throw new Error(`执行 ${cmd} 失败：${res.error.message}`);
  }
  if (res.status !== 0 && !allowFail) throw new Error(`${cmd} ${args.join(' ')} 退出码 ${res.status}`);
  return { ok: res.status === 0, status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

const CR = String.fromCharCode(13);   // 行内进度用的回车（写成常量，免得转义被工具链吞掉）

const has = (cmd) => {
  const probe = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
  return !probe.error;
};

/** 下载（流式写盘 + 背压 + 出错兜底 + 单次超时），失败会清掉半截文件。 */
async function download(url, dest) {
  const tmp = `${dest}.part`;
  let file = null;
  try {
    // 单次请求超时：镜像站挂起时不能永远等（否则镜像轮换形同虚设）
    const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length') || 0);
    file = fs.createWriteStream(tmp);
    // 磁盘满/断流要能中断下载，而不是变成 unhandled 'error' 把进程打崩
    const failed = new Promise((_, reject) => file.on('error', reject));
    let written = 0;
    let lastLog = 0;
    for await (const chunk of res.body) {
      if (!file.write(chunk)) await Promise.race([new Promise((r) => file.once('drain', r)), failed]);
      written += chunk.length;
      if (Date.now() - lastLog > 2000) {
        lastLog = Date.now();
        const pct = total ? ` ${(written / total * 100).toFixed(1)}%` : '';
        process.stdout.write(CR + `  下载中 ${(written / 1048576).toFixed(1)}MB${pct}   `);
      }
    }
    await new Promise((resolve, reject) => { file.end(resolve); file.on('error', reject); });
    if (!written) throw new Error('下载到 0 字节');
    fs.renameSync(tmp, dest);
    process.stdout.write(CR + '     ');
    return written;
  } catch (error) {
    try { file?.destroy(); } catch { /* 关不掉就随进程退出 */ }
    try { fs.rmSync(tmp, { force: true }); } catch { /* 清不掉无害 */ }
    throw error;
  }
}

export function writeConfigPointers(configFile, bin, model) {
  const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  raw.asr = { ...(raw.asr || {}), enabled: raw.asr?.enabled !== false, provider: 'local', localBin: bin, localModel: model };
  const tmp = `${configFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, configFile);
  try { fs.chmodSync(configFile, 0o600); } catch { /* 某些文件系统不支持，忽略 */ }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('用法：node scripts/install-asr-local.mjs [--model tiny|base|small] [--mirror <url>] [--data-dir <dir>] [--no-write-config] [--print-only]');
    return;
  }
  const target = path.join(opts.dataDir, 'asr');
  const srcDir = path.join(target, 'whisper.cpp');
  const binPath = path.join(srcDir, 'build', 'bin', 'whisper-cli');
  const choice = MODEL_CHOICES[opts.model];
  const modelPath = path.join(target, choice.file);
  const mirrors = opts.mirror ? [opts.mirror, ...MODEL_MIRRORS.filter((m) => m !== opts.mirror)] : MODEL_MIRRORS;

  console.log(`本机语音转写安装：模型 ${opts.model}（约 ${choice.mb}MB）→ ${target}`);
  if (opts.printOnly) {
    console.log('  [print-only] 会构建 whisper.cpp：', srcDir);
    console.log('  [print-only] 二进制预期落在：', binPath);
    console.log('  [print-only] 会下载模型：', mirrors.map((m) => modelUrl(m, opts.model)).join(' 或 '));
    return;
  }

  // 1) 已构建过就跳过构建 —— 这时也不该因为"没装 cmake"拦住纯下模型的路径
  if (fs.existsSync(binPath)) {
    console.log(`· 二进制已存在，跳过构建：${binPath}`);
  } else {
    const missing = ['git', 'cmake', 'make', 'c++'].filter((cmd) => !has(cmd));
    if (missing.length) {
      throw new Error(`缺少构建工具：${missing.join(' / ')}。Ubuntu/Debian 上：`
        + 'sudo apt-get update && sudo apt-get install -y git cmake make g++   '
        + '（装不了也可以把「识别服务」换成火山或 OpenAI 兼容服务，不用本机转写）');
    }
    if (!fs.existsSync(srcDir)) {
      console.log('· 拉取 whisper.cpp 源码…');
      run('git', ['clone', '--depth', '1', REPO_URL, srcDir]);
    } else {
      console.log('· 源码已在，直接用');
    }
    console.log('· 构建（首次约几分钟，小机器更久）…');
    run('cmake', ['-B', 'build', '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_SHARED_LIBS=OFF', '-DWHISPER_BUILD_TESTS=OFF', '-DWHISPER_BUILD_EXAMPLES=ON'], { cwd: srcDir });
    run('cmake', ['--build', 'build', '--config', 'Release', '-j', String(Math.max(1, (process.env.NUMBER_OF_PROCESSORS || 2) | 0))], { cwd: srcDir });
  }
  if (!fs.existsSync(binPath)) throw new Error(`构建完成但没找到 ${binPath}（whisper.cpp 的输出路径可能变了）`);

  // 3) 下模型（镜像逐个试；已存在就跳过）
  if (fs.existsSync(modelPath)) {
    console.log(`· 模型已存在，跳过下载：${modelPath}`);
  } else {
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    let lastError = null;
    for (const mirror of mirrors) {
      try {
        console.log(`· 下载模型（${mirror}）…`);
        const bytes = await download(modelUrl(mirror, opts.model), modelPath);
        console.log(`  完成：${(bytes / 1048576).toFixed(1)}MB`);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        console.warn(`  这个源不行（${String(error?.message ?? error)}），换下一个`);
      }
    }
    if (lastError) throw new Error(`模型下载失败：${String(lastError?.message ?? lastError)}；可以用 --mirror 指定别的源`);
  }

  // 4) 写回配置（默认开；--no-write-config 只打印）
  if (opts.writeConfig) {
    const configFile = path.join(opts.dataDir, 'config.json');
    if (fs.existsSync(configFile)) {
      writeConfigPointers(configFile, binPath, modelPath);
      console.log(`· 已写进配置：${configFile}（asr.provider=local，二进制与模型路径已填好）`);
    } else {
      console.log(`· 还没生成配置（${configFile} 不存在），请把这两项填进控制台「设置 → 语音转文字」：`);
      console.log(`   可执行文件：${binPath}`);
      console.log(`   模型文件：  ${modelPath}`);
    }
  } else {
    console.log('· 未写配置（--no-write-config）。请把这两项填进控制台「设置 → 语音转文字」：');
    console.log(`   可执行文件：${binPath}`);
    console.log(`   模型文件：  ${modelPath}`);
  }
  console.log('· 装好了。控制台「设置 → 语音转文字」里识别服务选「本机 whisper.cpp」即生效（不用重启）。');
}

// 只在直接运行时执行（被测试 import 时不跑）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`\n安装失败：${String(error?.message ?? error)}`);
    process.exit(1);
  });
}
