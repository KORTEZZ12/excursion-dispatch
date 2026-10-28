// Линтер BPMN: базовые правила bpmnlint для всех схем и правила camunda-cloud-8-8 для исполняемых TO-BE.
// Запуск: cd tools && npm ci && node bpmn-lint.mjs ../docs/bpmn/*.bpmn
import { BpmnModdle } from 'bpmn-moddle';
import zeebe from 'zeebe-bpmn-moddle/resources/zeebe.json' with { type: 'json' };
import { Linter } from 'bpmnlint';
import NodeResolver from 'bpmnlint/lib/resolver/node-resolver.js';
import fs from 'node:fs';
import path from 'node:path';

let problems = 0;
for (const file of process.argv.slice(2)) {
  const executable = !path.basename(file).startsWith('as-is');
  const config = { extends: executable
    ? ['bpmnlint:recommended', 'plugin:camunda-compat/camunda-cloud-8-8']
    : ['bpmnlint:recommended'] };
  // Новый линтер на каждый файл: правила хранят состояние между вызовами
  const linter = new Linter({ config, resolver: new NodeResolver() });
  const moddle = new BpmnModdle({ zeebe });
  const { rootElement, warnings } = await moddle.fromXML(fs.readFileSync(file, 'utf8'));
  const report = await linter.lint(rootElement);
  const issues = Object.entries(report).flatMap(([rule, list]) =>
    list.map((r) => `${r.category} ${rule}: ${r.id} ${r.message}`));
  const all = [...warnings.map((w) => `parse ${w.message}`), ...issues];
  console.log(`${all.length ? '✗' : '✓'} ${file}${executable ? '' : ' (описательная, базовые правила)'}`);
  all.forEach((i) => console.log(`    ${i}`));
  problems += all.length;
}
process.exit(problems ? 1 : 0);
