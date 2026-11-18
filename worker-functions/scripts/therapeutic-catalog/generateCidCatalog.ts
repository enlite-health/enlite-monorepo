/**
 * generateCidCatalog.ts — change 091 (§9.3, DD-1, DD-4). Planilha CIE-11 -> JSON normalizado -> migration 587.
 * Funções puras (readWorkbook / normalize / renderSql) separadas do CLI (única parte com IO).
 * Colunas lidas pelo CABEÇALHO, nunca por posição. Sem rede, sem banco.
 *
 * Uso (de worker-functions/):
 *   npx ts-node --transpile-only scripts/therapeutic-catalog/generateCidCatalog.ts --xlsx <p> --json <p> --sql <p>
 */
import crypto from 'crypto';
import fs from 'fs';
import * as XLSX from 'xlsx';
import { v5 as uuidv5 } from 'uuid';

// ---------- erros nomeados (um por regra de §9.3) ----------
export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
export class MissingColumnError extends CatalogError {}
export class InvalidRowIdError extends CatalogError {}
export class UnknownServiceError extends CatalogError {}
export class InvalidCategoryError extends CatalogError {}
export class UnknownObjectiveError extends CatalogError {}
export class ObjectiveFieldConflictError extends CatalogError {}
export class ActivityFrequencyConflictError extends CatalogError {}
export class ActivityCategoryOutsideObjectiveError extends CatalogError {}
export class KeyCollisionError extends CatalogError {}
export class DuplicateLinkError extends CatalogError {}

// ---------- tipos ----------
export type Linha = Readonly<Record<string, string>>;
export interface PlanilhaBruta {
  readonly objetivos: readonly Linha[];
  readonly atividades: readonly Linha[];
}
export interface Vinculo { readonly codigo: string; readonly ordem: number }
export interface ObjetivoNormalizado {
  readonly id: string; readonly serviceCode: string; readonly titulo: string; readonly descricao: string;
  readonly pregunta: string; readonly escala: string; readonly indicador: string; readonly categorias: readonly Vinculo[];
}
export interface AtividadeNormalizada {
  readonly id: string; readonly objetivoId: string; readonly titulo: string; readonly descricao: string;
  readonly frecuencia: string; readonly escala: string; readonly categorias: readonly Vinculo[];
}
export interface CatalogoNormalizado {
  readonly fonte: { readonly arquivo: string; readonly sha256: string };
  readonly servicos: Readonly<Record<string, string>>;
  readonly objetivos: readonly ObjetivoNormalizado[];
  readonly atividades: readonly AtividadeNormalizada[];
}
export interface OrigemPlanilha { readonly arquivo: string; readonly sha256: string }

// ---------- constantes ----------
/** DD-1: namespace fixo; muda-lo muda todos os ids. */
export const CATALOG_NAMESPACE = '5d0b1c2e-0910-5a41-9c3e-7b1f0a6d4e91';
/** Tabela (Strategy por dado): rótulo da planilha -> service_code do banco. */
export const SERVICOS: Readonly<Record<string, string>> = { AT: 'AT', Cuidado: 'CAREGIVER' };
const CATEGORIA = /^[0-9A-Z]{4}$/;
const ID_LINHA = /^([^-\s]+)-(AT|CU)-([OA])(\d+)$/;
const ABA_OBJETIVOS = 'Objetivos específicos';
const ABA_ATIVIDADES = 'Actividades de rutina';
const COLS_OBJ = ['ID', 'Tipo de servicio', 'Código CIE-11', 'Título', 'Descripción',
  'Pregunta del registro diario (EnLite)', 'Escala del registro diario (EnLite)', 'Indicador operativo (EnLite)'];
const COLS_ATV = ['ID', 'Tipo de servicio', 'Código CIE-11', 'Título', 'Descripción', 'ID objetivo',
  'Frecuencia sugerida', 'Escala del registro diario (EnLite)'];

