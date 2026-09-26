// 实验功能：依赖感知工具调度。
//
// 这个模块故意不改 Orchestrator 的主循环：宿主仍按原顺序逐个调用 executeTool。
// 开关开启时，tools.js 包装器只会提前并行启动“连续且明确只读”的调用，
// 随后仍按原始 tool_call 顺序把结果交还宿主；发送/写入始终由宿主逐个触发。
// 这样关闭开关时可以完整回退到原来的 tools-core.js 路径。

// 可以安全预启动的纯读取工具：彼此独立时允许同一个 assistant tool_calls 批次并发。
export const EXPERIMENTAL_READ_ONLY_TOOLS = new Set([
  'get_recent_messages',
  'get_message_detail',
  'get_active_members',
  'memory_query',
  'person_memory_lookup',
  'web_search',
  'web_fetch'
]);

// 这些也是“读取/观察”类工具，但当前不做并发预启动：
// - get_*_image 会产生多模态注入；
// - read_forward 会把展开结果写回存档；
// - list_stickers / get_sticker_image 与后续表情选择通常存在直接依赖。
// 显式列出来，避免未来误以为“所有读工具都应该并发”。
export const EXPERIMENTAL_ORDERED_READ_TOOLS = new Set([
  'list_stickers',
  'get_sticker_image',
  'read_forward',
  'get_message_images',
  'get_message_audio'
]);

export const EXPERIMENTAL_TERMINAL_TOOL = 'finish';

// 这些工具的副作用必须保持宿主原有顺序，但当动作在模型调用前就已经全部确定时，
// 可以与 finish 放在同一个 assistant tool_calls 批次里；finish 的失败屏障保证前置失败时不提交。
export const EXPERIMENTAL_SAME_ROUND_ACTION_TOOLS = new Set([
  'send_message',
  'send_sticker',
  'send_face',
  'send_poke',
  'schedule_wake',
  'memory_append',
  'memory_remove',
  'collect_sticker',
  'sticker_note',
  'report_feedback',
  'friend_request_propose'
]);

export function experimentalToolSchedulerConfig(cfg = {}) {
  const raw = cfg?.toolSchedulerPilot || {};
  return {
    enabled: raw.enabled === true,
    maxParallelReads: Math.min(8, Math.max(2, Number(raw.maxParallelReads) || 4))
  };
}

export function experimentalToolSchedulerEnabled(cfg = {}) {
  return experimentalToolSchedulerConfig(cfg).enabled;
}

export function experimentalToolEffect(name) {
  const tool = String(name || '');
  if (tool === EXPERIMENTAL_TERMINAL_TOOL) return 'terminal';
  if (EXPERIMENTAL_READ_ONLY_TOOLS.has(tool)) return 'read';
  return 'ordered';
}

/**
 * 给当前基础工具集一个显式分类，主要用于测试/审计。
 * 新增工具如果没有被分类，测试会提醒维护者先决定它能否并发、能否同轮 finish，
 * 而不是默认把未知工具当成“可优化”。
 */
export function experimentalToolClass(name) {
  const tool = String(name || '');
  if (tool === EXPERIMENTAL_TERMINAL_TOOL) return 'terminal';
  if (EXPERIMENTAL_READ_ONLY_TOOLS.has(tool)) return 'parallel-read';
  if (EXPERIMENTAL_ORDERED_READ_TOOLS.has(tool)) return 'ordered-read';
  if (EXPERIMENTAL_SAME_ROUND_ACTION_TOOLS.has(tool)) return 'ordered-action';
  return 'unclassified';
}

const FINISH_STRONG_RULE = [
  '【实验调度·强规则】',
  '如果本轮所有要做的动作在看到工具结果前已经完全确定，必须在同一个 assistant 响应里一次性给出这些 tool_calls，并把 finish 放在最后。',
  '不要为了“确认发送成功”专门再开一轮只调用 finish；finish 有失败屏障，任一前置工具失败时系统会阻止 finish 提交并把错误交回你重新决定。',
  '只有某个工具结果会决定后续要不要做、做什么或说什么时，才保留下一轮模型调用。'
].join('');

