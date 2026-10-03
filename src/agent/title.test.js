import test from 'node:test';
import assert from 'node:assert';
import { buildTitleMessages, cleanTitle } from './title';

test('buildTitleMessages 带上用户与助手片段', () => {
  const msgs = buildTitleMessages('帮我抓列表', '好的，这是方案…');
  assert.equal(msgs[0].role, 'system');
  assert.ok(msgs[1].content.includes('帮我抓列表'));
  assert.ok(msgs[1].content.includes('好的，这是方案'));

  const noReply = buildTitleMessages('只有用户');
  assert.ok(!noReply[1].content.includes('助手:'));
});

test('buildTitleMessages 截断超长输入', () => {
  const msgs = buildTitleMessages('长'.repeat(500));
  assert.ok(msgs[1].content.length < 300);
});

test('cleanTitle 去引号空白、取首行、超长截断', () => {
  assert.equal(cleanTitle('「抓取商品列表」。'), '抓取商品列表');
  assert.equal(cleanTitle('  第一行\n第二行  '), '第一行');
  assert.equal(cleanTitle('一'.repeat(40)).length, 24 + 1);
  assert.equal(cleanTitle('   '), null);
  assert.equal(cleanTitle(undefined), null);
});
