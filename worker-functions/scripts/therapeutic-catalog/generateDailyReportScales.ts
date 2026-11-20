/**
 * generateDailyReportScales.ts — change 092 (T102). Planilha CIE-11 (aba "Escalas de respuesta") + JSON normalizado da 091
 * -> migration 589 (carga do catálogo de escalas do registro diário). Determinístico: mesma entrada, mesmos bytes.
 * Funções puras (readScales / renderDailyReportSql) separadas do CLI (única parte com IO). Colunas lidas pelo CABEÇALHO.
 *
 * Regras (design 092 §Dados / §5):
 *  - score só quando a PRÓPRIA opção é um número na planilha (F-2); a planilha não tem coluna de nota;
 *  - alert_kind pela coluna literal "Qué hace la app": IMMEDIATE só para "Avisa a coordinación" [+ "en el momento"];
 *    REPEAT / CHANGE / CONDITIONAL pelas demais formas conhecidas; NULL em "—"; texto desconhecido = erro nomeado (nada de chute);
 *  - CNT (COUNT) e OM (MULTI_CHOICE) não têm linhas de opção na V1;
 *  - o mapa rótulo-do-objetivo/atividade -> código da escala (18 pares) mora aqui; rótulo sem par = erro nomeado.
 *
 * Uso (de worker-functions/):
 *   npx ts-node --transpile-only scripts/therapeutic-catalog/generateDailyReportScales.ts --xlsx <p> --json <p> --sql <p>
 */
import crypto from 'crypto';
import fs from 'fs';
import * as XLSX from 'xlsx';
import { CatalogError, CatalogoNormalizado } from './generateCidCatalog';

// ---------- erros nomeados ----------
export class ScalesSheetError extends CatalogError {}
export class UnmappedScaleLabelError extends CatalogError {}
export class UnknownScaleCodeError extends CatalogError {}
export class UnknownAnsweredByError extends CatalogError {}
export class UnknownAlertTextError extends CatalogError {}
export class OptionCodeCollisionError extends CatalogError {}
export class ReasonListConflictError extends CatalogError {}
export class MissingQuestionError extends CatalogError {}
export class SourceMismatchError extends CatalogError {}

// ---------- tipos ----------
export interface OpcaoBruta { readonly opcao: string; readonly significado: string; readonly app: string }
export interface EscalaBruta {
  readonly code: string; readonly nome: string; readonly uso: string; readonly quem: string; readonly opcoes: readonly OpcaoBruta[];
}
export type AlertKind = 'IMMEDIATE' | 'REPEAT' | 'CHANGE' | 'CONDITIONAL';
type AnswerKind = 'SINGLE_CHOICE' | 'COUNT' | 'MULTI_CHOICE';

// ---------- tabelas (Strategy por dado) ----------
const ABA_ESCALAS = 'Escalas de respuesta';
const COLS_ESC = ['Código', 'Escala', 'Para qué se usa', 'Quién la responde', 'Opción', 'Qué significa', 'Qué hace la app'];
const SEM_AVISO = new Set(['', '—']);
const PEDE_MOTIVO = 'Pide el motivo: ';

/** "Quién la responde" da planilha -> answered_by do banco. */
const RESPONDE: Readonly<Record<string, string>> = { AT: 'AT', 'Cuidador/a': 'CAREGIVER' };

/** Escala -> tipo de resposta. Fora da tabela = SINGLE_CHOICE (botões). CNT e OM não geram linhas de opção na V1. */
const KIND_ESPECIAL: Readonly<Record<string, AnswerKind>> = { CNT: 'COUNT', OM: 'MULTI_CHOICE' };

