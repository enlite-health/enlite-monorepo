/**
 * src/modules/identity/permissions/domain/__tests__/catalogo-sem-orfao.test.ts
 *
 * Fase 2 da change `catalogo-de-permissoes-derivado-do-codigo` (D115): o catálogo de células é
 * DERIVADO do código — nenhuma chave em `CELL_DESCRIPTION` pode ficar sem CONSUMIDOR real, porque
 * é exatamente essa lacuna que fez a Fase 1 achar 12 células `:write` órfãs (removidas no commit
 * `84b1ecb2`). Este teste é a RÉGUA que impede a próxima órfã de voltar sem ninguém notar.
 *
 * Por que ESTÁTICO (grep + resolução de identificador) e não e2e de boot: o CI do
 * `backend-e2e.yml` sobe sem os overlays do sync de permissões — não há app de pé exercitando
 * `cellsForaDeRota`/o sync nesse pipeline. Rodar como unit (`npx jest`) é o único jeito de ter
 * régua na suíte que o CI de fato roda.
 *
 * ── O que conta como CONSUMIDOR (fatos-medidos F8, fase-2.md) ──────────────────────────────────
 *  1. Rota: `<qualquer variável>.require('<recurso>', '<ação>')` — literal OU com recurso/ação
 *     vindo de VARIÁVEL (const, membro de Record indexado por loop, elemento de tupla de loop).
 *  2. Checagem literal: `<algo com "cell" no nome>.includes(<expressão>)` cuja expressão resolve
 *     para `'<recurso>:<ação>'` — direto (`cells.includes('x:y')`), via constante
 *     (`cells.includes(CELL_X)`, `CELL_X = 'x:y'` ou `CELL_X = cellKey('x','y')`), ou via helper
 *     (`cells.includes(patientContainerCell(container, 'read'))`).
 *
 * ── Por que um RESOLVEDOR de expressão, não só grep de string ────────────────────────────────
 * Medido (Passo 0 do fase-2.md): grep de substring simples cai em dois lados —
 *  (a) FALSO POSITIVO: comentário/JSDoc menciona a chave removida (`messaging:write` aparece em
 *      3 comentários de `TemplateDraftsController.ts`/`messagingRoutes.ts` mesmo já REMOVIDA do
 *      dicionário) — por isso todo arquivo passa por `stripComments` antes de qualquer regex.
 *  (b) FALSO NEGATIVO: 13 chaves (`patient_therapeutic_project:*`, `catalog_therapeutic_*:*`) só
 *      têm consumidor via `perm.require(CONST, 'ação')`/`perm.require(RECORD[kind], 'ação')`, e
 *      outras (`dashboard_numbers:read` etc., `worker_contact:read`, `worker_pii:read`,
 *      `patient_identity:read` via `canReadPatientContainer`) só via helper cujo parâmetro é
 *      preenchido em OUTRO ponto do arquivo (loop) ou EM OUTRO ARQUIVO (call site) — nenhuma das
 *      duas aparece como string literal em lugar nenhum. Confirmado por medição: sem o
 *      resolvedor, a varredura acusava 18 chaves como órfãs no estado LIMPO (falso vermelho de
 *      largada, que o fase-2.md proíbe).
 *
 * O resolvedor (`evaluate`) cobre, por construção — nada além disso, e quando não alcança marca
 * a chamada como NÃO RESOLVIDA (nunca assume consumo):
 *   - literal `'x'` / crase `` `${...}` ``;
 *   - identificador → const no mesmo arquivo, ou importado (inclusive via barrel
 *     `export { x } from '...'`, múltiplos saltos até `MAX_DEPTH`);
 *   - `RECORD[chave]` → valor(es) do objeto (uma chave literal, ou todas as chaves de um loop
 *     `for (const k of ARRAY)` sobre a mesma variável);
 *   - `fn(args)` → definição de `fn` (arrow com corpo direto, ou `function`/arrow com
 *     `return ...;`), parâmetros substituídos pelos argumentos e o corpo reavaliado;
 *   - identificador que é PARÂMETRO da função que contém a chamada (`canReadPatientContainer`,
 *     `canReadWorkerContainer`, `canReadDashboardSection`, `pode`) e não resolve por nenhuma via
 *     acima → CALL-SITE FLOW: acha toda chamada `fn(...)` em `src` (exceto a própria definição),
 *     pega o argumento na MESMA posição do parâmetro, resolve ESSE argumento (literal, ou loop no
 *     arquivo do call site) e usa a união dos resultados.
 *
 * Limite deliberado: o call-site flow olha só a expressão do argumento no escopo de MÓDULO do
 * arquivo do call site (não atravessa um segundo nível de "parâmetro de função que é parâmetro de
 * outra função"). Não apareceu esse caso em `src/` na medição de 20/09 — se aparecer no futuro e
 * a chave ficar como NÃO RESOLVIDA na lista abaixo, é sinal de que precisa de mais um nível, não
 * de allow-list.
 *
 * ── Estado medido em 20/09 (só backend): este teste NASCEU VERMELHO por erro de ESPECIFICAÇÃO,
 *    não por bug do resolvedor — a varredura olhava só `worker-functions/src` ──────────────────
 * Com o resolvedor completo do backend (não por falta de alcance), sobravam 4 chaves SEM
 * consumidor nenhum NESSA CAMADA — nem rota, nem `cells.includes`, nem helper:
 *   - `api_docs:read` — a rota real de `/api/docs` (`src/index.ts`) usa só
 *     `authMiddleware.requireStaff()`, sem `perm.require`/checagem de célula nenhuma.
 *   - `patient_chat:read` / `patient_chat:create` — só existe rota para `patient_chat:update`
 *     (`PUT /patients/:id/chat-ids`); leitura de chat usa `patient:read`/`messaging:read`, e
 *     `canReadPatientContainer` nunca é chamado com o container `'chat'`.
 *   - `prescreening:create` — só existem rotas para `prescreening:read`/`update`
 *     (`adminVacanciesRoutes.ts`); não há `create` em lugar nenhum.
 * Célula pode ter consumidor no FRONTEND sem `perm.require` nenhum no backend (a rota já projeta
 * a resposta; quem decide o que MOSTRAR é a tela) — e é exatamente o caso de 3 das 4: `scanFrontend`
 * (abaixo) achou `patient_chat:read`/`patient_chat:create` no `c('chat', 'patient_chat', [...])`
 * de `SCREEN_REGISTRY` (`patients.detail`, container `chat`) + `ContainerGate resource="patient_chat"`
 * (`PatientDetailPage.tsx`), e `prescreening:create` no `c('prescreening', 'prescreening', [...])`
 * de `SCREEN_REGISTRY` (`vacancies.detail`) e no `cells: [...]` literal de `vacancies.talentum`.
 * Só `api_docs:read` segue SEM consumidor em nenhuma das duas camadas — PRÉ-EXISTENTE (não
 * introduzida por esta Fase, não faz parte das 12 da Fase 1), e a feature `api_docs` está em
 * remoção (branches `chore/remover-api-docs`; já não existe no catálogo de prd). Fica como
 * ACHADO para decisão humana (remover de `CELL_DESCRIPTION` ou declarar o consumidor que falta),
 * nunca como allow-list — então este teste permanece VERMELHO até essa decisão.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join, dirname, resolve as resolvePath, relative } from 'path';
import { CELL_DESCRIPTION } from '../PermissionCell';

const SRC_ROOT = join(__dirname, '..', '..', '..', '..', '..', '..', 'src');
const REPO_ROOT = join(SRC_ROOT, '..');
const TSCONFIG_PATHS: Record<string, string[]> = JSON.parse(
  readFileSync(join(REPO_ROOT, 'tsconfig.json'), 'utf8'),
).compilerOptions.paths;

const MAX_DEPTH = 10;

/** Arquivos `.ts`/`.tsx` sob `src/`, pulando qualquer diretório `__tests__` (mesmo padrão de
 *  `no-split-resource-write.test.ts`, vizinho deste arquivo). */