// ---------- leitura ----------
function lerAba(wb: XLSX.WorkBook, aba: string, colunas: readonly string[]): Linha[] {
  const ws = wb.Sheets[aba];
  if (!ws) throw new MissingColumnError(`aba ausente: ${aba}`);
  const matriz = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '', raw: true });
  const cab = (matriz[0] ?? []).map((c) => String(c).trim());
  const falta = colunas.filter((c) => !cab.includes(c));
  if (falta.length) throw new MissingColumnError(`aba ${aba}: coluna(s) ausente(s): ${falta.join(', ')}`);
  return matriz.slice(1)
    .filter((r) => r.some((c) => String(c).trim() !== ''))
    .map((r) => Object.fromEntries(cab.map((nome, i) => [nome, String(r[i] ?? '').trim()])));
}

export function readWorkbook(buf: Buffer): PlanilhaBruta {
  const wb = XLSX.read(buf, { type: 'buffer' });
  return { objetivos: lerAba(wb, ABA_OBJETIVOS, COLS_OBJ), atividades: lerAba(wb, ABA_ATIVIDADES, COLS_ATV) };
}

// ---------- normalização ----------
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const porCodigo = (a: Vinculo, b: Vinculo): number => cmp(a.codigo, b.codigo);

interface LinhaLida { readonly ordem: number; readonly categoria: string; readonly servico: string; readonly linha: Linha }

function lerLinha(linha: Linha): LinhaLida {
  const m = ID_LINHA.exec(linha['ID']);
  if (!m) throw new InvalidRowIdError(`ID fora do formato <cat>-<AT|CU>-<O|A><n>: "${linha['ID']}"`);
  const servico = linha['Tipo de servicio'];
  if (!Object.prototype.hasOwnProperty.call(SERVICOS, servico)) {
    throw new UnknownServiceError(`serviço desconhecido "${servico}" na linha ${linha['ID']}`);
  }
  const categoria = linha['Código CIE-11'];
  if (!CATEGORIA.test(categoria)) {
    throw new InvalidCategoryError(`categoria "${categoria}" fora de ^[0-9A-Z]{4}$ na linha ${linha['ID']}`);
  }
  return { ordem: Number(m[4]), categoria, servico, linha };
}

/** Agrupa preservando a ordem de chegada. */
function agrupar<T>(itens: readonly T[], chave: (t: T) => string): Map<string, T[]> {
  const mapa = new Map<string, T[]>();
  for (const it of itens) {
    const k = chave(it);
    const g = mapa.get(k);
    if (g) g.push(it); else mapa.set(k, [it]);
  }
  return mapa;
}

/** DD-1: lower(btrim()) não pode colapsar duas chaves que o texto cru distingue. */
function exigirSemColisao(chaves: Iterable<string>, tipo: string): void {
  const vistas = new Map<string, string>();
  for (const k of chaves) {
    const norm = k.trim().toLowerCase();
    const anterior = vistas.get(norm);
    if (anterior !== undefined && anterior !== k) {
      throw new KeyCollisionError(`${tipo}: lower(btrim()) colapsa "${anterior}" e "${k}"`);
    }
    vistas.set(norm, k);
  }
}

function valorUnico(grupo: readonly LinhaLida[], coluna: string, erro: new (m: string) => CatalogError, quem: string): string {
  const valores = new Set(grupo.map((g) => g.linha[coluna]));
  if (valores.size > 1) throw new erro(`${quem}: "${coluna}" varia (${valores.size} valores)`);
  return [...valores][0];
}

function vinculos(grupo: readonly LinhaLida[], quem: string): Vinculo[] {
  const porCat = new Map<string, number>();
  for (const g of grupo) {
    if (porCat.has(g.categoria)) throw new DuplicateLinkError(`${quem}: categoria ${g.categoria} repetida`);
    porCat.set(g.categoria, g.ordem);
  }
  return [...porCat].map(([codigo, ordem]) => ({ codigo, ordem })).sort(porCodigo);
}

