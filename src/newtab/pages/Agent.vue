<template>
  <div class="relative h-[calc(100vh-41px)] w-full">
    <agent-panel
      :events="agent.events"
      :target-tab="agent.targetTab"
      :config="agent.config"
      :busy="agent.busy"
      :list-tabs="listTabs"
      :sessions="agent.sessions"
      :current-session-id="agent.sessionId"
      :usage="agent.usage"
      @no-target="agent.noTarget"
      @go-settings="agent.goToSettings"
      @send="agent.send"
      @pick-tab="agent.pickTab"
      @select-session="agent.openSession"
      @new-session="agent.newSession"
      @delete-session="agent.deleteSession"
      @abort="agent.abort"
    />
    <agent-confirm-card
      v-if="agent.pendingConfirm"
      class="absolute inset-x-3 bottom-3"
      :code="agent.pendingConfirm.code"
      @answer="agent.pendingConfirm.resolve($event)"
    />
  </div>
</template>

<script setup>
import { onMounted } from 'vue';
import { listTabs } from '@/agent';
import AgentConfirmCard from '@/components/newtab/workflow/agent/AgentConfirmCard.vue';
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
});

onMounted(() => {
  // agent 初始化失败不该影响页面本身：这里不上报，
  // 真正的失败会在用户第一次发消息时以 ERROR 事件明确呈现
  agent.init().catch((err) => {
    console.warn('[agent] init failed:', err);
  });
});
</script>
