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
import browser from 'webextension-polyfill';
import AgentPanel from '@/components/newtab/workflow/agent/AgentPanel.vue';
import { useAgentHost } from '@/composable/agentHost';
import { loadLocaleMessages, setI18nLanguage } from '@/lib/vueI18n';
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
   * 「去配置 API Key」的落点（T-199）。侧栏不在 newtab 里、没有 settings 路由，
   * 所以由宿主自己开一个主面板标签页指到设置页。UI 是同一个面板、同一句
   * 「去设置里配置」，但底下走的是开标签页而不是 router.push。
   */
  onOpenSettings: async () => {
    await browser.tabs.create({
      url: browser.runtime.getURL('newtab.html#/settings/agent'),
    });
  },
});

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