export function normalize(bruta: PlanilhaBruta, origem: OrigemPlanilha = { arquivo: '', sha256: '' }): CatalogoNormalizado {
  const objLidos = bruta.objetivos.map(lerLinha);
  const atvLidas = bruta.atividades.map(lerLinha);

  // objetivos: chave natural DD-1 `obj|<service_code>|<título>|<descrição>`
  const chaveObj = (l: LinhaLida) => `obj|${SERVICOS[l.servico]}|${l.linha['Título']}|${l.linha['Descripción']}`;
  const gruposObj = agrupar(objLidos, chaveObj);
  exigirSemColisao(gruposObj.keys(), 'objetivo');

  const idPorLinha = new Map<string, string>(); // ID da linha da planilha -> uuid do objetivo
  const catsDoObjetivo = new Map<string, Set<string>>();
  const objetivos: ObjetivoNormalizado[] = [];
  for (const [chave, grupo] of gruposObj) {
    const id = uuidv5(chave, CATALOG_NAMESPACE);
    const quem = `objetivo ${grupo[0].linha['ID']}`;
    const cats = vinculos(grupo, quem);
    for (const g of grupo) idPorLinha.set(g.linha['ID'], id);
    catsDoObjetivo.set(id, new Set(cats.map((c) => c.codigo)));
    objetivos.push({
      id, serviceCode: SERVICOS[grupo[0].servico], titulo: grupo[0].linha['Título'], descricao: grupo[0].linha['Descripción'],
      pregunta: valorUnico(grupo, 'Pregunta del registro diario (EnLite)', ObjectiveFieldConflictError, quem),
      escala: valorUnico(grupo, 'Escala del registro diario (EnLite)', ObjectiveFieldConflictError, quem),
      indicador: valorUnico(grupo, 'Indicador operativo (EnLite)', ObjectiveFieldConflictError, quem),
      categorias: cats,
    });
  }

  // atividades: chave natural DD-1 `act|<id do objetivo>|<título>|<descrição>`
  const comObjetivo = atvLidas.map((l) => {
    const ref = l.linha['ID objetivo'];
    const objetivoId = idPorLinha.get(ref);
    if (!objetivoId) throw new UnknownObjectiveError(`atividade ${l.linha['ID']}: ID objetivo inexistente "${ref}"`);
    return { l, objetivoId };
  });
  const gruposAtv = agrupar(comObjetivo, (x) => `act|${x.objetivoId}|${x.l.linha['Título']}|${x.l.linha['Descripción']}`);
  exigirSemColisao(gruposAtv.keys(), 'atividade');

  const atividades: AtividadeNormalizada[] = [];
  for (const [chave, grupo] of gruposAtv) {
    const linhas = grupo.map((x) => x.l);
    const quem = `atividade ${linhas[0].linha['ID']}`;
    const objetivoId = grupo[0].objetivoId;
    const cats = vinculos(linhas, quem);
    const permitidas = catsDoObjetivo.get(objetivoId) as Set<string>;
    const fora = cats.find((c) => !permitidas.has(c.codigo));
    if (fora) throw new ActivityCategoryOutsideObjectiveError(`${quem}: categoria ${fora.codigo} fora das do objetivo`);
    atividades.push({
      id: uuidv5(chave, CATALOG_NAMESPACE), objetivoId,
      titulo: linhas[0].linha['Título'], descricao: linhas[0].linha['Descripción'],
      frecuencia: valorUnico(linhas, 'Frecuencia sugerida', ActivityFrequencyConflictError, quem),
      escala: valorUnico(linhas, 'Escala del registro diario (EnLite)', ObjectiveFieldConflictError, quem),
      categorias: cats,
    });
  }

  objetivos.sort((a, b) => cmp(a.serviceCode, b.serviceCode) || cmp(a.titulo, b.titulo) || cmp(a.descricao, b.descricao));
  atividades.sort((a, b) => cmp(a.objetivoId, b.objetivoId) || cmp(a.titulo, b.titulo) || cmp(a.descricao, b.descricao));
  return { fonte: origem, servicos: { ...SERVICOS }, objetivos, atividades };
}

// ---------- SQL ----------
const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const md5 = (s: string): string => crypto.createHash('md5').update(s).digest('hex');

/** md5 do string_agg(<dono>||':'||category_code, ',' ORDER BY <dono>, category_code) — a T505 compara em prd (CA-17). */
export function checksumVinculos(itens: readonly { id: string; categorias: readonly Vinculo[] }[]): string {
  const pares = itens.flatMap((i) => i.categorias.map((c) => [i.id, c.codigo] as const))
    .sort((a, b) => cmp(a[0], b[0]) || cmp(a[1], b[1]));
  return md5(pares.map(([id, cod]) => `${id}:${cod}`).join(','));
}