const ACTION_STRONG_RULE = [
  '【实验调度·强规则】',
  '如果这个动作以及本轮其它动作在执行前都已确定，且不需要观察任何工具结果再决策，必须在本次响应中把这些动作一次性列出，并把 finish 作为最后一个 tool_call。',
  '不要先执行本工具、等成功结果回来后，再额外开一轮只调用 finish。',
  '如果后续动作确实依赖本工具返回值，则保持正常多轮。'
].join('');

const READ_PARALLEL_RULE = [
  '【实验调度·强规则】',
  '如果同一决策需要多个互不依赖的只读结果，必须在同一个 assistant 响应里一次性列出这些读取 tool_calls；不要等第一个返回后再调用第二个。',
  '只有后一个查询的参数、是否调用或后续动作确实依赖前一个结果时才串行。',
  '如果需要看完读取结果才能决定回复，不要提前调用 finish。'
].join('');

const ORDERED_READ_RULE = [
  '【实验调度】',
  '该读取工具当前保持宿主原有串行语义（可能注入图片、更新本地存档，或其结果通常直接影响下一步选择）。',
  '正常等待结果后再决定后续动作；不要为了凑并发而提前 finish。'
].join('');

/**
 * 只在实验开启时改工具描述，引导模型：
 * - 互不依赖的纯读取必须同轮给出，宿主会并发预启动；
 * - 已经完全确定的动作必须同轮把 finish 放在最后；
 * - 结果依赖型读取继续维持原串行决策链。
 *
 * 这里只改变模型看到的 schema 文案，不改变 Orchestrator 主循环、工具执行顺序、
 * handoff/生命周期提交方式。关闭实验时直接返回原数组引用，prompt hash 也回到旧版本。
 */
export function annotateExperimentalToolSchemas(tools, cfg = {}) {
  if (!experimentalToolSchedulerEnabled(cfg)) return tools;
  return (Array.isArray(tools) ? tools : []).map((tool) => {
    const next = structuredClone(tool);
    const fn = next?.function;
    const name = String(fn?.name || '');
    if (!fn) return next;
    if (name === EXPERIMENTAL_TERMINAL_TOOL) {
      fn.description = `${fn.description || ''} ${FINISH_STRONG_RULE}`;
    } else if (EXPERIMENTAL_READ_ONLY_TOOLS.has(name)) {
      fn.description = `${fn.description || ''} ${READ_PARALLEL_RULE}`;
    } else if (EXPERIMENTAL_ORDERED_READ_TOOLS.has(name)) {
      fn.description = `${fn.description || ''} ${ORDERED_READ_RULE}`;
    } else if (EXPERIMENTAL_SAME_ROUND_ACTION_TOOLS.has(name)) {
      fn.description = `${fn.description || ''} ${ACTION_STRONG_RULE}`;
    }
    return next;
  });
}

export function experimentalSkippedResult(message, errorCode) {
  return {
    content: `错误：${message}`,
    isError: true,
    errorCode,
    reportIncident: false,
    experimentalSkipped: true
  };
}

function callSignature(call, index = 0) {
  const fn = call?.function || {};
  return `${call?.id || index}:${String(fn.name || '')}:${String(fn.arguments ?? '{}')}`;
}

export function experimentalBatchKey(calls, round = 0) {
  return `${Number(round) || 0}|${(Array.isArray(calls) ? calls : [])
    .map((call, index) => callSignature(call, index)).join('|')}`;
}

function sameHostCall(call, name, argsRaw) {
  if (!call) return false;
  return String(call?.function?.name || '') === String(name || '')
    && String(call?.function?.arguments ?? '{}') === String(argsRaw ?? '{}');
}

/**
 * 一个 assistant tool_calls 批次对应一个协调器。
 * 宿主仍然按 index=0,1,2... 逐个来取结果；协调器只会把连续 read wave
 * 提前并行启动，绝不会提前执行发送或写入。
 */
