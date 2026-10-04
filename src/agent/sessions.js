/**
 * Agent 会话存储（纯逻辑 + IO 注入）。
 *
 * 键布局（browser.storage.local，与 config.js 同一套 IO 形态）：
 *   agent_session_index        轻量索引 [{id, workflowId, title, status, ...}]
 *   agent_session_<id>         完整会话 {events, ...}，索引里不带 events，
 *                              列表渲染不用把全部历史拉进内存
 *
 * 事件历史直接存 agent 事件（AGENT_EVENTS 系列）：UI 渲染与 wire 现算
 * 用的是同一份，单源不重复记账（loop.js 顶部不变式）。
 * 用户消息以 agent:user-message 事件入史，翻轮边界就是它。
 */

import { AGENT_EVENTS } from './events';
import { truncateTitle } from './title';

export const SESSION_INDEX_KEY = 'agent_session_index';

export const sessionStorageKey = (id) => `agent_session_${id}`;

/** 存储里最多保留多少个用户轮次（wire 层另有 token 预算，这里是存储体积上限） */
export const MAX_SESSION_TURNS = 20;

/**
 * 生成会话 id。crypto.randomUUID 在扩展页面与 node --test 里都有；
 * 万一都没有，退回时间戳 + 随机数（只要进程内唯一即可）。
 *
 * @returns {string}
 */
export function createSessionId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `s_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

/**
 * 从事件历史里取会话标题：首条用户消息前缀。不调 LLM（pie 有 LLM 标题，P3 再说）。
 *
 * @param {Array<Object>} events
 * @returns {string} 空历史返回 ''
 */
export function titleFromEvents(events) {
  const first = (events || []).find(
    (ev) => ev && ev.kind === AGENT_EVENTS.USER_MESSAGE
  );
  if (!first || !first.text) return '';
  return truncateTitle(String(first.text).trim().replace(/\s+/g, ' '));
}

/**
 * 按用户轮次裁剪历史，保留最近 maxTurns 轮。
 *
 * 必须按整轮切（从某条 user-message 事件起）——从中间切会把一轮的
 * tool-result 和它的 tool-call 拆开，wire 配对净化也救不回语义。
 *
 * @param {Array<Object>} events
 * @param {number=} maxTurns
 * @returns {Array<Object>}
 */
export function cropToTurns(events, maxTurns = MAX_SESSION_TURNS) {
  const list = events || [];
  const turnStarts = [];
  list.forEach((ev, i) => {
    if (ev && ev.kind === AGENT_EVENTS.USER_MESSAGE) turnStarts.push(i);
  });
  if (turnStarts.length <= maxTurns) return list;
  return list.slice(turnStarts[turnStarts.length - maxTurns]);
}

/**
 * 会话 -> 索引条目。索引里绝不带 events，否则列表一次读就是全量历史。
 *
 * @param {Object} session
 * @returns {Object}
 */
export function indexEntryFromSession(session) {
  return {
    id: session.id,
    workflowId: session.workflowId,
    title: session.title || '',
    status: session.status || 'active',
    createdAt: session.createdAt,
    lastAccessedAt: session.lastAccessedAt || session.createdAt,
    messageCount: (session.events || []).length,
  };
}

/**
 * 会话下拉的选项文案：「标题 · 最后访问时间」。
 *
 * 放在这里而不是面板模板里，是因为这段拼装必须能被单测钉住 —— 面板是 SFC，
 * 本仓没有组件测试基建，写在模板里的展示逻辑等于测不到。
 *
 * 时间取 lastAccessedAt，没有就退回 createdAt；两个都没有（老索引条目）
 * 就只出标题，绝不拼出「 · 」这种半截分隔符。标题为空时用调用方给的兜底文案
 * （文案由面板翻译，这个模块不认识 i18n）。
 *
 * @param {Object|null} entry listIndex 的一条
 * @param {string=} untitledText 标题为空时的兜底文案
 * @returns {string}
 */
export function sessionOptionLabel(entry, untitledText = '') {
  const title = String((entry && entry.title) || untitledText || '').trim();
  const ts = (entry && (entry.lastAccessedAt || entry.createdAt)) || 0;
  const at = new Date(Number(ts));

  if (!ts || Number.isNaN(at.getTime())) return title;

  const pad = (n) => String(n).padStart(2, '0');
  const time =
    pad(at.getMonth() + 1) +
    '-' +
    pad(at.getDate()) +
    ' ' +
    pad(at.getHours()) +
    ':' +
    pad(at.getMinutes());

  return title ? `${title} · ${time}` : time;
}

/**
 * 会话仓库。io 形态与 configIO 一致：{ get, set, remove }，值走 JSON。
 *
 * @param {{get: Function, set: Function, remove: Function}} io
 */
export function createSessionStore(io) {
  async function readIndex() {
    const list = (await io.get(SESSION_INDEX_KEY)) || [];
    return Array.isArray(list) ? list : [];
  }

  async function writeIndex(list) {
    await io.set(SESSION_INDEX_KEY, list);
  }

  return {
    /**
     * 索引列表，lastAccessedAt 降序。
     * @param {string=} workflowId 传了就只返回该工作流的会话
     */
    async listIndex(workflowId) {
      const list = await readIndex();
      const filtered = workflowId
        ? list.filter((e) => e.workflowId === workflowId)
        : list;
      return filtered.sort(
        (a, b) => (b.lastAccessedAt || 0) - (a.lastAccessedAt || 0)
      );
    },

    /**
     * 读完整会话（含 events）。不存在返回 null。
     * @param {string} id
     */
    async load(id) {
      if (!id) return null;
      return (await io.get(sessionStorageKey(id))) || null;
    },

    /**
     * 保存会话并同步索引条目（一次 save 两个 key，索引不带 events）。
     * @param {Object} session
     */
    async save(session) {
      const clean = {
        ...session,
        events: cropToTurns(session.events || []),
        title: session.title || titleFromEvents(session.events),
        lastAccessedAt: session.lastAccessedAt || Date.now(),
      };

      await io.set(sessionStorageKey(clean.id), clean);

      const index = await readIndex();
      const entry = indexEntryFromSession(clean);
      const idx = index.findIndex((e) => e.id === clean.id);
      if (idx === -1) index.push(entry);
      else index[idx] = entry;
      await writeIndex(index);

      return clean;
    },

    /**
     * 删除会话（索引 + 本体）。返回删除前的本体，调用方可据此判断删的是否当前会话。
     * @param {string} id
     */
    async remove(id) {
      const removed = await this.load(id);
      await io.remove(sessionStorageKey(id));
      await writeIndex((await readIndex()).filter((e) => e.id !== id));
      return removed;
    },
  };
}
