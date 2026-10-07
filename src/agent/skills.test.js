import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {
  SKILLS_KEY,
  SKILL_BODY_SOFT_LIMIT,
  SKILL_DESCRIPTION_MAX,
  MAX_IMPORT_ENTRIES,
  MAX_IMPORT_CHARS,
  findSkill,
  getSkillIndexFrom,
  importBackupZip,
  importSkillsZip,
  loadSkills,
  mergeSkills,
  newSkillId,
  normalizeSkill,
  parseFrontmatter,
  readSkillFrom,
  saveSkills,
  skillFromMarkdown,
  skillTotalChars,
  validateSkills,
  exportSkillZip,
  exportBackupZip,
} from './skills';
import { readSkillTool } from './tools/skill';
import { TOOLS, validateTools } from './tools';
import { toToolResult } from './tools/adapter';

/** 内存 IO 桩：与 configIO 的 get/set 同形状。 */
function createIO(initial = {}) {
  const store = new Map(Object.entries(initial));

  return {
    store,
    get: async (key) => store.get(key),
    set: async (key, value) => {
      store.set(key, value);
    },
  };
}

const SKILL = {
  name: 'review',
  description: '审查工作流',
  body: '# 技能正文',
  files: { 'reference/api.md': '接口表' },
};

// —— 注册契约 ——

test('read_skill 已注册且是 read / context：两级注入的按需侧必须免确认门', () => {
  validateTools(TOOLS);

  const tool = TOOLS.find((t) => t.name === 'read_skill');

  assert.ok(tool, 'TOOLS 里必须有 read_skill');
  assert.equal(tool.class, 'read');
  assert.equal(tool.group, 'context');
  assert.deepEqual(tool.ctx, ['readSkill']);
});

// —— 归一与校验 ——

test('normalizeSkill：缺 id 自动补、files 剔除非字符串与坏路径', () => {
  const s = normalizeSkill({
    name: ' a ',
    body: 'x',
    files: { '/ok.md': 'v', bad: 42, '': 'x' },
  });

  assert.equal(s.name, 'a');
  assert.ok(s.id.startsWith('s_'));
  assert.deepEqual(s.files, { 'ok.md': 'v' });
  assert.equal(s.enabled, true);
});

test('validateSkills：缺名称、缺正文、重名都报错；超长描述不阻断（生态技能常态）', () => {
  assert.ok(!validateSkills([{ name: '', body: 'x' }]).ok);
  assert.ok(!validateSkills([{ name: 'a', body: '  ' }]).ok);

  // T-81b 实测修正：pi / Claude Code 生态的 skill 描述本来就长（数百字符是
  // 常态），硬闸会把「导入生态技能」挡在门外。索引体积的防线是
  // SKILL_INDEX_SOFT_LIMIT 总量软警告，单技能描述只作 UI 软警告。
  const longDesc = validateSkills([
    {
      name: 'a',
      body: 'x',
      description: '长'.repeat(SKILL_DESCRIPTION_MAX + 268),
    },
  ]);
  assert.ok(longDesc.ok, '超长描述不得阻断保存/导入');

  const dup = validateSkills([
    { name: 'a', body: 'x' },
    { name: 'A', body: 'y' },
  ]);
  assert.ok(!dup.ok);
  assert.ok(dup.errors[0].includes('重复'));
});

test('saveSkills：校验不过不写盘；过了就整份落盘', async () => {
  const io = createIO();
  io.store.set(SKILLS_KEY, [{ name: 'old', body: 'old' }]);

  assert.ok(!(await saveSkills(io, [{ name: '', body: 'x' }])).ok);
  assert.equal(io.store.get(SKILLS_KEY).length, 1, '校验失败时旧数据原样保留');

  assert.ok((await saveSkills(io, [{ name: 'old', body: 'old' }, SKILL])).ok);
  assert.equal(io.store.get(SKILLS_KEY).length, 2);
});

test('loadSkills：存储为空/坏形状回空数组', async () => {
  assert.deepEqual(await loadSkills(createIO()), []);

  const io = createIO();
  io.store.set(SKILLS_KEY, '垃圾');
  assert.deepEqual(await loadSkills(io), []);
});

// —— 查找与索引 ——

test('findSkill：启用优先、大小写不敏感、不做模糊匹配', () => {
  const list = [
    normalizeSkill(SKILL),
    normalizeSkill({ name: 'draft', body: 'x', enabled: false }),
  ];

  assert.equal(findSkill(list, 'Review'), list[0], '大小写不敏感');
  assert.equal(findSkill(list, 'draft'), null, '停用的不该被找到');
  assert.equal(findSkill(list, 'rev'), null, '模糊匹配必须没有');
  assert.equal(findSkill(list, ''), null);
});