/** 18 pares: rótulo da coluna "Escala del registro diario (EnLite)" (objetivos e atividades) -> código da aba de escalas. */
export const ESCALA_POR_ROTULO: Readonly<Record<string, string>> = {
  'Ánimo observado (1 a 5)': 'ANI',
  'Sueño (1 a 5)': 'SUE',
  'Estado general (1 a 5)': 'GEN',
  'Orientación (1 a 5)': 'ORI',
  'Comunicación (1 a 5)': 'COM',
  'Interés e iniciativa (1 a 5)': 'INI',
  'Desempeño: Solo / Con ayuda verbal / Con ayuda física / No lo hizo': 'AUT',
  'Frecuencia: Nunca / A veces / Seguido / Todo el tiempo': 'FRE',
  'Dolor: Sin dolor / Leve / Moderado / Intenso': 'DOL',
  'Sí / No': 'SN',
  'Conteo (número)': 'CNT',
  'Opción múltiple de alerta (lista del PT)': 'OM',
  'Botones: Lo hizo solo / Lo ayudé / No lo hizo': 'C-HIZO',
  'Botones: Sí / No': 'C-SINO',
  'Botones: Contento / Normal / Mal': 'C-ANI',
  'Botones: No le duele / Un poco / Mucho': 'C-DOL',
  'Botones: cuántas veces': 'C-CNT',
  'Botones: Pasó algo / No pasó nada': 'C-ALE',
};

/** Ordem importa: a 1ª regra que casa vence. IMMEDIATE é ancorado — só as duas formas literais. */
const REGRAS_AVISO: readonly (readonly [RegExp, AlertKind])[] = [
  [/^Avisa a coordinación( en el momento)?$/, 'IMMEDIATE'],
  [/si se repite/i, 'REPEAT'],
  [/^Si es un cambio respecto de la guardia anterior, avisa a coordinación$/, 'CHANGE'],
  [/^En .+avisa a coordinación$/, 'CONDITIONAL'],
];

// ---------- leitura ----------
export function readScales(buf: Buffer): EscalaBruta[] {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[ABA_ESCALAS];
  if (!ws) throw new ScalesSheetError(`aba ausente: ${ABA_ESCALAS}`);
  const matriz = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, defval: '', raw: true });
  const cab = (matriz[0] ?? []).map((c) => String(c).trim());
  const falta = COLS_ESC.filter((c) => !cab.includes(c));
  if (falta.length) throw new ScalesSheetError(`aba ${ABA_ESCALAS}: coluna(s) ausente(s): ${falta.join(', ')}`);
  const linhas = matriz.slice(1)
    .filter((r) => r.some((c) => String(c).trim() !== ''))
    .map((r) => Object.fromEntries(cab.map((nome, i) => [nome, String(r[i] ?? '').trim()])));

  const porCodigo = new Map<string, { code: string; nome: string; uso: string; quem: string; opcoes: OpcaoBruta[] }>();
  for (const l of linhas) {
    const code = l['Código'];
    const esc = porCodigo.get(code)
      ?? { code, nome: l['Escala'], uso: l['Para qué se usa'], quem: l['Quién la responde'], opcoes: [] };
    esc.opcoes.push({ opcao: l['Opción'], significado: l['Qué significa'], app: l['Qué hace la app'] });
    porCodigo.set(code, esc);
  }
  return [...porCodigo.values()];
}

