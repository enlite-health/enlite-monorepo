/**
 * Barreira do relógio civil. Produção roda em UTC e os devs em São Paulo (-03), que mascara bug de fuso (incidente Axonico, PR #770).
 * Em src/ não se lê/escreve dia ou hora pelo fuso do processo: use `shared/locale/civilClock.ts`.
 */
import * as fs from 'fs';
import * as path from 'path';

const SRC = path.resolve(__dirname, '../../..');
const OWNER = path.join(SRC, 'shared/locale/civilClock.ts');

const LOCAL_GETSET = /\.(get|set)(Hours|Minutes|Seconds|Milliseconds|Date|Day|Month|FullYear)\(/g;
const ISO_SLICE = /toISOString\(\)\s*\.\s*(slice|substring|substr|split)\(/g;
const TOLOCALE = /toLocale(?:Date|Time)?String\(/g;

export interface Violation { line: number; rule: string; }

/** Texto da chamada a partir do `(` de abertura até o `)` que fecha (ignora parênteses em strings simples). */
function callArgs(src: string, openIdx: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (quote) { if (c === '\\') i++; else if (c === quote) quote = null; continue; }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return src.slice(openIdx, i + 1);
  }
  return src.slice(openIdx);
}

const lineOf = (src: string, idx: number): number => src.slice(0, idx).split('\n').length;

/** Apaga comentários preservando as quebras de linha (a numeração de linhas não muda). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, (m, p) => p + ' '.repeat(m.length - p.length));
}

export function findViolations(source: string): Violation[] {
  const src = stripComments(source);
  const out: Violation[] = [];
  for (const m of src.matchAll(LOCAL_GETSET)) out.push({ line: lineOf(src, m.index!), rule: `getter/setter local ${m[0]}` });
  for (const m of src.matchAll(ISO_SLICE)) out.push({ line: lineOf(src, m.index!), rule: `toISOString().${m[1]}(` });
  for (const m of src.matchAll(TOLOCALE)) {
    const args = callArgs(src, m.index! + m[0].length - 1);
    if (!/\btimeZone\b/.test(args)) out.push({ line: lineOf(src, m.index!), rule: `${m[0]}…) sem timeZone` });
  }
  return out.sort((a, b) => a.line - b.line);
}

function listSources(dir: string, acc: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== '__tests__' && e.name !== 'node_modules') listSources(full, acc); continue; }
    if (!e.name.endsWith('.ts') || /\.(test|spec)\.ts$/.test(e.name) || full === OWNER) continue;
    acc.push(full);
  }
  return acc;
}

describe('civilClockGuard — o detector', () => {
  it.each([
    ['new Date().getHours()'],
    ['d.setDate(d.getDate() + 1)'],
    ['x.getFullYear()'],
    ['x.getMilliseconds()'],
    ['d.toISOString().slice(0, 10)'],
    ["d.toISOString()\n  .split('T')[0]"],
    ['d.toISOString().substring(0,10)'],
    ["d.toLocaleDateString('es-AR')"],
    ["d.toLocaleString('es-AR', { day: '2-digit' })"],
    ["d.toLocaleTimeString()"],
  ])('ACUSA: %s', (code) => {
    expect(findViolations(code).length).toBeGreaterThan(0);
  });

  it.each([
    ['d.getUTCHours()'],
    ['d.setUTCDate(d.getUTCDate() + 1)'],
    ['d.getUTCFullYear()'],
    ['d.toISOString()'],
    ['d.toISOString().length'],
    ["d.toLocaleDateString('es-AR', { timeZone: 'UTC', day: '2-digit' })"],
    ["d.toLocaleDateString('es-AR', {\n  day: '2-digit',\n  timeZone: tz,\n})"],
    ["d.toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' })"],
    ['// d.getHours() em comentário'],
    ['/* d.toISOString().slice(0,10) */'],
    ['n.toFixed(2)'],
  ])('NÃO acusa: %s', (code) => {
    expect(findViolations(code)).toEqual([]);
  });

  it('aponta a linha certa em chamada multilinha sem timeZone', () => {
    const code = "const a = 1;\nconst b = d.toLocaleDateString('es-AR', {\n  day: '2-digit',\n});\n";
    expect(findViolations(code)).toEqual([{ line: 2, rule: "toLocaleDateString(…) sem timeZone" }]);
  });
});

describe('civilClockGuard — src/', () => {
  it('nenhum arquivo de src/ lê/escreve dia ou hora pelo fuso do processo', () => {
    const files = listSources(SRC);
    expect(files.length).toBeGreaterThan(100); // guarda contra varredura vazia (contagem 0 = não medi)
    const hits: string[] = [];
    for (const f of files) {
      for (const v of findViolations(fs.readFileSync(f, 'utf8'))) {
        hits.push(`${path.relative(path.resolve(SRC, '..'), f)}:${v.line}  ${v.rule}`);
      }
    }
    if (hits.length) {
      throw new Error(
        `Dia/hora pelo fuso do processo (prod=UTC, dev=SP mascara). Use shared/locale/civilClock.ts:\n  ${hits.join('\n  ')}`,
      );
    }
  });
});