test('readSkillFrom：available 只列启用的技能名', async () => {
  const io = createIO();
  io.store.set(SKILLS_KEY, [
    SKILL,
    { name: 'draft', body: 'x', enabled: false },
  ]);

  const fn = readSkillFrom(io);
  const hit = await fn('review');

  assert.equal(hit.skill.name, 'review');
  assert.deepEqual(hit.available, ['review']);

  const miss = await fn('nope');
  assert.equal(miss.skill, null);
  assert.deepEqual(miss.available, ['review']);
});

test('getSkillIndexFrom：只回启用且正文非空的 {name, description}', async () => {
  const io = createIO();
  io.store.set(SKILLS_KEY, [
    SKILL,
    { name: 'draft', body: 'x', enabled: false },
    { name: 'empty', body: '  ' },
  ]);

  assert.deepEqual(await getSkillIndexFrom(io), [
    { name: 'review', description: '审查工作流' },
  ]);
});

// —— read_skill 工具行为 ——

test('read_skill：命中回全文（带预算覆盖），未回名列出可用技能', async () => {
  const ctx = {
    readSkill: async (name) => ({
      skill: name === 'review' ? normalizeSkill(SKILL) : null,
      available: ['review'],
    }),
  };

  const hit = await readSkillTool.execute({ name: 'review' }, ctx);
  assert.ok(hit.payload.includes('# 技能正文'));
  assert.equal(hit.maxChars, 32768, '技能正文的观察值预算必须放宽');

  const miss = await readSkillTool.execute({ name: 'nope' }, ctx);
  assert.equal(miss.status, 'error');
  assert.ok(
    miss.payload.includes('review'),
    '错误里必须带可用技能名（模型自纠）'
  );
});

test('read_skill：path 读附带文件；路径不存在回可用文件清单', async () => {
  const ctx = {
    readSkill: async () => ({
      skill: normalizeSkill(SKILL),
      available: ['review'],
    }),
  };

  const file = await readSkillTool.execute(
    { name: 'review', path: 'reference/api.md' },
    ctx
  );
  assert.ok(file.payload.includes('接口表'));

  const miss = await readSkillTool.execute(
    { name: 'review', path: 'nope.md' },
    ctx
  );
  assert.equal(miss.status, 'error');
  assert.ok(miss.payload.includes('reference/api.md'));
});

test('观察值预算覆盖贯通到 wrapObservation：32K 内不截断，超了截断且模型可见', () => {
  const big = 'x'.repeat(32768 + 1);
  const wrapped = JSON.parse(
    // toToolResult 产 {content:[{text}]}，取 text 验证
    JSON.stringify({
      t: toToolResult({ payload: big, maxChars: 32768 }).content[0].text,
    })
  ).t;

  assert.ok(wrapped.includes('[truncated'), '超 32K 必须截断且有可见标记');
  assert.ok(wrapped.length < big.length + 500);

  // 8K 默认不受影响：普通工具的超长返回仍然 8K 截断
  const normal = toToolResult({ payload: 'y'.repeat(9000) }).content[0].text;
  assert.ok(normal.includes('[truncated'));
});

// —— markdown / zip 往返 ——

test('parseFrontmatter：有围栏取 name/description、无围栏原样、其余键忽略', () => {
  const withFm = parseFrontmatter(
    '---\nname: review\ndescription: "审查"\nother: x\n---\n\n# 正文'
  );
  assert.deepEqual(withFm.attrs, { name: 'review', description: '审查' });
  assert.equal(withFm.body, '\n# 正文');

  const noFm = parseFrontmatter('# 直接正文');
  assert.deepEqual(noFm.attrs, {});
  assert.equal(noFm.body, '# 直接正文');
});

test('skillFromMarkdown：frontmatter 优先，名称回落文件名', () => {
  const s = skillFromMarkdown('---\nname: review\n---\n正文', 'fallback');

  assert.equal(s.name, 'review');
  assert.equal(s.body, '正文');

  const fallback = skillFromMarkdown('正文', 'my-skill.md');
  assert.equal(fallback.name, 'my-skill.md');
});

test('单技能 zip 往返：SKILL.md + 附带文件，再导入形状一致', async () => {
  const bytes = await exportSkillZip(SKILL);
  const { skills: imported, rejected } = await importSkillsZip(bytes);

  assert.equal(rejected.length, 0);
  assert.equal(imported.length, 1);
  assert.equal(imported[0].name, 'review');
  assert.equal(imported[0].description, '审查工作流', 'frontmatter 随导出还原');
  assert.equal(imported[0].body, SKILL.body);
  assert.deepEqual(imported[0].files, SKILL.files);
});