function blocoVinculos(tabela: string, colunas: string, itens: readonly { id: string; objetivoId?: string; categorias: readonly Vinculo[] }[], comObjetivo: boolean): string {
  const valores = itens.map((i) => {
    const arr = (f: (c: Vinculo) => string) => `ARRAY[${i.categorias.map(f).join(',')}]`;
    const obj = comObjetivo ? `, ${lit(i.objetivoId as string)}` : '';
    return `  (${lit(i.id)}${obj}, ${arr((c) => lit(c.codigo))}, ${arr((c) => String(c.ordem))})`;
  }).join(',\n');
  const objSel = comObjetivo ? 'v.objective_id::uuid, ' : '';
  const objAlias = comObjetivo ? 'objective_id, ' : '';
  return `INSERT INTO ${tabela} (${colunas})\nSELECT v.id::uuid, ${objSel}c.code, c.ord, 'seed:587'\nFROM (VALUES\n${valores}\n) v(id, ${objAlias}codes, ords), unnest(v.codes, v.ords) AS c(code, ord)\nON CONFLICT DO NOTHING;`;
}

export function renderSql(cat: CatalogoNormalizado): string {
  const sha = cat.fonte.sha256;
  const objs = cat.objetivos.map((o) =>
    `  (${lit(o.id)}, ${lit(o.titulo)}, ${lit(o.descricao)}, ${lit(o.serviceCode)}, 'seed:587', 'seed:587')`).join(',\n');
  const atvs = cat.atividades.map((a) =>
    `  (${lit(a.id)}, ${lit(a.titulo)}, ${lit(a.descricao)}, ${lit(a.objetivoId)}, ${lit(a.frecuencia)}, 'seed:587', 'seed:587')`).join(',\n');
  return [
    `-- GERADO por scripts/therapeutic-catalog/generateCidCatalog.ts — não editar à mão; fonte sha256 ${sha}`,
    `-- objetivos: ${cat.objetivos.length} · atividades: ${cat.atividades.length}`,
    `-- md5 vínculos objetivo (string_agg(objective_id||':'||category_code, ',' ORDER BY objective_id, category_code)): ${checksumVinculos(cat.objetivos)}`,
    `-- md5 vínculos atividade (string_agg(activity_id||':'||category_code, ',' ORDER BY activity_id, category_code)): ${checksumVinculos(cat.atividades)}`,
    '',
    'INSERT INTO therapeutic_specific_objectives (id, label, description, service_code, created_by, updated_by) VALUES',
    `${objs}\nON CONFLICT (id) DO NOTHING;`,
    '',
    'INSERT INTO therapeutic_activities (id, label, description, objective_id, suggested_frequency, created_by, updated_by) VALUES',
    `${atvs}\nON CONFLICT (id) DO NOTHING;`,
    '',
    blocoVinculos('therapeutic_objective_icd_categories', 'objective_id, category_code, sort_order, created_by', cat.objetivos, false),
    '',
    blocoVinculos('therapeutic_activity_icd_categories', 'activity_id, objective_id, category_code, sort_order, created_by',
      cat.atividades, true),
    '',
  ].join('\n');
}

// ---------- CLI (único trecho com IO) ----------
function argumento(argv: readonly string[], nome: string): string {
  const i = argv.indexOf(nome);
  if (i < 0 || !argv[i + 1]) throw new CatalogError(`uso: --xlsx <p> --json <p> --sql <p> (falta ${nome})`);
  return argv[i + 1];
}

export function main(argv: readonly string[]): void {
  const xlsx = argumento(argv, '--xlsx');
  const buf = fs.readFileSync(xlsx);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const cat = normalize(readWorkbook(buf), { arquivo: xlsx.split('/').pop() as string, sha256 });
  fs.writeFileSync(argumento(argv, '--json'), JSON.stringify(cat, null, 2) + '\n');
  fs.writeFileSync(argumento(argv, '--sql'), renderSql(cat));
  const soma = (xs: readonly { categorias: readonly Vinculo[] }[]) => xs.reduce((n, x) => n + x.categorias.length, 0);
  console.log(`objetivos ${cat.objetivos.length} atividades ${cat.atividades.length} `
    + `vinculos_obj ${soma(cat.objetivos)} vinculos_ativ ${soma(cat.atividades)}`);
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`${(e as Error).name}: ${(e as Error).message}`);
    process.exit(1);
  }
}
