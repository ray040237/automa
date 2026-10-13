import { createApp } from 'vue';
import App from './App.vue';
import pinia from '../lib/pinia';
import compsUi from '../lib/compsUi';
import vueI18n from '../lib/vueI18n';
import vRemixicon, { icons } from '../lib/vRemixicon';
import '../assets/css/tailwind.css';
import '../assets/css/fonts.css';
import '../assets/css/flow.css';

// vueI18n 必须在 mount 前挂上，否则 App.vue 里任何 t() 都会拿不到（补 i18n 前
// 这里只挂了 compsUi / vRemixicon，所以 params.html 一直是硬编码英文）。
// pinia 是因为 App.vue 要用 useStore().loadSettings() 读用户选的 locale。
createApp(App)
  .use(compsUi)
  .use(vueI18n)
  .use(pinia)
  .use(vRemixicon, icons)
  .mount('#app');

if (module.hot) module.hot.accept();
