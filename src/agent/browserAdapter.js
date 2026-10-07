/**
 * 浏览器通道 adapter：工具 → background、读目标页、帧合并（T-126 第二步）。
 *
 * 从 `index.js` 抽出来的。抽它的理由不是「文件太长」这种审美问题，而是它
 * 自成一类：这一段只依赖 `webextension-polyfill` 与 `raceTimeout`，**不碰
 * agent 的任何内部状态**。留在 `index.js` 里它没法单独测，只能靠
 * `assembly.test.js` 读 `index.js` 的源码文本、用正则匹配来间接验证 ——
 * 改变量名就红，不改语义也红。
 *
 * **为什么超时常量必须跟着走**：CONTEXT.md 定的「外层大于内层」是
 *   页内执行 10s ≤ 页内执行通道 15s ≤ tabs 通道 15s < background 通道 20s
 * 这个大小关系**只有同一个模块持有才守得住** —— 拆散之后每条通道各自写一个
 * 数字，就再也没人能一眼看出谁大谁小。`index.test.js` 有一组断言钉这个关系，
 * 它跨文件读 `agentEvalInPage.js` 与 `src/background/index.js` 的常量，正是
 * 因为这个关系本就该被一起看。
 *
 * 不变式：本模块只 import 浏览器 polyfill、`@/utils/message`（background
 * 通道）、`./log`（拿 `agentLog`）与 `./agentEvalInPage`（拿 `raceTimeout`）。
 * **不 import `@/agent` 里的任何东西**（否则与装配层成环），也不碰
 * `workflowStore.update`（G5 红线）。
 */

import browser from 'webextension-polyfill';
import { sendMessage as backgroundSend } from '@/utils/message';

import { agentLog } from './log';
import { raceTimeout } from './agentEvalInPage';
/**
 * runtime 通道（background）的发送侧硬超时。
 *
 * background 自己有 15s 的页内执行兜底（T-30），但那层在 background **内部**：
 * 若 SW 被回收 / 消息回程丢了，发送方的 promise 永不 settle，没有任何一层
 * 能救 —— 用户真机日志里 `channel.send` 之后既无 `channel.reply` 也无
 * `channel.fail`，整轮 agent 就挂死在那里（T-39；本机 t40-probe 三层全通，
 * 差异只剩真机的回程）。这里是最后一层，必须大于 background 的 15s，
 * 正常回程一定先到。
 */
export const BACKGROUND_CHANNEL_TIMEOUT_MS = 20000;

/**
 * 工具 → background 的唯一通道。
 *
 * 工具侧约定发 `{type, ...params}`，background 侧的 MessageListener 只认
 * `{name: 'background--<type>', data: params}` —— 两个协议在这是唯一交汇点。
 * 导出是为了让测试能拿真实 MessageListener 验路由（backlog T-28：协议对不上时
 * 报的是一句指不到真因的 Unhandled Background Error，只能靠契约测试钉住）。
 *
 * 整个 round trip 套了硬超时（T-39）：超时不 reject 而是回 `{ok:false, error}`
 * 的观察值形状，工具照常把它喂回模型 —— 通道慢/断不再等于「这轮卡死」。
 * 真正的 send 失败（如端口不存在）仍照旧 reject 走 channel.fail。
 *
 * @param {{type: string} & Object} msg
 * @param {{timeoutMs?: number}=} options timeoutMs 供测试缩短（默认 20s）
 * @returns {Promise<Object>}
 */
export function toBackground(msg, options = {}) {
  const { type, ...payload } = msg || {};
  const timeoutMs = options.timeoutMs || BACKGROUND_CHANNEL_TIMEOUT_MS;
  const startedAt = Date.now();

  agentLog('channel.send', { type });

  const roundTrip = raceTimeout(
    backgroundSend(type, payload, 'background'),
    timeoutMs,
    {
      ok: false,
      __timeout: true,
      // 模型需要知道「到底执没执行」——如实说不确定，并给下一步动作，
      // 否则它会原地重复同一调用（T-33 的教训）。
      error:
        `background 通道无响应（${Math.round(
          timeoutMs / 1000
        )}s 无应答）：这一步是否已执行无法确认` +
        '（background 可能被浏览器回收了）。请先用 read_page 看一眼当前' +
        '页面状态再决定要不要重试，不要直接重复同一调用。',
    }
  );

  return roundTrip.then(
    (res) => {
      const ms = Date.now() - startedAt;

      if (res && res.__timeout) {
        agentLog.error('channel.timeout', { type, ms, timeoutMs });

        const rest = { ...res };
        delete rest.__timeout; // 内部标记不进观察值
        return rest;
      }

      agentLog('channel.reply', {
        type,
        ok: Boolean(res && res.ok),
        error: res && res.error,
        ms,
      });
      return res;
    },
    (err) => {
      agentLog.error('channel.fail', {
        type,
        message: err && err.message ? err.message : String(err),
        ms: Date.now() - startedAt,
      });
      throw err;
    }
  );
}