test('zip 导入：二进制/不支持扩展拒收上报，不静默丢；多文件夹各成一条', async () => {
  const zip = new JSZip();

  zip.folder('review').file('SKILL.md', '---\nname: review\n---\n正文');
  zip.folder('review').file('img.png', Uint8Array.from([1, 2, 3]));
  zip.folder('review').file('data.csv', 'a,b');
  zip.folder('other').file('SKILL.md', '---\nname: other\n---\n另一条');

  const { skills: imported, rejected } = await importSkillsZip(
    await zip.generateAsync({ type: 'uint8array' })
  );

  assert.equal(imported.length, 2);
  assert.deepEqual(
    imported[0].files,
    { 'data.csv': 'a,b' },
    '文本附带文件保留'
  );
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].path.includes('img.png'), '二进制必须点名上报');

  // 无 SKILL.md 的包明确报错
  const empty = new JSZip();
  empty.file('x.md', 'x');
  const emptyBytes = await empty.generateAsync({ type: 'uint8array' });
  await assert.rejects(() => importSkillsZip(emptyBytes));
});

test('全量备份往返：技能 + 模板 + 指令都能带回', async () => {
  const commands = [{ name: 'cmd1', body: '模板正文' }];
  const instructions = { text: '请用中文', enabled: true };
  const bytes = await exportBackupZip({
    skills: [SKILL],
    commands,
    instructions,
  });
  const out = await importBackupZip(bytes);

  assert.equal(out.skills.length, 1);
  assert.equal(out.skills[0].name, 'review');
  assert.deepEqual(out.commands, commands);
  assert.deepEqual(out.instructions, instructions);
  assert.equal(out.rejected.length, 0);

  // 不是备份包要报清楚，而不是当成空包吞掉
  const plain = new JSZip();
  plain.file('SKILL.md', 'x');
  const plainBytes = await plain.generateAsync({ type: 'uint8array' });
  await assert.rejects(() => importBackupZip(plainBytes));
});

// —— 合并 ——

test('mergeSkills：按名称覆盖更新、新的追加，计数如实', () => {
  const existing = [
    normalizeSkill(SKILL),
    normalizeSkill({ name: 'keep', body: 'k' }),
  ];
  const incoming = [
    { name: 'review', body: '新版本正文' },
    { name: 'brand-new', body: 'n' },
  ];

  const { merged, added, updated } = mergeSkills(existing, incoming);

  assert.equal(merged.length, 3);
  assert.equal(added, 1);
  assert.equal(updated, 1);
  assert.equal(merged.find((s) => s.name === 'review').body, '新版本正文');
  assert.equal(
    merged.find((s) => s.name === 'keep').body,
    'k',
    '没被点名的原样保留'
  );
});

// —— 杂项 ——

test('newSkillId 前缀 s_ 且不重复', () => {
  assert.notEqual(newSkillId(), newSkillId());
  assert.ok(newSkillId().startsWith('s_'));
});

test('skillTotalChars 是正文加全部附带文件', () => {
  assert.equal(
    skillTotalChars({ body: '12345', files: { a: '12', b: '3' } }),
    8
  );
});

test('软限常量是给 UI 用的正数且 read_skill 预算覆盖大于全局 8K', async () => {
  const {
    READ_SKILL_MAX_CHARS,
    SKILL_TOTAL_SOFT_LIMIT,
    SKILL_INDEX_SOFT_LIMIT,
  } = await import('./skills');

  assert.ok(
    SKILL_BODY_SOFT_LIMIT > 0 && SKILL_BODY_SOFT_LIMIT <= READ_SKILL_MAX_CHARS
  );
  assert.ok(READ_SKILL_MAX_CHARS > 8000);
  assert.ok(SKILL_TOTAL_SOFT_LIMIT >= SKILL_BODY_SOFT_LIMIT);
  assert.ok(SKILL_INDEX_SOFT_LIMIT > 0);
});

// —— T-81b review 修复（T-141 ~ T-147）——

test('T-141：全量备份保真 —— 停用状态与 id 原样往返', async () => {
  const s = normalizeSkill({
    name: 'disabled',
    description: '停用技能',
    body: '正文',
    enabled: false,
  });
  const bytes = await exportBackupZip({
    skills: [s],
    commands: [],
    instructions: null,
  });
  const out = await importBackupZip(bytes);

  assert.equal(out.skills.length, 1);
  assert.equal(out.skills[0].enabled, false, '恢复后停用技能不得复活');
  assert.equal(out.skills[0].id, s.id, '恢复后 id 应稳定，不该重生');
  assert.equal(out.skills[0].body, '正文');
});