export class ExperimentalToolBatch {
  constructor(calls, {
    execute,
    maxParallelReads = 4,
    onParallelWave = null
  } = {}) {
    if (typeof execute !== 'function') throw new TypeError('execute callback is required');
    this.calls = Array.isArray(calls) ? calls : [];
    this.execute = execute;
    this.maxParallelReads = Math.min(8, Math.max(2, Number(maxParallelReads) || 4));
    this.onParallelWave = typeof onParallelWave === 'function' ? onParallelWave : null;
    this.cursor = 0;
    this.pending = new Map();
    this.priorFailure = false;
    this.terminalSeen = false;
    this.invalid = false;
    this.parallelWaves = 0;
    this.parallelCalls = 0;
    this.finishBarrierBlocks = 0;
    this.trailingSkipped = 0;
  }

  #startReadWave(startIndex) {
    if (this.pending.has(startIndex)) return;
    const indexes = [];
    for (let i = startIndex; i < this.calls.length; i += 1) {
      if (experimentalToolEffect(this.calls[i]?.function?.name) !== 'read') break;
      indexes.push(i);
    }
    if (!indexes.length) return;

    const deferred = new Map();
    for (const index of indexes) {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      deferred.set(index, { resolve, reject });
      this.pending.set(index, promise);
    }

    if (indexes.length > 1) {
      this.parallelWaves += 1;
      this.parallelCalls += indexes.length;
      this.onParallelWave?.({
        size: indexes.length,
        names: indexes.map((index) => String(this.calls[index]?.function?.name || ''))
      });
    }

    let next = 0;
    const worker = async () => {
      while (next < indexes.length) {
        const local = next++;
        const index = indexes[local];
        try {
          deferred.get(index).resolve(await this.execute(this.calls[index], index));
        } catch (error) {
          deferred.get(index).reject(error);
        }
      }
    };
    const workers = Math.min(this.maxParallelReads, indexes.length);
    // Fire-and-cache：当前宿主调用会 await 自己对应的 promise；后面的结果先缓存。
    Promise.allSettled(Array.from({ length: workers }, () => worker())).catch(() => {});
  }

  /**
   * 宿主每次调用 executeTool 时调用一次。
   * 返回 { handled, result }。handled=false 表示批次追踪与宿主不一致，调用方应退回原串行执行。
   */
  async next(name, argsRaw) {
    if (this.invalid) return { handled: false, result: null };
    const index = this.cursor;
    const call = this.calls[index];
    if (!sameHostCall(call, name, argsRaw)) {
      this.invalid = true;
      return { handled: false, result: null };
    }
    this.cursor += 1;

    if (this.terminalSeen) {
      this.trailingSkipped += 1;
      return {
        handled: true,
        result: experimentalSkippedResult(
          '未执行：finish 已形成本轮终止边界，之后的工具不能再产生副作用。',
          'SKIPPED_AFTER_FINISH_BARRIER'
        )
      };
    }

    const effect = experimentalToolEffect(name);
    if (effect === 'read') {
      this.#startReadWave(index);
      const result = await this.pending.get(index);
      this.priorFailure ||= result?.isError === true;
      return { handled: true, result };
    }

    if (effect === 'terminal') {
      this.terminalSeen = true;
      if (this.priorFailure) {
        this.finishBarrierBlocks += 1;
        return {
          handled: true,
          result: experimentalSkippedResult(
            'finish 未执行：本轮前置工具有失败项，需要先查看错误并重新决定。',
            'FINISH_BARRIER_BLOCKED'
          )
        };
      }
      const result = await this.execute(call, index);
      this.priorFailure ||= result?.isError === true;
      return { handled: true, result };
    }

    // ordered 工具绝不提前执行；只有宿主真正遍历到这里时才执行。
    const result = await this.execute(call, index);
    this.priorFailure ||= result?.isError === true;
    return { handled: true, result };
  }

  metrics() {
    return {
      parallelWaves: this.parallelWaves,
      parallelCalls: this.parallelCalls,
      finishBarrierBlocks: this.finishBarrierBlocks,
      trailingSkipped: this.trailingSkipped
    };
  }
}
