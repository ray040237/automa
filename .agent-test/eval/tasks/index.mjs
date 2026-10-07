/**
 * eval 任务清单。
 *
 * 「固定任务集」的落点就是这里：顺序即执行顺序，`--only=<id>` 按 id 过滤。
 * 加一条任务 = 新建 `tasks/<名>.mjs`（default export 一个 `{id,title,layer,run}`）
 * + 在这里 import 并放进数组。
 *
 * 顺序原则：便宜的、无需模型的排前面（失败能立刻看到），打模型贵/易撞限流的排后面。
 */
import assemblyConfig from './assembly-config.mjs';
import agentError401 from './agent-error-401.mjs';
import agentChat from './agent-chat.mjs';
import agentToolLoop from './agent-tool-loop.mjs';
import agentToolArgs from './agent-tool-args.mjs';
import agentConfirmReject from './agent-confirm-reject.mjs';
import agentMemory from './agent-memory.mjs';
import agentUsage from './agent-usage.mjs';
import agentInterjection from './agent-interjection.mjs';
import agentTitle from './agent-title.mjs';
import agentTabsCrosspage from './agent-tabs-crosspage.mjs';
import assemblyChat from './assembly-chat.mjs';
import assemblyToolPage from './assembly-tool-page.mjs';
import assemblyMultiturn from './assembly-multiturn.mjs';

export default [
  assemblyConfig,
  agentError401,
  agentChat,
  agentToolLoop,
  agentToolArgs,
  agentConfirmReject,
  agentMemory,
  agentUsage,
  agentInterjection,
  agentTitle,
  agentTabsCrosspage,
  assemblyChat,
  assemblyToolPage,
  assemblyMultiturn,
];