// ---------- normalização ----------
const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const litOuNull = (s: string | null): string => (s === null ? 'NULL' : lit(s));
const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Rótulo -> chave estável: minúsculas, sem acento, não-alfanumérico vira "_". Números ficam como estão. */
export function slug(rotulo: string): string {
  return rotulo.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export function classifyAlert(app: string, quem: string): AlertKind | null {
  if (SEM_AVISO.has(app) || app.startsWith(PEDE_MOTIVO)) return null;
  const regra = REGRAS_AVISO.find(([re]) => re.test(app));
  if (!regra) throw new UnknownAlertTextError(`${quem}: texto de aviso sem regra: "${app}"`);
  return regra[1];
}

interface OpcaoNormalizada {
  readonly code: string; readonly position: number; readonly label: string; readonly meaning: string;
  readonly score: number | null; readonly alertKind: AlertKind | null; readonly alertText: string | null; readonly asksReason: boolean;
}
interface EscalaNormalizada {
  readonly code: string; readonly nome: string; readonly uso: string; readonly answeredBy: string; readonly answerKind: AnswerKind;
  readonly opcoes: readonly OpcaoNormalizada[]; readonly motivos: readonly { code: string; position: number; label: string }[];
}

function normalizarEscala(e: EscalaBruta): EscalaNormalizada {
  const answeredBy = RESPONDE[e.quem];
  if (!answeredBy) throw new UnknownAnsweredByError(`escala ${e.code}: "Quién la responde" desconhecido "${e.quem}"`);
  if (!Object.values(ESCALA_POR_ROTULO).includes(e.code)) throw new UnknownScaleCodeError(`código de escala fora do mapa de 18: "${e.code}"`);
  const answerKind = KIND_ESPECIAL[e.code] ?? 'SINGLE_CHOICE';

  const opcoes: OpcaoNormalizada[] = [];
  let motivos: string[] | null = null;
  if (answerKind === 'SINGLE_CHOICE') {
    e.opcoes.forEach((o, i) => {
      const quem = `escala ${e.code} opção "${o.opcao}"`;
      const code = slug(o.opcao);
      if (!code) throw new OptionCodeCollisionError(`${quem}: rótulo sem caractere alfanumérico`);
      if (opcoes.some((x) => x.code === code)) throw new OptionCodeCollisionError(`${quem}: código "${code}" repetido na escala`);
      const kind = classifyAlert(o.app, quem);
      const asksReason = o.app.startsWith(PEDE_MOTIVO);
      if (asksReason) {
        const lista = o.app.slice(PEDE_MOTIVO.length).split(' / ').map((s) => s.trim());
        if (motivos && JSON.stringify(motivos) !== JSON.stringify(lista)) throw new ReasonListConflictError(`${quem}: lista de motivos difere da já lida`);
        motivos = lista;
      }
      opcoes.push({
        code, position: i + 1, label: o.opcao, meaning: o.significado,
        score: /^\d+$/.test(o.opcao) ? Number(o.opcao) : null,
        alertKind: kind, alertText: kind ? o.app : null, asksReason,
      });
    });
  }
  const motivosNorm = (motivos ?? []).map((label, i) => ({ code: slug(label), position: i + 1, label }));
  if (new Set(motivosNorm.map((m) => m.code)).size !== motivosNorm.length) {
    throw new OptionCodeCollisionError(`escala ${e.code}: código de motivo repetido`);
  }
  return { code: e.code, nome: e.nome, uso: e.uso, answeredBy, answerKind, opcoes, motivos: motivosNorm };
}

function codigoDaEscala(rotulo: string, quem: string): string {
  const code = Object.prototype.hasOwnProperty.call(ESCALA_POR_ROTULO, rotulo) ? ESCALA_POR_ROTULO[rotulo] : undefined;
  if (!code) throw new UnmappedScaleLabelError(`${quem}: rótulo de escala sem par no mapa de 18: "${rotulo}"`);
  return code;
}

// ---------- SQL ----------
const linhasSql = (itens: readonly string[]): string => itens.map((i) => `  (${i})`).join(',\n');

export function renderDailyReportSql(escalasBrutas: readonly EscalaBruta[], cat: CatalogoNormalizado): string {
  const escalas = escalasBrutas.map(normalizarEscala);
  const codigosNaAba = new Set(escalas.map((e) => e.code));
  for (const code of Object.values(ESCALA_POR_ROTULO)) {
    if (!codigosNaAba.has(code)) throw new UnknownScaleCodeError(`escala ${code} do mapa de 18 ausente na aba "${ABA_ESCALAS}"`);
  }

  const objetivos = [...cat.objetivos].sort((a, b) => cmp(a.id, b.id)).map((o) => {
    const quem = `objetivo ${o.id}`;
    if (!o.pregunta) throw new MissingQuestionError(`${quem}: sem pergunta no catálogo`);
    return `${lit(o.id)}, ${lit(o.pregunta)}, ${lit(codigoDaEscala(o.escala, quem))}, ${litOuNull(o.indicador || null)}`;
  });
  const atividades = [...cat.atividades].sort((a, b) => cmp(a.id, b.id)).map((a) =>
    `${lit(a.id)}, ${lit(codigoDaEscala(a.escala, `atividade ${a.id}`))}`);

  const opcoes = escalas.flatMap((e) => e.opcoes.map((o) => [e.code, o] as const));
  const motivos = escalas.flatMap((e) => e.motivos.map((m) => [e.code, m] as const));
  const comScore = opcoes.filter(([, o]) => o.score !== null).length;
  const escalaSql = escalas.map((e) => `${lit(e.code)}, ${lit(e.nome)}, ${lit(e.uso)}, ${lit(e.answeredBy)}, ${lit(e.answerKind)}`);
  const opcaoSql = opcoes.map(([code, o]) =>
    `${lit(code)}, ${lit(o.code)}, ${o.position}, ${lit(o.label)}, ${lit(o.meaning)}, ${o.score ?? 'NULL'}, `
    + `${litOuNull(o.alertKind)}, ${litOuNull(o.alertText)}, ${o.asksReason}`);
  const motivoSql = motivos.map(([code, m]) => `${lit(code)}, ${lit(m.code)}, ${m.position}, ${lit(m.label)}`);

  return [
    `-- GERADO por scripts/therapeutic-catalog/generateDailyReportScales.ts — não editar à mão; fonte sha256 ${cat.fonte.sha256}`,
    `-- escalas: ${escalas.length} · opções: ${opcoes.length} · motivos: ${motivos.length} · objetivos: ${objetivos.length} · atividades: ${atividades.length}`,
    `-- opções com nota numérica (a própria opção é número na planilha): ${comScore} · sem nota (a planilha não define, L1): ${opcoes.length - comScore}`,
    `-- avisos por tipo — IMMEDIATE: ${opcoes.filter(([, o]) => o.alertKind === 'IMMEDIATE').length}`
      + ` · REPEAT: ${opcoes.filter(([, o]) => o.alertKind === 'REPEAT').length}`
      + ` · CHANGE: ${opcoes.filter(([, o]) => o.alertKind === 'CHANGE').length}`
      + ` · CONDITIONAL: ${opcoes.filter(([, o]) => o.alertKind === 'CONDITIONAL').length}`,
    '',
    'INSERT INTO daily_report_scales (code, name_es, purpose_es, answered_by, answer_kind) VALUES',
    `${linhasSql(escalaSql)}\nON CONFLICT (code) DO NOTHING;`,
    '',
    'INSERT INTO daily_report_scale_options (scale_code, option_code, position, label_es, meaning_es, score, alert_kind, alert_text_es, asks_reason) VALUES',
    `${linhasSql(opcaoSql)}\nON CONFLICT (scale_code, option_code) DO NOTHING;`,
    '',
    'INSERT INTO daily_report_scale_reasons (scale_code, reason_code, position, label_es) VALUES',
    `${linhasSql(motivoSql)}\nON CONFLICT (scale_code, reason_code) DO NOTHING;`,
    '',
    'UPDATE therapeutic_specific_objectives t',
    '   SET daily_question = v.q, daily_scale_code = v.s, operative_indicator = v.i',
    '  FROM (VALUES',
    `${linhasSql(objetivos)}`,
    ') AS v(id, q, s, i)',
    ' WHERE t.id = v.id::uuid;',
    '',
    'UPDATE therapeutic_activities t',
    '   SET daily_scale_code = v.s',
    '  FROM (VALUES',
    `${linhasSql(atividades)}`,
    ') AS v(id, s)',
    ' WHERE t.id = v.id::uuid;',
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
  const buf = fs.readFileSync(argumento(argv, '--xlsx'));
  const cat = JSON.parse(fs.readFileSync(argumento(argv, '--json'), 'utf8')) as CatalogoNormalizado;
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  if (sha256 !== cat.fonte.sha256) {
    throw new SourceMismatchError(`xlsx sha256 ${sha256} != JSON da 091 ${cat.fonte.sha256}`);
  }
  const sql = renderDailyReportSql(readScales(buf), cat);
  fs.writeFileSync(argumento(argv, '--sql'), sql);
  console.log(sql.split('\n').slice(1, 4).map((l) => l.replace(/^-- /, '')).join('\n'));
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`${(e as Error).name}: ${(e as Error).message}`);
    process.exit(1);
  }
}
