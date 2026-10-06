<template>
  <div class="relative h-[calc(100vh-41px)] w-full">
    <!-- T-90：面板收单个 host 对象（useAgentHost 的返回值），绑定只此一行 -->
    <agent-panel :host="agent" />
  </div>
</template>

<script setup>
import { onMounted } from 'vue';
import AgentPanel from '@/components/newtab/workflow/agent/AgentPanel.vue';
import { useAgentHost } from '@/composable/agentHost';

/**
 * 独立助手页（主面板标签页，路由 /workflows/agent）。
 *
 * 与画布无关：没有 vue-flow editor，canvas 组工具（add_block/update_block/
 * list_canvas）通过 enabledGroups 不注册；会话不绑定工作流（全局）。
 * 要「打开某个工作流来编辑」走的是编辑器侧栏那个宿主，接线同样在 useAgentHost。
 */
const agent = useAgentHost({
  // 没有画布：canvas 组工具不注册，提示词的事实表同步裁剪
  enabledGroups: ['page', 'context', 'tab'],
  // 助手页会话是全局的，不绑定工作流
  getWorkflowId: () => null,
  // T-50：这一页没有工作流可读，**必须显式说 bound:false**。
  // 曾经靠 runtime 的空兜底返回 `{}`，工具渲染成「（空）」—— 那等于告诉
  // 模型「这个工作流没有变量」，而事实是「这里根本没有工作流」，两者结论不同。
  getVariables: async () => ({ bound: false }),
  // 没有工作流就没有工作流上下文段（prompt 里那一段直接不出现）
  getWorkflowContext: () => null,
});

onMounted(() => {
  // agent 初始化失败不该影响页面本身：这里不上报，
  // 真正的失败会在用户第一次发消息时以 ERROR 事件明确呈现
  agent.init().catch((err) => {
    console.warn('[agent] init failed:', err);
  });
});
</script>
