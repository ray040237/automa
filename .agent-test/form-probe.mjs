/** 只看真页面里 form.form-horizontal 的 <strong> 到底是什么，别猜。 */
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto('https://books.toscrape.com/', { waitUntil: 'load' });

const info = await page.evaluate(() => {
  const form = document.querySelector('form.form-horizontal');
  if (!form) return 'no form';
  const out = {
    formHTML: form.outerHTML.slice(0, 600),
    strongs: Array.from(form.children)
      .filter((c) => c.tagName === 'STRONG')
      .map((s) => ({
        text: s.textContent.trim(),
        parentTag: s.parentElement.tagName,
        prev: s.previousElementSibling && s.previousElementSibling.tagName,
        next: s.nextElementSibling && s.nextElementSibling.tagName,
      })),
    childTags: Array.from(form.children).map((c) => c.tagName),
  };
  return out;
});

console.log(JSON.stringify(info, null, 2));
await browser.close();
