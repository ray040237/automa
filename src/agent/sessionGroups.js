/**
 * 会话历史的分组与展示（T-167）：按自然日分组、相对时刻、按标题搜索。
 *
 * 为什么从 `.vue` 里抽出来（与 sessions.js / usage.js 同一条理由）：本仓没有
 * 组件测试基建，写在模板里的分支一条都测不到。而这套判定的边界恰恰是**肉眼
 * 分不出对错**的：跨天、跨年、时间戳缺失、空列表 —— 界面上都是「出现在某个
 * 分组里」而已。
 *
 * 一个硬约束（决定了搜索能做什么）：会话**索引条目不含 events**
 * （`sessions.js` 的 indexEntryFromSession 刻意不带，否则列表一次读就是全量
 * 历史），`title` 是首条用户消息的前缀、被截到 24 字符（`title.js`）。
 * 所以这里的搜索**只能匹配标题，搜不到正文** —— 不是设计选择，是数据结构的
 * 边界。UI 上要如实说明，别假装它是全文搜索。
 *
 * 时刻与日期只出**结构**（分组 + 时 + 日），不出拼好的句子：拼句子要用到
 * 「昨天」这种词，它归 i18n，不归本文件。
 */

export const GROUP_TODAY = 'today';
export const GROUP_YESTERDAY = 'yesterday';
export const GROUP_EARLIER = 'earlier';

const DAY_MS = 24 * 60 * 60 * 1000;

const pad = (n) => String(n).padStart(2, '0');

/** 当天 00:00 的时间戳（按**自然日**切，不是按 24 小时滑窗）。 */
function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);

  return d.getTime();
}

/**
 * 某个时刻属于哪个分组。**纯函数**。
 *
 * 按自然日而不是「距今 24 小时」：昨晚 23:50 的会话，今天早上 09:00 看，
 * 用户心里它是「昨天的」，虽然只隔了 9 小时。
 *
 * 时间戳缺失（老索引条目、脏数据）一律归 `earlier` —— 它们是**最不可能**
 * 属于今天的那一类，归到 yesterday 会让人以为刚聊过。
 *
 * @param {number} ts 毫秒时间戳（lastAccessedAt / createdAt）
 * @param {number} now 当前时刻，由调用方注入（便于单测钉住）
 * @returns {'today'|'yesterday'|'earlier'}
 */
export function dayGroupOf(ts, now) {
  const t = Number(ts);
  const n = Number(now);

  if (!Number.isFinite(t) || t <= 0) return GROUP_EARLIER;
  // now 拿不到（调用方传了空）时同样退到 earliest：不敢猜「今天」
  if (!Number.isFinite(n) || n <= 0) return GROUP_EARLIER;

  const diff = startOfDay(n) - startOfDay(t);
  if (diff === 0) return GROUP_TODAY;
  if (diff === DAY_MS) return GROUP_YESTERDAY;

  return GROUP_EARLIER;
}

/**
 * 时刻（HH:mm）。**纯函数**。拿不到合法时间返回空串（UI 隐藏它，不是显示 0）。
 *
 * @param {number} ts
 * @returns {string}
 */
export function clockOf(ts) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return '';

  const d = new Date(t);

  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 日期（MM-DD）。**纯函数**。
 *
 * 不带年份：会话是「最近在聊的」，年份在绝大多数情况下是噪声，而 320px 的侧栏
 * 里每多一个字符就少显示一个字。跨年那几天的代价（去年的 12-30 与今年的 12-30
 * 长得一样）由分组标题兜住 —— 它们都落在「更早」里，不会并列在今天/昨天旁边。
 *
 * @param {number} ts
 * @returns {string}
 */
export function dateOf(ts) {
  const t = Number(ts);
  if (!Number.isFinite(t) || t <= 0) return '';

  const d = new Date(t);

  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 按自然日分组。**纯函数**。
 *
 * 顺序沿用输入（listIndex 已按 lastAccessedAt 降序），组内保序 ——
 * 不在这里重排，免得和调用方的排序口径打架。
 *
 * **丢掉空分组**：否则界面上会剩下一串只有「今天」标题、下面什么都没有的组。
 *
 * @param {Array<Object>} entries 会话索引条目
 * @param {number} now 当前时刻
 * @returns {Array<{key: string, items: Object[]}>}
 */
export function groupSessionsByDay(entries, now) {
  const buckets = new Map();

  (entries || []).forEach((e) => {
    const ts = Number(e && (e.lastAccessedAt || e.createdAt)) || 0;
    const key = dayGroupOf(ts, now);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(e);
  });

  return [GROUP_TODAY, GROUP_YESTERDAY, GROUP_EARLIER]
    .filter((key) => buckets.has(key))
    .map((key) => ({ key, items: buckets.get(key) }));
}

/**
 * 按标题过滤会话。**纯函数**。
 *
 * 只匹配 `title`、大小写不敏感 —— 索引里没有正文可搜（见文件头）。
 * 空查询原样返回。
 *
 * @param {Array<Object>} entries
 * @param {string} query
 * @returns {Array<Object>}
 */
export function filterSessionsByTitle(entries, query) {
  const q = String(query || '')
    .trim()
    .toLowerCase();
  if (!q) return entries || [];

  return (entries || []).filter((e) =>
    String((e && e.title) || '')
      .toLowerCase()
      .includes(q)
  );
}
