/**
 * 装配层：read_page 工具闭环（原 live-assembly [2]）。
 *
 * 与 `agent/tool-loop` 的区别：这里 `read_page` 真的走
 * `browser.tabs.sendMessage` 打到假 content script（假浏览器在内存里
 * 同时管多个标签页），并复用 `window.js` 的全字段裁剪、`facts.js` 的真实任务收集、
 * 以及 `browser.tabs.get` 驱动的 preStepNotice 目标页校验。
 *
 * 最要紧的断言仍是 `untrusted_page_content` 包装（AGENTS.md 红线）。
 */
import {
  AGENT_EVENTS,
  TOOL_STATUS,
  textOf,
  toolResultsOf,
} from '../harness.mjs';
import { PAGE_TEXT, TABS } from './assembly-chat.mjs';

export default {
  id: 'assembly/tool-page',
  title: '装配层：read_page 闭环（真 content script 桩文本）',
  layer: 'assembly',
  async run({ configDoc, setupAssembly, check, skipIfRateLimited }) {
    const a = await setupAssembly({ doc: configDoc, tabs: TABS, pageText: PAGE_TEXT });
    const runtime = a.makeRuntime();
    const events = [];

    let ret;

    try {
      ret = await runtime.send({
        userText:
          '先调用 read_page 看一眼目标页，然后告诉我页面上有几个「加入购物车」按钮。不要编造。',
        onEvent: (e) => events.push(e),
      });
    } catch (err) {
      check.hard(false, `send 抛异常: ${err && err.stack}`);

      return;
    }

    if (skipIfRateLimited(check, ret)) return;

    if (ret.kind === AGENT_EVENTS.ERROR) {
      check.hard(false, `错误收尾: ${ret.message} (status=${ret.httpStatus})`);

      return;
    }

    const calls = events.filter(
      (e) => e.kind === AGENT_EVENTS.TOOL_CALL && e.status === TOOL_STATUS.RUNNING
    );
    const results = toolResultsOf(events);
    const text = textOf(events).trim();

    if (calls.length === 0) {
      check.hard(false, `模型没调工具。回答: ${text.slice(0, 150)}`);

      return;
    }

    if (results.length === 0) {
      check.hard(false, `有调用但没有结果。ret=${JSON.stringify(ret)}`);

      return;
    }

    const notOk = results.find((r) => r.status !== TOOL_STATUS.OK);

    if (notOk) {
      check.hard(
        false,
        `工具结果异常(${notOk.status}): ${String(notOk.observation).slice(0, 300)}`
      );

      return;
    }

    check.hard(
      String(results[0].observation).includes('<untrusted_page_content>'),
      'page 组结果没走 untrusted_page_content'
    );
    check.hard(
      ret.kind === AGENT_EVENTS.DONE,
      `未正常收尾: ${JSON.stringify(ret)}`
    );
    check.soft(Boolean(text), '工具跑完但没给用户文本');
  },
};