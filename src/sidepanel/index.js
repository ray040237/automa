import { createApp } from 'vue';
import { createHead } from '@vueuse/head';
import App from './App.vue';
import router from './router';
import pinia from '../lib/pinia';
import compsUi from '../lib/compsUi';
import vueI18n from '../lib/vueI18n';
import vRemixicon, { icons } from '../lib/vRemixicon';
import vueToastification from '../lib/vue-toastification';
import '../assets/css/tailwind.css';
import '../assets/css/fonts.css';
import '../assets/css/style.css';

/**
 * 浏览器侧边栏入口（T-199）。
 *
 * 与 newtab 入口的差别，刻意保持最小：
 * - **没有 flow.css**：那一份是 vue-flow 画布的样式，本宿主无画布。
 * - **没有 sandbox iframe**：newtab 的 index.html 挂了沙箱 iframe 供工作流执行，
 *   侧栏不执行工作流。
 * - **router 是空的**（见 ./router.js）：只为满足 `agentHost` 在 setup 期调
 *   `useRouter()` 而装，侧栏本身不做页面切换。
 *
 * 除这些外 use 链与 newtab 一致 —— 面板组件依赖 i18n / compsUi / vRemixicon /
 * toast，少一个都会在运行期炸。
 */
const head = createHead();

createApp(App)
  .use(head)
  .use(router)
  .use(compsUi)
  .use(pinia)
  .use(vueI18n)
  .use(vueToastification)
  .use(vRemixicon, icons)
  .mount('#app');

if (module.hot) module.hot.accept();
