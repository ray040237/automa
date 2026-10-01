/* eslint-disable no-console */
// i18n guard: fails CI when hardcoded English UI strings creep back in,
// or when en/zh locale files drift out of sync.
// Usage: node utils/check-i18n.js
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const LOCALES = path.join(SRC, 'locales');
const LANGS = ['en', 'zh', 'zh-TW'];

function walk(dir, ext, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, ext, out);
    else if (entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

// --- 1. locale parity (en as the source of truth; zh-TW is advisory only) ---
function flatten(value, prefix = '', out = {}) {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      flatten(value[key], prefix ? `${prefix}.${key}` : key, out);
    }
  } else {
    out[prefix] = value;
  }
  return out;
}

let failed = false;
const enFiles = fs.readdirSync(path.join(LOCALES, 'en'));
for (const lang of LANGS.slice(1)) {
  const present = enFiles
    .map((file) => [file, path.join(LOCALES, lang, file)])
    .filter(([, langPath]) => fs.existsSync(langPath));
  for (const [file, langPath] of present) {
    const enPath = path.join(LOCALES, 'en', file);

    const en = flatten(JSON.parse(fs.readFileSync(enPath, 'utf8')));
    const other = flatten(JSON.parse(fs.readFileSync(langPath, 'utf8')));
    const missing = Object.keys(en).filter((key) => !(key in other));
    const extra = Object.keys(other).filter((key) => !(key in en));

    if (missing.length || extra.length) {
      if (lang === 'zh') {
        failed = true;
        console.error(`[parity] ${lang}/${file}:`);
        missing.forEach((key) => console.error(`  missing: ${key}`));
        extra.forEach((key) => console.error(`  extra:   ${key}`));
      } else {
        console.warn(
          `[parity] ${lang}/${file}: ${missing.length} missing, ${extra.length} extra (advisory only)`
        );
      }
    }
  }
}

// --- 2. hardcoded English scan ---
// A line is "suspicious" when it renders a literal that starts with a capital
// letter through a label/placeholder/title/tooltip attribute or a text node,
// without going through t(). Lines that bind values, examples (URL/selectors)
// or already-translated content are ignored.
const ATTR_RE =
  /(?:label|placeholder|tooltip|title|text)="(?![:${]|$)([A-Z][a-zA-Z0-9 ,.'"()&/+-]*)"/;
const TEXT_RE =
  /(?:^|>)\s*([A-Z][a-z]+(?:\s+[a-zA-Z0-9'’.,()&/+-]+)+)\s*(?:<|$|<\/)/;
const IGNORE_RE =
  /(t\(|\$t\(|:value=|value="|v-model|v-if|v-for|@click|@change|https?:\/\/|\{\{|\}\}|class=|name=|ri[A-Z]|import |require\(|console\.|\.js|\.json|data\.|props\.|state\.|form\.|item\.|block\.|column\.|localStorage|placeholder-\d|alt=")/;

const exceptions = new Set([
  // intentional: API enums rendered raw (value === label)
  'components/newtab/workflow/edit/EditGoogleSheets.vue',
  'components/newtab/workflow/edit/EditWebhook.vue',
  'components/newtab/workflow/edit/EditNewTab.vue',
  'components/newtab/workflow/edit/EditTakeScreenshot.vue',
  'components/newtab/workflow/edit/EditProxy.vue',
  'components/newtab/workflow/edit/EditWorkflowParameters.vue',
  'components/newtab/workflow/edit/Trigger/TriggerEventWheel.vue',
  'components/newtab/workflow/edit/TriggerEvent/TriggerEventWheel.vue',
  'components/newtab/workflow/edit/TriggerEvent/TriggerEventKeyboard.vue',
  'components/newtab/workflow/edit/EditInsertData.vue',
  'components/newtab/workflow/edit/EditPressKey.vue',
  'components/newtab/workflow/edit/EditSwitchTo.vue',
  'components/newtab/workflow/edit/Trigger/TriggerElementChange.vue',
  // phase 2: content-script UIs (element selector, command palette, recording
  // toolbar, params page) need locale-loading plumbing before their strings
  // can be moved
  'content/commandPalette/App.vue',
  'content/elementSelector/App.vue',
  'content/services/recordWorkflow/App.vue',
  'params/App.vue',
  'components/content/selector/SelectorBlocks.vue',
  'components/content/selector/SelectorElementsDetail.vue',
  'components/content/selector/SelectorQuery.vue',
  // intentional: dead code blocks / brand names
  'newtab/App.vue',
  'newtab/pages/settings/SettingsBackup.vue',
  'newtab/pages/Welcome.vue',
  'components/newtab/settings/SettingsAbout.vue',
  'components/newtab/app/AppSidebar.vue',
]);

const vueFiles = walk(SRC, '.vue').filter(
  (file) => !file.includes(`${path.sep}locales${path.sep}`)
);
const offenders = [];

for (const file of vueFiles) {
  const rel = path.relative(SRC, file).replace(/\\/g, '/');
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);

  lines.forEach((line, index) => {
    if (IGNORE_RE.test(line)) return;

    const attr = ATTR_RE.exec(line);
    const text = TEXT_RE.exec(line);
    if (!attr && !text) return;

    offenders.push(`${rel}:${index + 1}: ${(attr ? attr[0] : text[0]).trim()}`);
  });
}

const meaningful = offenders.filter(
  (offender) => !exceptions.has(offender.split(':')[0])
);

if (meaningful.length) {
  failed = true;
  console.error(
    `\n[hardcoded] ${meaningful.length} suspicious line(s) not going through t():`
  );
  meaningful.forEach((offender) => console.error(`  ${offender}`));
}

if (failed) process.exit(1);
console.log(
  `i18n check passed: locales in sync (${LANGS.join(
    ', '
  )}), no new hardcoded strings.`
);