/**
 * tabs 消息通道的硬超时。
 *
 * 目标页主线程被注入代码占死时（test_js 的死循环/alert），同进程的
 * content script 无法应答，tabs.sendMessage 的 promise 永不 settle ——
 * executeScript 通道有 raceTimeout 兜底（background 侧 T-30），这条通道
 * 没有的话整轮 agent 就挂死在下一步的 probe / read_page 上（T-33，
 * 已在 t33-probe.mjs 实测复现：占死后 read_page 15s 仍无回应）。
 */
export const TAB_CHANNEL_TIMEOUT_MS = 15000;

/**
 * 读目标页 / 页内找文本。通过 content script 通道拿结构化观察值。
 *
 * 失败时回一句人话而不是抛异常：工具异常会被 loop 转成 error 观察值喂回模型，
 * 模型能据此换一种参数重试；把栈抛上去只会让它原地打转。
 *
 * @param {Object} tab
 * @param {{detail?: string, maxChars?: number, op?: string, keyword?: string, limit?: number}|string} params
 *   传字符串时按 detail 处理（兼容旧调用点）
 * @returns {Promise<string|{text: string, fingerprint: (string|null)}>}
 */
export async function readPageFromTab(tab, params) {
  const options =
    typeof params === 'string' ? { detail: params } : params || {};

  if (!tab) return '没有确定目标页。请先让用户选一个标签页。';

  const timeoutMs = options.timeoutMs || TAB_CHANNEL_TIMEOUT_MS;
  const detail = options.detail || 'addresses';
  // frame 默认 'all'：top + 所有 iframe 一起读（T-115 拍板）。
  // 只想顶层用 frame:'top'；想指定 frame 传 frameId（数字字符串）。
  const frame = options.frame || 'all';

  let frameIds;
  try {
    if (frame === 'top') {
      frameIds = [0];
    } else if (frame === 'all') {
      const frames = await browser.webNavigation.getAllFrames({
        tabId: tab.id,
      });
      frameIds = (frames && frames.length ? frames : [{ frameId: 0 }]).map(
        (f) => f.frameId
      );
    } else {
      const n = Number(frame);
      frameIds = Number.isFinite(n) ? [n] : [0];
    }
  } catch (e) {
    frameIds = [0];
  }
  if (!Array.isArray(frameIds) || frameIds.length === 0) frameIds = [0];

  // 预算按 frame 数均分，但不低于 400（下限，低于它连骨架都装不下）。
  const total = options.maxChars || 6000;
  const per =
    frameIds.length > 1
      ? Math.max(400, Math.floor(total / frameIds.length))
      : options.maxChars;

  const results = [];
  for (const fid of frameIds) {
    const res = await readOneFrame(
      tab,
      { ...options, detail, maxChars: per },
      fid,
      timeoutMs
    );
    results.push({ fid, res });
  }

  return mergeFrameReads(results, detail);
}

