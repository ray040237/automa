/* eslint-disable no-console */
// Engine-error i18n guard (T-262).
//
// Every error the workflow engine throws ends up in the workflow log, where
// `translateLog` looks it up as `log.messages.<message>` and interpolates the
// placeholders from the log object (`{ message, ...error.data, ...error.ctxData }`).
// When the lookup misses, the log renders the raw message — so an English
// literal here is an English string in a Chinese user's log.
//
// This guard fails when an engine-side error literal is NOT a `log.messages` key.
// Interpolated literals (containing ${...}) can never be a key and always fail —
// they must become a slug plus `error.data = { ... }` so the locale entry can
// interpolate from the log object.
//
// Scanned sites: `new Error(...)`, `generateError(...)`, `.message = ...`.
// The argument is extracted by paren-matching and *every* string literal inside
// it is checked, so `new Error(expr || 'fallback')` and multi-line
// `new Error(\n '...'\n )` are covered too (a line-based scan misses both).
//
// NOTE: placeholder names must avoid the log entry's own reserved fields —
// `description, prevBlockData, type, name, blockId, workerId, timestamp,
// activeTabUrl, replacedValue, duration, id, message, ctxData`. `name` and `id`
// in particular are (re)written by `addBlockLog` / `addLogHistory` after the
// error data is spread, so a slug interpolating `{name}` or `{id}` would render
// the block label / log id instead of the intended value.
//
// Usage: node utils/check-engine-errors.js
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const LOCALES = path.join(SRC, 'locales');

// Only the paths whose errors reach the workflow log. `agent/` and UI components
// have their own surfaces and are out of scope.
const ROOTS = ['workflowEngine', 'content', 'sandbox', 'background'].map((p) =>
  path.join(SRC, p)
);

// Sites that *look* like engine errors but never reach the workflow log.
// Every entry needs a reason — an entry here means "a user can never see this".
const ALLOWED = new Map([
  [
    // eslint-disable-next-line no-template-curly-in-string -- this is the literal we scan for
    'API request failed: ${response.status}',
    'WorkflowEngine.js: thrown and caught in the same function, then console.error only',
  ],
  [
    'Invalid URL',
    'handlerCreateElement.js: rejected inside Promise.allSettled; rejected entries are skipped',
  ],
  [
    'Iframe not found',
    'content/utils.js: caught by the surrounding try/catch and discarded',
  ],
  [
    'Callback is missing or invalid',
    'background check-csp-and-inject handler: swallowed by checkCSPAndInject()',
  ],
  [
    'Unable to get JavaScript code',
    'background check-csp-and-inject handler: swallowed by checkCSPAndInject()',
  ],
  [
    'Error executing callback',
    'background check-csp-and-inject handler: swallowed by checkCSPAndInject()',
  ],
  [
    'Callback did not return JavaScript code string',
    'background check-csp-and-inject handler: swallowed by checkCSPAndInject()',
  ],
  [
    'Unable execute code',
    'background check-csp-and-inject handler: swallowed by checkCSPAndInject()',
  ],
  [
    'Error executing JavaScript code',
    'background check-csp-and-inject handler: swallowed by checkCSPAndInject()',
  ],
  [
    '调试器没有返回结果',
    'background agent page channel: returned to the agent as {ok:false,error}, never logged',
  ],
  [
    '调试器执行出错',
    'background agent page channel: returned to the agent as {ok:false,error}, never logged',
  ],
]);

const SITE_RES = [
  /new\s+Error\s*\(/g,
  /generateError\s*\(/g,
  /\.message\s*=\s*/g,
];

function walk(dir, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name !== '__stubs__') walk(full, out);
    } else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
      out.push(full);
    }
  }

  return out;
}

// Return the text between `open` (index of an opening paren) and its matching
// close paren, ignoring parens that live inside string/template literals.
function matchParen(src, open) {
  let depth = 0;
  let i = open;
  let inStr = null;

  while (i < src.length) {
    const c = src[i];

    if (inStr && c === '\\') {
      i += 2;
    } else if (inStr) {
      if (c === inStr) inStr = null;
      i += 1;
    } else if (c === '"' || c === "'" || c === '`') {
      inStr = c;
      i += 1;
    } else if (c === '(') {
      depth += 1;
      i += 1;
    } else if (c === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
      i += 1;
    } else {
      i += 1;
    }
  }

  return null;
}

// Collect every string/template literal that appears in an argument list.
function extractLiterals(arg) {
  const out = [];
  let i = 0;

  while (i < arg.length) {
    const quote = arg.charAt(i);

    if (quote === '"' || quote === "'" || quote === '`') {
      let j = i + 1;
      let value = '';

      while (j < arg.length && arg[j] !== quote) {
        if (arg[j] === '\\') {
          value += arg[j] + arg[j + 1];
          j += 2;
        } else {
          value += arg[j];
          j += 1;
        }
      }

      out.push(value);
      i = j + 1;
    } else {
      i += 1;
    }
  }

  return out;
}

const { messages } = JSON.parse(
  fs.readFileSync(path.join(LOCALES, 'en', 'newtab.json'), 'utf8')
).log;
const keys = new Set(Object.keys(messages));

const offenders = [];

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const rel = path.relative(SRC, file).replace(/\\/g, '/');
    const src = fs.readFileSync(file, 'utf8');

    for (const re of SITE_RES) {
      re.lastIndex = 0;
      let match = re.exec(src);

      while (match) {
        const isAssign = match[0].includes('.message');
        const argStart = isAssign
          ? match.index + match[0].length
          : src.indexOf('(', match.index);
        const arg = isAssign
          ? src.slice(argStart).split(/[;\n]/)[0]
          : matchParen(src, argStart);

        if (arg !== null) {
          const line = src.slice(0, match.index).split('\n').length;

          for (const literal of extractLiterals(arg)) {
            const interpolated = /\$\{/.test(literal);

            if ((interpolated || !keys.has(literal)) && !ALLOWED.has(literal)) {
              offenders.push({
                at: `${rel}:${line}`,
                literal,
                reason: interpolated ? 'interpolated' : 'no log.messages key',
              });
            }
          }
        }

        match = re.exec(src);
      }
    }
  }
}

if (offenders.length) {
  const unique = new Set(offenders.map((o) => o.literal));
  console.error(
    `\n[engine-errors] ${offenders.length} literal(s) / ${unique.size} unique not resolvable via log.messages:\n`
  );
  offenders.forEach((o) =>
    console.error(`  ${o.at}  [${o.reason}]  ${JSON.stringify(o.literal)}`)
  );
  console.error(
    `\nFix: throw a slug instead, attach the data the message needs as ` +
      `\`error.data = { ... }\`, and add the slug to src/locales/{en,zh}/newtab.json ` +
      `under log.messages. If the error can never reach the log, add it to ALLOWED ` +
      `with a reason.\n`
  );
  process.exit(1);
}

console.log(
  `engine-errors check passed: every engine-side error literal is a log.messages key (${keys.size} keys).`
);
