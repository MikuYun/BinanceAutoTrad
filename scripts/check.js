/**
 * 语法自检脚本：对所有 JS 文件跑 `node --check` 级别的解析，并检查静态资源是否齐全。
 * 零依赖，直接 `node scripts/check.js` 或 `npm run check`。
 */
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SKIP = new Set(['node_modules', 'data', '.git']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = walk(ROOT).sort();
let failed = 0;

for (const file of files) {
  const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (res.status !== 0) {
    failed += 1;
    console.log(`✗ ${relative(ROOT, file)}`);
    console.log(String(res.stderr || '').split('\n').slice(0, 6).join('\n'));
  }
}

const mustExist = [
  'server.js',
  'package.json',
  'src/static/index.html',
  'src/static/app.js',
  'src/static/styles.css',
];
const missing = mustExist.filter((p) => !existsSync(join(ROOT, p)));

console.log('');
console.log(`检查 JS 文件 ${files.length} 个，语法错误 ${failed} 个。`);
if (missing.length) {
  console.log(`缺失必要文件：${missing.join(', ')}`);
}
if (failed || missing.length) process.exitCode = 1;
else console.log('✅ 全部通过');
