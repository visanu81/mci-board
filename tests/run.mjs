import { readFile } from 'node:fs/promises';
import { runSafetyTests } from './safety-regressions.mjs';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const results = await runSafetyTests(html);
for (const result of results) {
  console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.name}${result.error ? ': ' + result.error : ''}`);
}
const failed = results.filter(result => !result.passed);
if (failed.length) throw new Error(`${failed.length}/${results.length} safety checks failed`);
console.log(`${results.length}/${results.length} safety checks passed`);
