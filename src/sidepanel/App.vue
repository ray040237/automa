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
import { onMounted, ref } from 'vue';
import AgentPanel from '@/components/newtab/workflow/agent/AgentPanel.vue';
import { useAgentHost } from '@/composable/agentHost';
import { useTheme } from '@/composable/theme';
import { loadLocaleMessages, setI18nLanguage } from '@/lib/vueI18n';
import { sendMessage } from '@/utils/message';
import { useStore } from '@/stores/main';

/**
 * 浏览器侧边栏宿主（T-199）。
 *
 * 它是「独立助手页」的替代形态：同样是 **全局会话、无画布、面向当前网页**，
 * 但从主面板标签页搬进了浏览器原生侧边栏。与编辑器侧栏宿主的分工由此彻底分开：
 *   编辑器侧栏 = 工作流内、有画布、会话按 workflowId
 *   浏览器侧栏 = 全局、无工作流、会话面向页面交互
 *
 * 接线与旧的 Agent.vue 逐字相同，唯一差别是 `layout: 'narrow'` —— 侧栏宽度
 * 约 320–400px，横向常驻历史栏（wide 的左栏）塞不下，历史不常驻；
 * 会话的浏览 / 切换 / 删除走标题下拉（2026-10-10 起历史视图已撤）。
 * 判别依据见 agentHost.js:119 与 AgentPanel.vue:541。
 */
const agent = useAgentHost({
  // 窄宿主：历史走「整块替换正文区」的视图切换，不做 240px 常驻左栏。
  layout: 'narrow',
  // T-213：不再声明 shell —— 面板根统一 bg-canvas，暗色由 :root.dark 接管
  // 没有画布：canvas 组工具不注册，提示词的事实表同步裁剪
  enabledGroups: ['page', 'context', 'tab'],
  // 侧栏会话是全局的，不绑定工作流
  getWorkflowId: () => null,
  // T-50：这里没有工作流可读，**必须显式说 bound:false**。
  // 靠 runtime 的空兜底返回 `{}` 会让模型以为「这个工作流没有变量」，
  // 而事实是「这里根本没有工作流」，两者结论不同。
  getVariables: async () => ({ bound: false }),
  // 没有工作流就没有工作流上下文段（prompt 里那一段直接不出现）
  getWorkflowContext: () => null,
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

/**
 * 主题跟随（T-221）。
 *
 * 侧栏是独立 HTML 入口，不吃 newtab 的启动链 —— `newtab/App.vue:125` 调了
 * `theme.init()` 把 `<html>` 的 `dark` 类挂上，侧栏没调，于是设置里选暗色
 * （或系统暗色）也恒亮。主题存 `browser.storage.local.theme`（与
 * `store.settings` 分开），与语言包同款：侧栏已在读 storage，无额外依赖。
 */
const theme = useTheme();

theme.init();

onMounted(() => {
  // agent 初始化失败不该影响侧栏本身：这里不上报，
  // 真正的失败会在用户第一次发消息时以 ERROR 事件明确呈现
  agent.init().catch((err) => {
    console.warn('[agent] init failed:', err);
  });
});

/**
 * i18n 加载（修复 `workflow.agent.*` 键名直显）。
 *
 * 侧栏是独立 HTML 入口，不吃 newtab/popup 的启动链，所以必须自己加载语言包，
 * 否则所有 t('...') 都会把键名当文案显示出来。
 *
 * 注意这里加载的是 `'newtab'` 而不是 `'popup'`：`workflow.agent.*` 等面板文案
 * 位于 `locales/<locale>/newtab.json`，与面板被复用的来源保持一致。
 * 顺序照搬 newtab/App.vue:356-364 —— 先 loadSettings() 拿到用户选的 locale，
 * 再 loadLocaleMessages 注入词条，最后 setI18nLanguage 生效。
 */
const localeLoaded = ref(false);

(async () => {
  try {
    const store = useStore();
    await store.loadSettings();

    const { locale } = store.settings;
    await loadLocaleMessages(locale, 'newtab');
    await setI18nLanguage(locale);
  } catch (err) {
    console.error('[sidepanel] load locale failed:', err);
  } finally {
    localeLoaded.value = true;
  }
})();
</script>
