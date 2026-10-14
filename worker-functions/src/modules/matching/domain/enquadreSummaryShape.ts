/**
 * Forma do JSON do resumo de ENCUADRE (spec 052, Fase 3, T-36b): a "Forma da saída estruturada (JSON)" do rascunho do prompt.
 * Puro, sem I/O. Só NOMES de campo (caminho, ex.: `prestadores[1].interes`) voltam em `fields` — nunca um valor do resumo.
 * O gate da admissão (`admissionSummaryShape`) não serve aqui: outro esquema, outro estado fixo.
 */
export const ENQUADRE_SUMMARY_STATE_DRAFT = 'BORRADOR_PARA_REVISION';

const TOP_LISTS = ['sin_atribuir', 'campos_faltantes', 'preguntas_sugeridas'] as const;
const TEMAS = ['horario', 'zona', 'modalidad', 'honorarios', 'proximos_pasos'] as const;
const INTERES = ['quiere', 'quiere_con_condiciones', 'no_quiere', 'no_quedo_claro'] as const;
const ACEPTA_HORARIO = ['si', 'con_cambios', 'no', 'no_se_hablo'] as const;
const ACEPTA_ZONA = ['si', 'con_reparos', 'no', 'no_se_hablo'] as const;
const OBJECION = ['si', 'no', 'no_se_hablo'] as const;
const DE_QUIEN = ['prestador', 'entrevistadora'] as const;
const ALERTA_TIPO = ['horario', 'conducta', 'riesgo_relatado', 'otro'] as const;
const ENCUADRE_CODE = /^ENC-[0-9A-Z]{6}$/;

export type EnquadreShapeVerdict = { ok: true } | { ok: false; reason: 'json_invalid' | 'schema_invalid'; fields: string[] };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isStrOrNull = (v: unknown): boolean => v === null || isStr(v);
const oneOf = (v: unknown, set: readonly string[]): boolean => isStr(v) && set.includes(v);

/** `arr` é lista e cada item passa em `item`; devolve os caminhos que falharam (`path[i]`). */
function checkList(arr: unknown, path: string, item: (x: Record<string, unknown>) => boolean): string[] {
  if (!Array.isArray(arr)) return [path];
  return arr.flatMap((x, i) => (isObj(x) && item(x) ? [] : [`${path}[${i}]`]));
}

const evidences = (v: unknown, path: string): string[] => checkList(v, path, (e) => isStr(e.cita) && isStr(e.fuente));

function checkPrestador(p: Record<string, unknown>, at: string, refs: ReadonlySet<string>): string[] {
  const bad: string[] = [];
  const need = (ok: boolean, field: string): void => {
    if (!ok) bad.push(`${at}.${field}`);
  };
  const obj = (field: string): Record<string, unknown> => (isObj(p[field]) ? (p[field] as Record<string, unknown>) : {});
  need(isStr(p.nombre_en_transcripcion), 'nombre_en_transcripcion');
  // `convocado_ref` tem de ser uma `ref` da lista ENVIADA ao modelo (ou nulo): ref inventada = rejeita.
  need(p.convocado_ref === null || (isStr(p.convocado_ref) && refs.has(p.convocado_ref)), 'convocado_ref');
  const des = obj('desenvolvimiento');
  need(isObj(p.desenvolvimiento) && isStr(des.texto) && evidences(des.evidencias, '').length === 0, 'desenvolvimiento');
  need(isObj(p.interes) && oneOf(obj('interes').valor, INTERES) && isStr(obj('interes').cita), 'interes');
  const dis = obj('disponibilidad');
  need(isObj(p.disponibilidad) && isStrOrNull(dis.texto) && oneOf(dis.acepta_horario, ACEPTA_HORARIO) && evidences(dis.evidencias, '').length === 0, 'disponibilidad');
  const zon = obj('zona_traslado');
  need(isObj(p.zona_traslado) && isStrOrNull(zon.texto) && oneOf(zon.acepta_zona, ACEPTA_ZONA) && evidences(zon.evidencias, '').length === 0, 'zona_traslado');
  const exp = obj('experiencia_relevante');
  need(
    isObj(p.experiencia_relevante) && isStrOrNull(exp.texto) && Array.isArray(exp.tipos) && exp.tipos.every(isStr) &&
      (exp.anios === null || typeof exp.anios === 'number') && evidences(exp.evidencias, '').length === 0,
    'experiencia_relevante',
  );
  need(isObj(p.honorarios) && oneOf(obj('honorarios').objecion, OBJECION) && isStr(obj('honorarios').cita), 'honorarios');
  bad.push(...checkList(p.dudas_condiciones, `${at}.dudas_condiciones`, (d) => isStr(d.texto) && isStr(d.cita)));
  bad.push(...checkList(p.compromisos, `${at}.compromisos`, (c) => isStr(c.texto) && oneOf(c.de_quien, DE_QUIEN) && isStrOrNull(c.plazo) && isStr(c.cita)));
  need(typeof p.conflicto === 'boolean', 'conflicto');
  bad.push(...checkList(p.alertas, `${at}.alertas`, (a) => oneOf(a.tipo, ALERTA_TIPO) && isStr(a.cita) && isStr(a.fuente)));
  return bad;
}

/**
 * `convocadoRefs`: as `ref` da lista de convocados enviada ao modelo. `prestadores` não pode ser vazio (há transcrição).
 * Sem a forma: `schema_invalid` (conta no teto de 3 tentativas, como na admissão).
 */
export function validateEnquadreSummaryShape(
  input: { structured?: unknown | null; jsonInvalid?: boolean },
  convocadoRefs: readonly string[],
): EnquadreShapeVerdict {
  if (input.jsonInvalid || input.structured === undefined || input.structured === null) return { ok: false, reason: 'json_invalid', fields: [] };
  const json = input.structured;
  if (!isObj(json)) return { ok: false, reason: 'schema_invalid', fields: [] };
  const bad: string[] = [];
  if (!(isStr(json.entrevista_id) && ENCUADRE_CODE.test(json.entrevista_id))) bad.push('entrevista_id');
  if (!isStr(json.fecha)) bad.push('fecha');
  if (json.estado !== ENQUADRE_SUMMARY_STATE_DRAFT) bad.push('estado');
  const enc = json.encuentro;
  if (!isObj(enc)) bad.push('encuentro');
  else {
    if (!isStr(enc.resumen)) bad.push('encuentro.resumen');
    const temas = isObj(enc.temas_cubiertos) ? enc.temas_cubiertos : null;
    if (!temas) bad.push('encuentro.temas_cubiertos');
    else bad.push(...TEMAS.filter((t) => typeof temas[t] !== 'boolean').map((t) => `encuentro.temas_cubiertos.${t}`));
    bad.push(...checkList(enc.acuerdos, 'encuentro.acuerdos', (a) => isStr(a.texto) && isStr(a.cita)));
    bad.push(...evidences(enc.evidencias, 'encuentro.evidencias'));
  }
  if (!Array.isArray(json.prestadores) || json.prestadores.length === 0) bad.push('prestadores');
  else {
    const refs = new Set(convocadoRefs);
    json.prestadores.forEach((p, i) => (isObj(p) ? bad.push(...checkPrestador(p, `prestadores[${i}]`, refs)) : bad.push(`prestadores[${i}]`)));
  }
  for (const k of TOP_LISTS) if (!Array.isArray(json[k])) bad.push(k);
  return bad.length ? { ok: false, reason: 'schema_invalid', fields: bad } : { ok: true };
}