function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__') continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listSourceFiles(full));
      continue;
    }
    if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const ALL_FILES = listSourceFiles(SRC_ROOT);

/**
 * ── Cobertura do FRONTEND (correção 20/09) ──────────────────────────────────────────────────
 * A varredura acima só olha `worker-functions/src` — mas célula pode ter consumidor SÓ no
 * `enlite-frontend` (`SCREEN_REGISTRY`, gate de container/ação, hook de acesso), sem
 * `perm.require` nenhum no backend (a resposta já chega projetada; quem nega dado é a rota, mas
 * quem CONSOME a célula para decidir o que mostrar é a tela). Sem essa camada, a régua confundia
 * "sem consumidor no backend" com "órfã de verdade" — 3 das 4 chaves acusadas em 20/09
 * (`patient_chat:read`, `patient_chat:create`, `prescreening:create`) tinham consumidor real no
 * frontend o tempo todo.
 *
 * Diretório do frontend é resolvido relativo à raiz do MONOREPO (irmão de `worker-functions`,
 * não um caminho fixo de máquina) — e se não existir, o teste FALHA aqui, alto e claro, em vez de
 * silenciar (uma régua que reduz de escopo sozinha quando não acha o alvo é pior que não existir:
 * ela passaria a aprovar chave órfã de verdade sem avisar ninguém).
 */