// 单 frame 的消息往返 + 超时/错误处理（原 readPageFromTab 的本体）。
async function readOneFrame(tab, options, frameId, timeoutMs) {
  try {
    const res = await raceTimeout(
      browser.tabs.sendMessage(
        tab.id,
        {
          type: 'agent:read-page',
          op: options.op || 'read',
          detail: options.detail,
          maxChars: options.maxChars,
          keyword: options.keyword,
          limit: options.limit,
        },
        { frameId }
      ),
      timeoutMs,
      {
        __timeout: true,
      }
    );

    // 页面无应答 ≠ 通道坏了：八成是之前注入的代码把页面占死了。
    // 必须给模型一句能行动的话（换页/让用户刷新），否则它会原地反复重试。
    if (res && res.__timeout) {
      agentLog.warn('page.timeout', { tabId: tab.id, timeoutMs });
      return (
        '页面无响应（' +
        Math.round(timeoutMs / 1000) +
        's 无应答）：页面可能被之前注入的代码占死了。请停止对本页的读页和执行操作，' +
        '让用户手动刷新或关闭该页，或用 focus_tab 换一个标签页。'
      );
    }

    // content 侧读页返回 {text, fingerprint}；指纹必须原样带回来 ——
    // 它是「页面变没变」的唯一判据，塞进文本会被陈旧快照剔除抹掉（设计稿 §6.2）
    if (res && typeof res === 'object' && typeof res.text === 'string') {
      agentLog('page.read', {
        tabId: tab.id,
        detail: options.detail || options.op || 'read',
        chars: res.text.length,
        fingerprint: res.fingerprint || null,
      });
      return { text: res.text, fingerprint: res.fingerprint || null };
    }

    if (typeof res === 'string' && res) {
      agentLog.warn('page.read.odd', { tabId: tab.id, res: res.slice(0, 80) });
      return res;
    }

    return (
      '这个页面读不到结构。常见原因：页面尚未加载完；这是一个扩展内置页' +
      '（chrome:// 与扩展自己的页面都没有注入 content script）；或站点未授予扩展权限。'
    );
  } catch (err) {
    agentLog.warn('page.read.fail', {
      tabId: tab.id,
      message: err && err.message ? err.message : String(err),
    });
    return (
      '读取目标页失败：' +
      (err && err.message ? err.message : String(err)) +
      '多半是该标签页没有注入 content script（扩展页、chrome:// 内置页、或还没加载完）。'
    );
  }
}

// 从 probe 的 <page> 头与「## 概览」提取一句话摘要（C'：让模型知道 iframe 里有什么）。
function probeSummary(text) {
  const url = (text.match(/<page url="([^"]*)"/) || [])[1] || '';
  const title = (text.match(/title="([^"]*)"/) || [])[1] || '';
  const n = (text.match(/可操作元素 (\d+) 个/) || [])[1];
  return { url, title, interactive: n != null ? n : '?' };
}

// 合并多 frame 的读页结果：
//  - probe：顶层 text 为主体，</page> 前追加每个 frame 的一句话摘要（## frames）
//  - addresses/content/full：顶层 text 为主体，</page> 前顺序拼每个 iframe 的正文段
// 指纹一律取顶层 frameId=0 的。
function mergeFrameReads(results, detail) {
  const top = results.find((r) => r.fid === 0) || results[0];
  const topRes = top && typeof top.res === 'object' ? top.res : null;

  if (results.length === 1) {
    if (topRes && typeof topRes.text === 'string')
      return { text: topRes.text, fingerprint: topRes.fingerprint || null };
    return top ? top.res : '';
  }

  const topText =
    topRes && typeof topRes.text === 'string'
      ? topRes.text
      : String(top && top.res);
  const fingerprint = topRes && topRes.fingerprint ? topRes.fingerprint : null;

  if (detail === 'probe') {
    const lines = ['## frames（top + iframe）'];
    for (const r of results) {
      const t =
        r.res && typeof r.res === 'object' && typeof r.res.text === 'string'
          ? r.res.text
          : '';
      const s = probeSummary(t);
      lines.push(
        (r.fid === 0 ? '  - top' : '  - iframe[frameId=' + r.fid + ']') +
          ': ' +
          (s.url || '(无 url)') +
          ' title="' +
          s.title +
          '" 可操作元素 ' +
          s.interactive +
          ' 个'
      );
    }
    // 顶层 text 的 </page> 前插入 ## frames
    const idx = topText.lastIndexOf('</page>');
    const body = idx >= 0 ? topText.slice(0, idx) : topText;
    return { text: body + lines.join('\n') + '\n</page>', fingerprint };
  }

  // addresses / content / full：拼各 frame 的段
  const parts = [];
  const topIdx = topText.lastIndexOf('</page>');
  parts.push(topIdx >= 0 ? topText.slice(0, topIdx) : topText);

  for (const r of results) {
    if (r.fid === 0) continue;
    const t =
      r.res && typeof r.res === 'object' && typeof r.res.text === 'string'
        ? r.res.text
        : '';
    if (!t) continue;
    // 去掉 <page ...> 头，保留段体
    const headEnd = t.indexOf('>');
    let body = headEnd >= 0 ? t.slice(headEnd + 1) : t;
    const endIdx = body.lastIndexOf('</page>');
    if (endIdx >= 0) body = body.slice(0, endIdx);
    const url = (t.match(/<page url="([^"]*)"/) || [])[1] || '';
    parts.push(
      '\n## iframe（frameId=' +
        r.fid +
        '）' +
        (url ? ' url="' + url + '"' : '') +
        '\n' +
        body.trim() +
        '\n'
    );
  }

  parts.push('</page>');
  return { text: parts.join('\n'), fingerprint };
}
