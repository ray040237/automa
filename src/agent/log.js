/**
 * agent 全链路日志（纯模块，无浏览器依赖）。
 *
 * 为什么要有它：排查「卡住 / 参数为空 / 观察值异常」时，现场只在内存里
 * （转中不落盘，backlog T-34），控制台又只会一句错误都没有 —— 无限 await
 * 不抛错。这份日志做两件事：
 *
 *  1. 控制台一行一条，统一 `[agent]` 前缀，DevTools 里按前缀过滤就能看到
 *     整轮的时间线（turn / step / tool / confirm / budget / channel）；
 *  2. 环形缓冲留存最近 N 条 —— 页面卡死时来不及翻控制台，刷新前还能从
 *     `window.__agentLogs`（装配层挂载）把现场导出来。
 *
 * sink 可注入：单测传桩对象，不往测试输出里刷屏。
 * 事件命名用点分（tool.call / tool.result / channel.send…），稳定可断言。
 */

/**
 * 创建日志器。
 *
 * @param {Object=} opts
 * @param {Object=} opts.sink 有 info/warn/error 方法的对象，默认 console
 * @param {number=} opts.ringSize 环形缓冲容量，默认 1000 条
 * @param {() => number=} opts.now 时间戳来源，默认 Date.now
 * @returns {(event: string, data?: Object) => void} 日志函数，附加
 *   .warn / .error（降级通道）、.ring（缓冲，最新在尾）、.has（测试断言用）
 */
export function createAgentLog({
  sink = console,
  ringSize = 1000,
  now = () => Date.now(),
} = {}) {
  const ring = [];

  function write(level, event, data) {
    const entry = { t: now(), level, event };
    if (data !== undefined) entry.data = data;

    ring.push(entry);
    if (ring.length > ringSize) ring.shift();

    const fn =
      typeof sink[level] === 'function' ? sink[level] : sink.info || (() => {});
    if (data === undefined) fn.call(sink, '[agent] ' + event);
    else fn.call(sink, '[agent] ' + event, data);

    return entry;
  }

  const log = (event, data) => write('info', event, data);
  log.warn = (event, data) => write('warn', event, data);
  log.error = (event, data) => write('error', event, data);
  log.ring = ring;
  log.has = (event) => ring.some((e) => e.event === event);

  return log;
}

/**
 * 什么都不做的日志 —— loop 等纯模块的默认值，测试与未接日志的调用方
 * 拿到的是它，零输出零开销。形状与 createAgentLog 的返回值一致。
 */
const noop = () => {};
noop.warn = noop;
noop.error = noop;
noop.ring = [];
noop.has = () => false;

export const noopLog = noop;
