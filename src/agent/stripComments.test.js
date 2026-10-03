import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { stripComments } from './stripComments';

describe('stripComments', () => {
  test('去掉行注释，保留等长空白', () => {
    const src = 'const a = 1; // saveWorkflow 这个不能用';
    const out = stripComments(src);

    assert.equal(out.length, src.length, '长度必须不变，位置才对得上');
    assert.ok(!out.includes('saveWorkflow'));
    assert.ok(out.startsWith('const a = 1;'));
  });

  test('去掉块注释，保留等长空白', () => {
    const src = 'a(); /* workflowStore.update */ b();';
    const out = stripComments(src);

    assert.equal(out.length, src.length);
    assert.ok(!out.includes('workflowStore'));
    assert.ok(out.includes('a();'), '注释前的代码必须原样');
    assert.ok(out.includes('b();'), '注释后的代码必须原样');
  });

  test('多行块注释保留换行，代码行数不变', () => {
    const src = 'a();\n/* 第一行\n第二行\n第三行 */\nb();';
    const out = stripComments(src);

    assert.equal(out.split('\n').length, src.split('\n').length);
    assert.ok(out.includes('a();'));
    assert.ok(out.includes('b();'));
  });

  test('URL 里的 // 不算注释 —— 这正是不能用正则的原因', () => {
    const src = "const url = 'https://api.openai.com/v1'; saveWorkflow();";
    const out = stripComments(src);

    assert.ok(out.includes('https://api.openai.com/v1'), 'URL 不能被吃掉');
    assert.ok(out.includes('saveWorkflow()'), 'URL 之后的真代码必须保留');
  });

  test('字符串里写成注释的样子不能被误伤', () => {
    const src = "const s = '// saveWorkflow'; const t = 2;";
    const out = stripComments(src);

    assert.ok(out.includes('// saveWorkflow'), '字符串内容不是注释');
    assert.ok(out.includes('const t = 2;'), '引号后的代码不能被当成注释吃掉');
  });

  test('转义引号不结束字符串', () => {
    const src = "const s = 'it\\'s // not a comment'; const u = 1;";
    const out = stripComments(src);

    assert.ok(out.includes('// not a comment'), '转义引号后的 // 仍在字符串里');
    assert.ok(out.includes('const u = 1;'), out);
  });

  test('模板字符串内的注释内容原样保留', () => {
    const src = 'const s = `/* hi */`; saveWorkflow();';
    const out = stripComments(src);

    assert.ok(out.includes('/* hi */'));
    assert.ok(out.includes('saveWorkflow();'));
  });

  test('正则字面量里的斜杠不是注释 —— 旧状态机漏的正是这一类', () => {
    const src = 'const r = /a\\/\\/b/g; saveWorkflow();';
    const out = stripComments(src);

    assert.ok(out.includes('saveWorkflow();'), '正则后面还有真代码');
    assert.equal(out.length, src.length);
  });

  test('解析不了时原样返回，绝不删代码', () => {
    // 守卫的方向性：宁可少剥（误报），不可误删（漏报）。
    const broken = 'const a = ((( ';

    assert.equal(stripComments(broken), broken);
  });

  test('空输入不炸', () => {
    assert.equal(stripComments(''), '');
    assert.equal(stripComments(null), '');
    assert.equal(stripComments(undefined), '');
  });
});
