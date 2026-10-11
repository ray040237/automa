<template>
  <div class="relative h-[calc(100vh-41px)] w-full">
    <!-- T-90：面板收单个 host 对象（useAgentHost 的返回值），绑定只此一行 -->
    <agent-panel :host="agent" />
  </div>
</template>

<script setup>
import { onMounted } from 'vue';
import AgentPanel from '@/components/newtab/workflow/agent/AgentPanel.vue';
import { usePageAgentHost } from '@/composable/agentHost';

/**
 * 独立助手页（主面板标签页，路由 /workflows/agent）。
 *
 * 与画布无关：没有 vue-flow editor，canvas 组工具（add_block/update_block/
 * list_canvas）通过 enabledGroups 不注册；会话不绑定工作流（全局）。
 * 要「打开某个工作流来编辑」走的是编辑器侧栏那个宿主，接线同样在 useAgentHost。
 *
 * T-227：无画布宿主的 4 行缺省 profile 收进了 usePageAgentHost ——
 * 这个文件只剩宽形态声明与 init 时机。语言包/theme 由 newtab 的启动链负责，
 * 不需要 useHostBootstrap（那是独立 HTML 入口才要背的咒语）。
 */
const agent = usePageAgentHost({
  // T-169：宿主形态。独立助手页是宽宿主 —— 左侧 240px 常驻历史列表，
  // 右侧对话区，不做视图切换（侧栏那种「把消息区整块换成历史」在宽屏上
  // 是浪费：右边会空掉一大块）。
  layout: 'wide',
});

onMounted(() => {
  // agent 初始化失败不该影响页面本身：这里不上报，
  // 真正的失败会在用户第一次发消息时以 ERROR 事件明确呈现
  agent.init().catch((err) => {
    console.warn('[agent] init failed:', err);
  });
});
</script>
