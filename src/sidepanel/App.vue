<template>
  <!--
    侧栏根容器：高度撑满视口，宽度由浏览器给（扩展无法控制，见 T-199）。
    不做 max-width —— 用户拖宽时就该跟着变宽，这是浏览器侧栏的既有行为。
  -->
  <div class="h-screen w-full bg-canvas">
    <!-- T-90：面板收单个 host 对象（useAgentHost 的返回值），绑定只此一行 -->
    <!-- T-213：撤掉 T-212 的 bg-shell —— 侧栏根与面板根统一走 canvas，
         不再为了"与 chrome 同色"引入第五个底色。 -->
    <agent-panel v-if="localeLoaded" :host="agent" />
    <!--
      2026-10-10「下拉里点删除失效」的根因：deleteSession 会先弹确认框，
      确认框走全局 mitt 事件（useDialog），**渲染靠某个宿主挂着 <ui-dialog>**
      才有人接。newtab / popup 都挂了，唯独这里没有 —— 于是在浏览器侧栏里
      点删除，事件发进了虚空，确认框永远不出现，看起来就是「按钮坏了」。
      compsUi 已全局注册 UiDialog，补一个自闭合标签即可。
    -->
    <ui-dialog />
  </div>
</template>

<script setup>
import { onMounted } from 'vue';
import AgentPanel from '@/components/newtab/workflow/agent/AgentPanel.vue';
import { usePageAgentHost } from '@/composable/agentHost';
import { useHostBootstrap } from '@/composable/hostBootstrap';
import { sendMessage } from '@/utils/message';

/**
 * 浏览器侧边栏宿主（T-199）。
 *
 * 它是「独立助手页」的替代形态：同样是 **全局会话、无画布、面向当前网页**，
 * 但从主面板标签页搬进了浏览器原生侧边栏。与编辑器侧栏宿主的分工由此彻底分开：
 *   编辑器侧栏 = 工作流内、有画布、会话按 workflowId
 *   浏览器侧栏 = 全局、无工作流、会话面向页面交互
 *
 * T-227：无画布宿主的 4 行缺省 profile 收进了 usePageAgentHost，
 * 启动链收进了 useHostBootstrap —— 这个文件只剩真正属于侧栏自己的三件事：
 * 窄形态、设置页落点（走 dashboard 通道）、面板等 locale 就绪再挂。
 */
const agent = usePageAgentHost({
  // 窄宿主：历史走「整块替换正文区」的视图切换，不做 240px 常驻左栏。
  layout: 'narrow',
  /**
   * 「去配置 API Key」的落点（T-199 / T-219 / T-220）。
   *
   * 侧栏不在 newtab 里、没有 settings 路由，必须由宿主自己把用户送到设置页。
   * 走项目既有的 dashboard 通道 `open:dashboard`（后台 → `BackgroundUtils.
   * openDashboard`）：没有 dashboard 时开一个 popup 窗口、有就复用已有标签页。
   *
   * 为什么不用 `browser.tabs.create`（T-220）：那会在**普通窗口**新建一个
   * `newtab.html` 标签页，而 `newtab/App.vue:331-339` 在非 popup 窗口里会
   * `browser.tabs.remove([tabs[0].id])` 并 `return`（跳过初始化）—— 新标签页
   * 立刻消失。`openDashboard` 走 popup 窗口，天然不踩这条。
   *
   * 路径是 `/agent` 而不是 `/settings/agent`（T-219）：见 `agentHost.js`
   * `goToAgentSettings` 的说明 —— `router.js` 的子路由是绝对路径，真实 URL 是
   * `/agent`，`/settings/agent` 实测匹配 0 条路由。
   */
  onOpenSettings: async () => {
    await sendMessage('open:dashboard', '/agent', 'background');
  },
});

// T-227：loadSettings → 语言包 → setI18nLanguage → theme.init 的顺序知识
// 在 useHostBootstrap 里；<ui-dialog> 是模板关注点，留在上方模板里。
const { localeLoaded } = useHostBootstrap();

onMounted(() => {
  // agent 初始化失败不该影响侧栏本身：这里不上报，
  // 真正的失败会在用户第一次发消息时以 ERROR 事件明确呈现
  agent.init().catch((err) => {
    console.warn('[agent] init failed:', err);
  });
});
</script>
