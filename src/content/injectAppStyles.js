import browser from 'webextension-polyfill';
import { getDocumentMount } from '@/utils/domMount';

export function generateStyleEl(css, classes = true) {
  const style = document.createElement('style');
  style.textContent = css;

  if (classes) {
    style.classList.add('automa-element-selector');
  }

  return style;
}

export default async function (appRoot, customCss = '') {
  try {
    const response = await fetch(
      browser.runtime.getURL('/elementSelector.css')
    );
    const mainCSS = await response.text();
    const appStyleEl = generateStyleEl(mainCSS + customCss, false);
    appRoot.appendChild(appStyleEl);

    // SVG 文档（image/svg+xml）里没有 document.head —— 实测 T-251。退回
    // documentElement，<style> 在 SVG 里是合法子元素，样式照样生效。
    const styleRoot = document.head || getDocumentMount();
    const fontStyleExists = styleRoot.querySelector('.automa-element-selector');

    if (!fontStyleExists) {
      const commonCSS =
        '\n.automa-element-selector { direction: ltr } \n [automa-isDragging] { user-select: none } \n [automa-el-list] {outline: 2px dashed #6366f1;}';

      const fontURL = browser.runtime.getURL('/Inter-roman-latin.var.woff2');
      const fontCSS = `@font-face { font-family: "Inter var"; font-weight: 100 900; font-display: swap; font-style: normal; font-named-instance: "Regular"; src: url("${fontURL}") format("woff2") }`;
      const fontStyleEl = generateStyleEl(fontCSS + commonCSS);

      styleRoot.appendChild(fontStyleEl);
    }
  } catch (error) {
    console.error(error);
  }
}
