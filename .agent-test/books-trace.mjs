/**
 * 用真实页面 https://books.toscrape.com/ 跑一遍 read_page，
 * 把 agent 实际看到的观察值原样打出来，并按项目口径（window.js estimateTokens）
 * 算 token，用来对照改造前后的成本。
 * 不带断言，纯观察。跑法（token 口径需要测试解析钩子）：
 *   node --import ./utils/test-loader.mjs .agent-test/books-trace.mjs
 * 只看输出：DUMP=1 node ...
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateTokens } from '../src/agent/window.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const handlerSrc = readFileSync(path.join(here, 'handler.iife.js'), 'utf8');

const URL_ = 'https://books.toscrape.com/';

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(URL_, { waitUntil: 'load' });
await page.addScriptTag({ content: handlerSrc });

async function read(detail) {
  const res = await page.evaluate(
    (d) => window.__agentReadPage({ detail: d }),
    detail
  );
  return { text: res.text, fingerprint: res.fingerprint };
}

function sections(out) {
  const marks = [...out.matchAll(/^## (.+)$/gm)].map((m) => m.index);
  return marks.map((start, i) => {
    const end = i + 1 < marks.length ? marks[i + 1] : out.length;
    const body = out.slice(start, end).trimEnd();
    return { title: out.slice(start, end).split('\n')[0], chars: body.length, body };
  });
}

const rows = [];

for (const detail of ['probe', 'addresses', 'content', 'full']) {
  const { text: out, fingerprint } = await read(detail);
  const tokens = estimateTokens([{ role: 'user', content: out }]);

  if (process.env.DUMP) {
    const fs = await import('node:fs');
    fs.writeFileSync('.scratch/out-' + detail + '.txt', out);
    console.log('dumped .scratch/out-' + detail + '.txt');
  }

  rows.push({ detail, chars: out.length, tokens, fingerprint });

  const secs = sections(out);
  console.log('\n' + '='.repeat(72));
  console.log(
    `detail = ${detail}   总字符 ${out.length}   ≈ ${tokens} token   fingerprint=${fingerprint}`
  );
  console.log('='.repeat(72));
  for (const s of secs) {
    console.log(`\n--- ${s.title}  (${s.chars} 字符) ---`);
    console.log(s.body.length > 1400 ? s.body.slice(0, 1400) + `\n   …[略去 ${s.chars - 1400} 字符] …` : s.body);
  }
}

console.log('\n== 对照表（改造前 detail=auto：6705 字符 / 4470 token）==');
rows.forEach((r) =>
  console.log(
    `${r.detail.padEnd(10)} ${String(r.chars).padStart(6)} 字符  ${String(r.tokens).padStart(5)} token  ${((r.tokens / 4470) * 100).toFixed(0)}%`
  )
);

await browser.close();