const FRONTEND_ROOT = resolvePath(REPO_ROOT, '..', 'enlite-frontend', 'src');
if (!existsSync(FRONTEND_ROOT) || !statSync(FRONTEND_ROOT).isDirectory()) {
  throw new Error(
    `catalogo-sem-orfao.test.ts: diretório do frontend não encontrado em "${FRONTEND_ROOT}". `
    + 'Esta régua cobre backend E frontend (correção 20/09, D115) — sem o frontend legível ela '
    + 'silenciaria órfãs que só ele consome (SCREEN_REGISTRY, ContainerGate, ActionButton, '
    + 'useActionGate, useContainerAccess, useCellAccess). Restaure o monorepo completo (o '
    + '`enlite-frontend` deve ser IRMÃO de `worker-functions`) ou ajuste FRONTEND_ROOT — nunca '
    + 'comente/pule esta checagem.',
  );
}
const FRONTEND_FILES = listSourceFiles(FRONTEND_ROOT);

/**
 * Remove comentários `//` e `/* *\/` preservando o conteúdo de strings/template literals (para
 * não cortar um `//` dentro de uma URL) — sem isso, JSDoc que MENCIONA uma chave removida
 * (`messaging:write`) seria lido como consumidor real dela.
 */
function stripComments(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  let inLine = false;
  let inBlock = false;
  let inString: string | null = null;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (inLine) {
      if (c === '\n') { inLine = false; out += c; }
      i++;
      continue;
    }
    if (inBlock) {
      if (c === '*' && next === '/') { inBlock = false; i += 2; continue; }
      if (c === '\n') out += c;
      i++;
      continue;
    }
    if (inString) {
      out += c;
      if (c === '\\') { out += next ?? ''; i += 2; continue; }
      if (c === inString) inString = null;
      i++;
      continue;
    }
    if (c === '/' && next === '/') { inLine = true; i += 2; continue; }
    if (c === '/' && next === '*') { inBlock = true; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') { inString = c; out += c; i++; continue; }
    out += c;
    i++;
  }
  return out;
}

const rawCache = new Map<string, string>();
const strippedCache = new Map<string, string>();

function raw(file: string): string {
  let v = rawCache.get(file);
  if (v === undefined) { v = readFileSync(file, 'utf8'); rawCache.set(file, v); }
  return v;
}

function stripped(file: string): string {
  let v = strippedCache.get(file);
  if (v === undefined) { v = stripComments(raw(file)); strippedCache.set(file, v); }
  return v;
}

