// Проверка ответов по контракту docs/api/openapi.yaml: код описан у операции, тело по схеме, заголовки на месте.
// У объектов запрещены незадокументированные поля: так ловится расхождение сервиса и контракта в обе стороны.
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import YAML from 'yaml';

const doc = YAML.parse(readFileSync(new URL('../../docs/api/openapi.yaml', import.meta.url), 'utf8'));
const DROP = new Set(['description', 'example', 'examples', 'summary', 'title']);

function deref(ref) {
  return ref.replace(/^#\//, '').split('/').reduce((n, k) => n[k], doc);
}

function strict(s) {
  if (Array.isArray(s)) return s.map(strict);
  if (!s || typeof s !== 'object') return s;
  if (s.$ref) return strict({ ...deref(s.$ref), ...Object.fromEntries(Object.entries(s).filter(([k]) => k !== '$ref')) });
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (DROP.has(k)) continue;
    out[k] = k === 'properties' ? Object.fromEntries(Object.entries(v).map(([p, x]) => [p, strict(x)])) : strict(v);
  }
  if (out.properties && !('additionalProperties' in out)) out.additionalProperties = false;
  return out;
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

const compiled = new Map();
const ops = [];
for (const [path, item] of Object.entries(doc.paths)) {
  for (const [method, op] of Object.entries(item)) {
    if (method === 'parameters') continue;
    ops.push({ id: op.operationId, method: method.toUpperCase(), re: new RegExp(`^${path.replace(/\{\w+\}/g, '[^/]+')}$`), op });
  }
}

export function checkResponse(method, path, status, headers, body) {
  const pathname = path.split('?')[0];
  const found = ops.find((o) => o.method === method && o.re.test(pathname));
  if (!found) throw new Error(`Контракт: операции ${method} ${pathname} нет в спецификации`);
  let resp = found.op.responses[String(status)];
  if (!resp) throw new Error(`Контракт: ${found.id} не описывает ответ ${status}`);
  if (resp.$ref) resp = deref(resp.$ref);
  for (const h of Object.keys(resp.headers ?? {})) {
    if (!headers.get(h)) throw new Error(`Контракт: ${found.id} ${status} без заголовка ${h}`);
  }
  const media = Object.entries(resp.content ?? {})[0];
  if (!media) return found.id;
  const [type, { schema }] = media;
  if (!(headers.get('content-type') ?? '').startsWith(type)) throw new Error(`Контракт: ${found.id} ${status} — Content-Type ${headers.get('content-type')}, ожидался ${type}`);
  const cacheKey = `${found.id}:${status}`;
  if (!compiled.has(cacheKey)) compiled.set(cacheKey, ajv.compile(strict(schema)));
  const validate = compiled.get(cacheKey);
  if (!validate(body)) throw new Error(`Контракт: ${found.id} ${status} — ${ajv.errorsText(validate.errors)}\n${JSON.stringify(body)}`);
  return found.id;
}