test('T-142：mergeSkills 保留原有的 enabled/id；incoming 显式声明才覆盖', () => {
  const existing = [normalizeSkill({ name: 'a', body: 'old', enabled: false })];
  const keptId = existing[0].id;

  const { merged } = mergeSkills(existing, [{ name: 'a', body: 'new' }]);
  const m = merged.find((s) => s.name === 'a');

  assert.equal(m.body, 'new', '正文按合并语义更新');
  assert.equal(m.enabled, false, 'incoming 没带 enabled 不得复活停用技能');
  assert.equal(m.id, keptId, 'incoming 没带 id 不得换掉稳定 id');

  const explicit = mergeSkills(existing, [
    { name: 'a', body: 'x', enabled: true },
  ]).merged.find((s) => s.name === 'a');
  assert.equal(explicit.enabled, true, 'incoming 显式 enabled 应当生效');
});

test('T-144：根 SKILL.md 不吞子目录技能 —— 各技能的子树互不越界', async () => {
  const zip = new JSZip();

  zip.file('SKILL.md', '---\nname: root\n---\n根');
  zip.file('reference/api.md', '根参考');
  zip.folder('sub').file('SKILL.md', '---\nname: sub\n---\n子');
  zip.folder('sub').file('ref.md', '子参考');

  const { skills: imported } = await importSkillsZip(
    await zip.generateAsync({ type: 'uint8array' })
  );

  const root = imported.find((s) => s.name === 'root');
  const sub = imported.find((s) => s.name === 'sub');

  assert.ok(root && sub, '根技能与子技能都该各成一条');
  assert.deepEqual(
    root.files,
    { 'reference/api.md': '根参考' },
    '根技能不得收走子技能的 SKILL.md 与文件'
  );
  assert.deepEqual(sub.files, { 'ref.md': '子参考' });
});

test('T-145：frontmatter 值压成单行；成对引号才剥、值内引号保留', async () => {
  // 直测解析侧：单侧引号是正文的一部分，不得剥掉
  assert.equal(parseFrontmatter('---\nname: a"b\n---\nx').attrs.name, 'a"b');
  assert.equal(
    parseFrontmatter('---\ndescription: "审查"\n---\nx').attrs.description,
    '审查'
  );

  // 往返：含换行与成对引号的描述
  const bytes = await exportSkillZip({
    name: 's',
    description: '第一行\n第二行',
    body: 'b',
  });
  const { skills: one } = await importSkillsZip(bytes);

  assert.equal(one[0].description, '第一行 第二行', '换行被压成单行');

  const bytes2 = await exportSkillZip({
    name: 's2',
    description: '"带引号"',
    body: 'b',
  });
  const { skills: two } = await importSkillsZip(bytes2);

  assert.equal(two[0].description, '"带引号"', '成对引号不得被误剥');
});

test('T-146：导入包超过条目数/总字符上限直接抛错，不静默裁', async () => {
  const many = new JSZip();

  for (let i = 0; i <= MAX_IMPORT_ENTRIES; i += 1) {
    many.file(`f${i}.md`, 'x');
  }

  const manyBytes = await many.generateAsync({ type: 'uint8array' });

  await assert.rejects(() => importSkillsZip(manyBytes), /条目过多/);

  const huge = new JSZip();

  huge.file('SKILL.md', '---\nname: big\n---\n正文');
  huge.file('huge.md', 'x'.repeat(MAX_IMPORT_CHARS + 1));

  const hugeBytes = await huge.generateAsync({ type: 'uint8array' });

  await assert.rejects(() => importSkillsZip(hugeBytes), /内容过大/);
});

test('T-147a：导出时 files 里的 SKILL.md 不覆盖技能入口', async () => {
  const bytes = await exportSkillZip({
    name: 's',
    body: '真正文',
    files: { 'SKILL.md': '假入口', 'note.md': '备注' },
  });
  const { skills: imported } = await importSkillsZip(bytes);

  assert.equal(imported.length, 1);
  assert.equal(imported[0].body, '真正文');
  assert.deepEqual(imported[0].files, { 'note.md': '备注' });
});

test('T-147b：全量备份目录名去重 —— 清洗后同名的技能都留得住', async () => {
  const bytes = await exportBackupZip({
    skills: [
      normalizeSkill({ name: 'A/B', body: 'x' }),
      normalizeSkill({ name: 'A\\B', body: 'y' }),
    ],
    commands: [],
    instructions: null,
  });
  const out = await importBackupZip(bytes);

  assert.equal(out.skills.length, 2, '清洗后同名的技能不得互相覆盖');
  assert.deepEqual(out.skills.map((s) => s.name).sort(), ['A/B', 'A\\B']);
});