/** Divide uma lista de argumentos respeitando parênteses/colchetes/chaves/strings aninhados. */
function splitArgs(argsRaw: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = '';
  let inString: string | null = null;
  for (let i = 0; i < argsRaw.length; i++) {
    const c = argsRaw[i];
    if (inString) {
      current += c;
      if (c === '\\') { current += argsRaw[++i] ?? ''; continue; }
      if (c === inString) inString = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { inString = c; current += c; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; current += c; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; current += c; continue; }
    if (c === ',' && depth === 0) { args.push(current); current = ''; continue; }
    current += c;
  }
  if (current.trim()) args.push(current);
  return args.map((a) => a.trim());
}

function parseParams(raw: string): string[] {
  if (!raw.trim()) return [];
  return splitArgs(raw).map((p) => p.split(':')[0].trim()).filter(Boolean);
}

/** Resolve um especificador de import (`./x`, `@modules/x`, `@shared`) para um arquivo real. */
function resolveSpecifier(fromFile: string, specifier: string): string | null {
  let candidateBase: string | null = null;
  if (specifier.startsWith('.')) {
    candidateBase = resolvePath(dirname(fromFile), specifier);
  } else {
    for (const [alias, targets] of Object.entries(TSCONFIG_PATHS)) {
      if (alias.endsWith('/*') && specifier.startsWith(alias.slice(0, -2) + '/')) {
        const rest = specifier.slice(alias.length - 2);
        candidateBase = resolvePath(REPO_ROOT, targets[0].slice(0, -2) + rest);
        break;
      } else if (alias === specifier) {
        candidateBase = resolvePath(REPO_ROOT, targets[0]);
        break;
      }
    }
  }
  if (!candidateBase) return null;
  const tryPaths = [`${candidateBase}.ts`, join(candidateBase, 'index.ts'), candidateBase];
  for (const p of tryPaths) {
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

interface Loc { file: string; name: string; }

/** Acha, no `import {...} from '...'`/`export {...} from '...'` de `file`, de onde `name` vem. */
function findImportSource(file: string, name: string): Loc | null {
  const content = raw(file);
  const re = /(?:import|export)\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  for (const m of content.matchAll(re)) {
    const names = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    for (const n of names) {
      const parts = n.split(/\s+as\s+/);
      const localName = (parts[1] ?? parts[0]).trim();
      if (localName === name) {
        const original = parts[0].trim();
        const resolved = resolveSpecifier(file, m[2]);
        if (resolved) return { file: resolved, name: original };
      }
    }
  }
  return null;
}

/** É `name` definido (const ou function) DIRETAMENTE neste arquivo? */
function isDefinedHere(file: string, name: string): boolean {
  const src = stripped(file);
  return new RegExp(`(?:export\\s+)?(?:const|function)\\s+${name}\\b`).test(src);
}

/** Segue import/re-export (inclusive barrel de vários saltos) até achar onde `name` é definido. */
function resolveNameLocation(file: string, name: string, depth: number): Loc | null {
  if (depth <= 0) return null;
  if (isDefinedHere(file, name)) return { file, name };
  const imp = findImportSource(file, name);
  if (!imp) return null;
  if (imp.file === file && imp.name === name) return null; // guarda contra ciclo trivial
  return resolveNameLocation(imp.file, imp.name, depth - 1) ?? imp;
}

function lookupRecordValue(objName: string, key: string, file: string, depth: number): string | null {
  const loc = resolveNameLocation(file, objName, depth);
  if (!loc) return null;
  const re = new RegExp(`(?:export\\s+)?const\\s+${loc.name}\\s*(?::[^=]*)?=\\s*\\{([\\s\\S]*?)\\n\\s*\\}`);
  const m = stripped(loc.file).match(re);
  if (!m) return null;
  const body = m[1];
  const keyRe = new RegExp(`(?:'${key}'|"${key}"|\\b${key})\\s*:\\s*['"]([^'"]+)['"]`);
  const km = body.match(keyRe);
  return km ? km[1] : null;
}

function resolveArrayLiteralValues(name: string, file: string, depth: number): string[] | null {
  const loc = resolveNameLocation(file, name, depth);
  if (!loc) return null;
  const re = new RegExp(`(?:export\\s+)?const\\s+${loc.name}\\s*:?[^=]*=\\s*\\[([\\s\\S]*?)\\]\\s*(?:as const)?;`);
  const m = stripped(loc.file).match(re);
  if (!m) return null;
  // Array de STRINGS simples (não tupla): pega literais que não estão dentro de outro `[`.
  const body = m[1];
  if (/\[\s*['"]/.test(body)) return null; // é array de tuplas — não é o que esta função resolve
  return [...body.matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

function resolveTupleSecondValues(name: string, file: string, depth: number): string[] | null {
  const loc = resolveNameLocation(file, name, depth);
  if (!loc) return null;
  const re = new RegExp(`(?:export\\s+)?const\\s+${loc.name}\\s*:?[^=]*=\\s*\\[([\\s\\S]*?)\\]\\s*;`);
  const m = stripped(loc.file).match(re);
  if (!m) return null;
  const body = m[1];
  const out = [...body.matchAll(/\[\s*['"][^'"]*['"]\s*,\s*['"]([^'"]+)['"]\s*\]/g)].map((x) => x[1]);
  return out.length ? out : null;
}

interface FnDef { params: string[]; bodyExpr: string; }

function findFunctionDef(file: string, name: string, depth: number): { def: FnDef; file: string } | null {
  const loc = resolveNameLocation(file, name, depth);
  if (!loc) return null;
  const src = stripped(loc.file);
  // arrow, corpo direto: const NAME = (p1, p2) => EXPR;
  let re = new RegExp(`(?:export\\s+)?const\\s+${loc.name}\\s*=\\s*\\(([^)]*)\\)\\s*(?::[^=]+)?=>\\s*([^;{][^;]*);`);
  let m = src.match(re);
  if (m) return { def: { params: parseParams(m[1]), bodyExpr: m[2].trim() }, file: loc.file };
  // arrow ou function com bloco: primeiro `return EXPR;` do corpo.
  re = new RegExp(`(?:export\\s+)?const\\s+${loc.name}\\s*=\\s*\\(([^)]*)\\)\\s*(?::[^=]+)?=>\\s*\\{[\\s\\S]*?return\\s+([^;]+);`);
  m = src.match(re);
  if (m) return { def: { params: parseParams(m[1]), bodyExpr: m[2].trim() }, file: loc.file };
  re = new RegExp(`(?:export\\s+)?function\\s+${loc.name}\\s*\\(([^)]*)\\)\\s*:[^{]*\\{[\\s\\S]*?return\\s+([^;]+);`);
  m = src.match(re);
  if (m) return { def: { params: parseParams(m[1]), bodyExpr: m[2].trim() }, file: loc.file };
  return null;
}

interface FnCtx { name: string; params: string[]; }

/** Última função (arrow ou `function`) cujo cabeçalho aparece antes de `pos` no arquivo —
 *  heurística suficiente neste código-base (um "concern" por arquivo, sem aninhamento profundo). */
function findEnclosingFunction(file: string, pos: number): FnCtx | null {
  const src = stripped(file);
  const before = src.slice(0, pos);
  let best: { index: number; name: string; params: string[] } | null = null;
  const funcRe = /function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)/g;
  const arrowRe = /(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]*)?=\s*\(([^)]*)\)\s*(?::[^=]+)?=>/g;
  for (const re of [funcRe, arrowRe]) {
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(before))) {
      if (!best || mm.index > best.index) best = { index: mm.index, name: mm[1], params: parseParams(mm[2]) };
    }
  }
  return best ? { name: best.name, params: best.params } : null;
}

/** Todas as chamadas `fnName(...)` em `src/` fora de `__tests__`, exceto a própria definição
 *  `function fnName(...)`. */
function findCallSites(fnName: string): Array<{ file: string; args: string[] }> {
  const out: Array<{ file: string; args: string[] }> = [];
  const re = new RegExp(`\\b${fnName}\\(([^()]*)\\)`, 'g');
  for (const file of ALL_FILES) {
    const src = stripped(file);
    for (const mm of src.matchAll(re)) {
      const before = src.slice(Math.max(0, mm.index - 12), mm.index);
      if (/function\s+$/.test(before)) continue;
      out.push({ file, args: splitArgs(mm[1]) });
    }
  }
  return out;
}

function resolveViaCallSiteFlow(fnName: string, paramIndex: number, depth: number): string[] | null {
  if (depth <= 0) return null;
  const sites = findCallSites(fnName);
  if (sites.length === 0) return null;
  const results: string[] = [];
  let anyResolved = false;
  for (const site of sites) {
    const argExpr = site.args[paramIndex];
    if (argExpr === undefined) continue;
    const vals = evaluate(argExpr, site.file, new Map(), depth - 1, undefined);
    if (vals !== null) { results.push(...vals); anyResolved = true; }
  }
  return anyResolved ? [...new Set(results)] : null;
}

type Scope = Map<string, string[]>;

function cartesianJoin(parts: string[][]): string[] {
  return parts.reduce<string[]>((acc, part) => acc.flatMap((a) => part.map((p) => a + p)), ['']);
}

/**
 * Avaliador central — devolve TODOS os valores literais possíveis de `exprRaw`, ou `null` quando
 * não alcança nenhuma das formas suportadas (documentadas no cabeçalho do arquivo).
 */
function evaluate(exprRaw: string, file: string, scope: Scope, depth: number, currentFn: FnCtx | undefined): string[] | null {
  if (depth <= 0) return null;
  const t = exprRaw.trim();

  const litMatch = t.match(/^['"]([^'"]*)['"]$/);
  if (litMatch) return [litMatch[1]];

  if (t.startsWith('`') && t.endsWith('`') && t.length >= 2) {
    const body = t.slice(1, -1);
    const parts: string[][] = [];
    let last = 0;
    const re = /\$\{([^}]+)\}/g;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(body))) {
      const literalChunk = body.slice(last, mm.index);
      if (literalChunk) parts.push([literalChunk]);
      const val = evaluate(mm[1], file, scope, depth - 1, currentFn);
      if (val === null) return null;
      parts.push(val);
      last = mm.index + mm[0].length;
    }
    const tail = body.slice(last);
    if (tail) parts.push([tail]);
    return cartesianJoin(parts);
  }

  const memberMatch = t.match(/^([A-Za-z_][A-Za-z0-9_]*)\[\s*([^\]]+?)\s*\]$/);
  if (memberMatch) {
    const [, objName, keyExpr] = memberMatch;
    const keys = evaluate(keyExpr, file, scope, depth - 1, currentFn);
    if (keys === null) return null;
    const values: string[] = [];
    for (const k of keys) {
      const v = lookupRecordValue(objName, k, file, depth - 1);
      if (v === null) return null;
      values.push(v);
    }
    return values;
  }

  const callMatch = t.match(/^([A-Za-z_][A-Za-z0-9_]*)\(([^()]*)\)$/);
  if (callMatch) {
    const [, fnName, argsRaw] = callMatch;
    const argExprs = splitArgs(argsRaw);
    const argVals: string[][] = [];
    for (const a of argExprs) {
      const v = evaluate(a, file, scope, depth - 1, currentFn);
      if (v === null) return null;
      argVals.push(v);
    }
    const found = findFunctionDef(file, fnName, depth - 1);
    if (!found) return null;
    const newScope: Scope = new Map();
    found.def.params.forEach((p, i) => { if (argVals[i]) newScope.set(p, argVals[i]); });
    return evaluate(found.def.bodyExpr, found.file, newScope, depth - 1, { name: fnName, params: found.def.params });
  }

  const identMatch = t.match(/^[A-Za-z_][A-Za-z0-9_]*$/);
  if (identMatch) {
    const name = t;
    if (scope.has(name)) return scope.get(name)!;
    const loc = resolveNameLocation(file, name, depth);
    if (loc) {
      const declRe = new RegExp(`(?:export\\s+)?const\\s+${loc.name}\\s*(?::[^=]+)?=\\s*([^;]+);`);
      const dm = stripped(loc.file).match(declRe);
      if (dm) return evaluate(dm[1], loc.file, new Map(), depth - 1, undefined);
    }
    // Variável de loop `for (const [_, name] of ARRAY)` — ARRAY de tuplas, pega o 2º elemento.
    const pairLoopRe = new RegExp(`for\\s*\\(\\s*const\\s*\\[\\s*[^,]+,\\s*${name}\\s*\\]\\s*of\\s*([A-Za-z_][A-Za-z0-9_]*)\\s*\\)`);
    const plm = stripped(file).match(pairLoopRe);
    if (plm) {
      const arr = resolveTupleSecondValues(plm[1], file, depth - 1);
      if (arr) return arr;
    }
    // Variável de loop `for (const name of ARRAY)` — ARRAY de strings simples.
    const singleLoopRe = new RegExp(`for\\s*\\(\\s*const\\s+${name}\\s+of\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*\\)`);
    const slm = stripped(file).match(singleLoopRe);
    if (slm) {
      const arr = resolveArrayLiteralValues(slm[1], file, depth - 1);
      if (arr) return arr;
    }
    // Identificador é PARÂMETRO da função que contém a chamada — call-site flow.
    if (currentFn && currentFn.params.includes(name)) {
      return resolveViaCallSiteFlow(currentFn.name, currentFn.params.indexOf(name), depth - 1);
    }
    return null;
  }

  return null;
}

interface ScanResult {
  consumed: Set<string>;
  unresolvedRoutes: string[];
  unresolvedIncludes: string[];
}

interface CallSiteMatch { calleeStart: number; parenOpenIndex: number; argsRaw: string; }

/**
 * Acha toda ocorrência de `<algo que casa com calleeRe> + '('` e devolve o conteúdo até o `)`
 * que fecha ESSE parêntese (balanceando aninhamento) — `[^()]*` quebra em
 * `cells.includes(dashboardSectionCell(s))` porque o argumento tem parênteses próprios.
 */
function findBalancedCalls(src: string, calleeRe: RegExp): CallSiteMatch[] {
  const out: CallSiteMatch[] = [];
  let mm: RegExpExecArray | null;
  const re = new RegExp(calleeRe.source, calleeRe.flags.includes('g') ? calleeRe.flags : `${calleeRe.flags}g`);
  while ((mm = re.exec(src))) {
    const parenOpenIndex = mm.index + mm[0].length - 1; // mm[0] termina em '('
    let depth = 1;
    let i = parenOpenIndex + 1;
    let inString: string | null = null;
    while (i < src.length && depth > 0) {
      const c = src[i];
      if (inString) {
        if (c === '\\') { i += 2; continue; }
        if (c === inString) inString = null;
        i++;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') { inString = c; i++; continue; }
      if (c === '(') depth++;
      else if (c === ')') depth--;
      i++;
    }
    if (depth === 0) {
      out.push({ calleeStart: mm.index, parenOpenIndex, argsRaw: src.slice(parenOpenIndex + 1, i - 1) });
    }
  }
  return out;
}

function scan(): ScanResult {
  const consumed = new Set<string>();
  const unresolvedRoutes: string[] = [];
  const unresolvedIncludes: string[] = [];

  const requireCalleeRe = /[A-Za-z_][A-Za-z0-9_]*\.require\(/g;
  const includesCalleeRe = /[A-Za-z_][A-Za-z0-9_.]*\.includes\(/g;

  for (const file of ALL_FILES) {
    const src = stripped(file);

    for (const call of findBalancedCalls(src, requireCalleeRe)) {
      const args = splitArgs(call.argsRaw);
      if (args.length < 2) continue;
      const enclosing = findEnclosingFunction(file, call.calleeStart) ?? undefined;
      const resources = evaluate(args[0], file, new Map(), MAX_DEPTH, enclosing);
      const actions = evaluate(args[1], file, new Map(), MAX_DEPTH, enclosing);
      if (resources && actions) {
        for (const r of resources) for (const a of actions) consumed.add(`${r}:${a}`);
      } else {
        unresolvedRoutes.push(`${relative(SRC_ROOT, file)} :: .require(${args[0]}, ${args[1]})`);
      }
    }

    for (const call of findBalancedCalls(src, includesCalleeRe)) {
      const receiver = src.slice(0, call.parenOpenIndex).match(/([A-Za-z_][A-Za-z0-9_.]*)\.includes$/)?.[1] ?? '';
      if (!/cell/i.test(receiver)) continue; // só `cells.includes(...)`/`e.cells.includes(...)` etc.
      const enclosing = findEnclosingFunction(file, call.calleeStart) ?? undefined;
      const resolved = evaluate(call.argsRaw, file, new Map(), MAX_DEPTH, enclosing);
      if (resolved) {
        for (const v of resolved) {
          if (/^[a-z0-9_]+:[a-z0-9_]+$/.test(v)) consumed.add(v);
        }
      } else {
        unresolvedIncludes.push(`${relative(SRC_ROOT, file)} :: ${receiver}.includes(${call.argsRaw})`);
      }
    }
  }

  return { consumed, unresolvedRoutes, unresolvedIncludes };
}

/**
 * Extrai o conteúdo de atributos de toda tag JSX de abertura `<tagName ...>` em `src`, balanceando
 * `{}`/`()`/`[]` e strings — sem isso, `[^>]*` pararia no primeiro `>` de um `=>` dentro de um
 * `onClick={() => ...}` (comum em `ActionButton`) e cortaria a tag ao meio.
 */
function extractOpenTags(src: string, tagName: string): string[] {
  const tags: string[] = [];
  const startRe = new RegExp(`<${tagName}\\b`, 'g');
  let sm: RegExpExecArray | null;
  while ((sm = startRe.exec(src))) {
    const start = sm.index + sm[0].length;
    let i = start;
    let depth = 0;
    let inString: string | null = null;
    while (i < src.length) {
      const c = src[i];
      if (inString) {
        if (c === '\\') { i += 2; continue; }
        if (c === inString) inString = null;
        i++;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { inString = c; i++; continue; }
      if (c === '{' || c === '(' || c === '[') { depth++; i++; continue; }
      if (c === '}' || c === ')' || c === ']') { depth--; i++; continue; }
      if (c === '>' && depth === 0) break;
      i++;
    }
    tags.push(src.slice(start, i));
    startRe.lastIndex = i;
  }
  return tags;
}

/**
 * ── O que conta como CONSUMIDOR no FRONTEND (correção 20/09) ────────────────────────────────
 * Deliberadamente mais simples que o resolvedor do backend (sem seguir import/call-site): o
 * `SCREEN_REGISTRY` já é ele mesmo a fonte plana da árvore Tela → Container → Célula (D286),
 * então basta ler os dois formatos que ele usa, mais os pontos de gate/hook que o consultam em
 * runtime, mais qualquer literal solto `'recurso:ação'`:
 *   1. `c(id, resource, [ações], ...tabs)` → expande para `resource:ação` de cada ação da lista;
 *   2. `cells: [...]` (nível de tela) → strings `'recurso:ação'` literais dentro do array;
 *   3. `<ContainerGate resource="x">` → `x:read` (é o gate de VISIBILIDADE do container, D286;
 *      não infere `write` — quem declara `write`/`create`/`update` é o `c(...)` do container);
 *   4. `<ActionButton resource="x" action="y">` → `x:y` (ordem dos atributos livre);
 *   5. `useActionGate('x','y')` / `useHasCell('x','y')` → `x:y`;
 *   6. `useContainerAccess('x')` / `useCellAccess('x')` → `x:read` (mesmo racional do item 3);
 *   7. qualquer literal solto `'recurso:ação'` em `src/` (pega `cells:` de novo e qualquer outro
 *      hardcode que os itens acima não alcancem — redundante com o item 2 de propósito, é rede
 *      de segurança, não substituto: itens 1/3/4/5/6 cobrem o que NÃO é literal combinado).
 * Não resolve identificador/import/call-site como o backend — se aparecer célula só resolvível
 * por essas vias no frontend, ela sobra como ACHADO (não como falso-vermelho silencioso: o teste
 * reporta a chave, nunca assume consumo que não viu).
 */
function scanFrontend(): Set<string> {
  const consumed = new Set<string>();
  const cellLiteralRe = /^[a-z][a-z0-9_]*:[a-z][a-z0-9_]*$/;

  for (const file of FRONTEND_FILES) {
    const src = stripped(file);

    // 1. c(id, resource, [ações], ...tabs)
    for (const m of src.matchAll(/\bc\(\s*['"][^'"]*['"]\s*,\s*['"]([^'"]+)['"]\s*,\s*\[([^\]]*)\]/g)) {
      const resource = m[1];
      for (const a of m[2].matchAll(/'([^']+)'/g)) consumed.add(`${resource}:${a[1]}`);
    }

    // 2 + 7. qualquer literal 'recurso:ação' solto no arquivo (cobre `cells: [...]` sem regra à parte).
    for (const m of src.matchAll(/['"]([^'"]+)['"]/g)) {
      if (cellLiteralRe.test(m[1])) consumed.add(m[1]);
    }

    // 3. <ContainerGate resource="x">
    for (const tag of extractOpenTags(src, 'ContainerGate')) {
      const r = tag.match(/\bresource=["']([^"']+)["']/);
      if (r) consumed.add(`${r[1]}:read`);
    }

    // 4. <ActionButton resource="x" action="y"> (atributos em qualquer ordem)
    for (const tag of extractOpenTags(src, 'ActionButton')) {
      const r = tag.match(/\bresource=["']([^"']+)["']/);
      const a = tag.match(/\baction=["']([^"']+)["']/);
      if (r && a) consumed.add(`${r[1]}:${a[1]}`);
    }

    // 5. useActionGate('x','y') / useHasCell('x','y')
    for (const m of src.matchAll(/\buse(?:ActionGate|HasCell)\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/g)) {
      consumed.add(`${m[1]}:${m[2]}`);
    }

    // 6. useContainerAccess('x') / useCellAccess('x')
    for (const m of src.matchAll(/\buse(?:ContainerAccess|CellAccess)\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      consumed.add(`${m[1]}:read`);
    }
  }

  return consumed;
}

describe('CELL_DESCRIPTION — nenhuma chave fica sem consumidor real (Fase 2, D115)', () => {
  it('a varredura do backend realmente percorre arquivos (contagem > 500) — contagem zero é falha, não sucesso', () => {
    expect(ALL_FILES.length).toBeGreaterThan(500);
  });

  it('a varredura do frontend realmente percorre arquivos (contagem > 300) — contagem zero é falha, não sucesso', () => {
    expect(FRONTEND_FILES.length).toBeGreaterThan(300);
  });

  it('toda chave de CELL_DESCRIPTION tem consumidor real — backend (perm.require/cells.includes) OU frontend (SCREEN_REGISTRY/gate/hook/literal)', () => {
    const { consumed: backendConsumed } = scan();
    const frontendConsumed = scanFrontend();
    const consumed = new Set([...backendConsumed, ...frontendConsumed]);
    const orfas = Object.keys(CELL_DESCRIPTION).filter((k) => !consumed.has(k));
    const mensagens = orfas.map(
      (k) => `${k} — SEM consumidor: nenhum perm.require('${k.split(':')[0]}', '${k.split(':')[1]}') `
        + `nem cells.includes(...) resolvível em worker-functions/src, nem SCREEN_REGISTRY/`
        + `ContainerGate/ActionButton/useActionGate/useContainerAccess/useCellAccess/literal em `
        + `enlite-frontend/src. `
        + `Ação: remover de CELL_DESCRIPTION (change catalogo-de-permissoes-derivado-do-codigo, D115) `
        + `se for órfã de verdade, OU se há consumidor que este teste não alcança, registrar por que `
        + `(célula abaixo da rota/tela com padrão novo) e ajustar o resolvedor — nunca criar allow-list muda.`,
    );
    expect(mensagens).toEqual([]);
  });
});
