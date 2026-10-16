/**
 * Forma do JSON do resumo da admissão (spec 050 F6, R-12/R-13/R-14). Puro, sem I/O: UMA função de domínio que a importação
 * (e a trilha, via `reason`) lê. O esquema vive no Doc do prompt (editável); aqui está o que a spec nomeia, como constante.
 * Nenhum valor do resumo sai daqui: só NOMES de campo (nunca conteúdo) voltam em `fields`.
 */
export const SUMMARY_STATE_DRAFT = 'BORRADOR_PARA_REVISION_CTM';
export const SUMMARY_DRAFT_BANNER = 'BORRADOR';

/** Chaves de topo do JSON, como o prompt as define (seção 6, FORMATO DE SALIDA). */
export const SUMMARY_TOP_KEYS = [
  'entrevistas_procesadas', 'datos_administrativos', 'analisis_caso', 'cie11_diagnosticos_informados',
  'sintomas_sin_diagnostico_informado', 'insumos_pt', 'perfil_prestador', 'dotacion', 'campos_faltantes',
  'preguntas_sugeridas', 'alertas_riesgo', 'estado',
] as const;

export const SUMMARY_LIST_KEYS = ['campos_faltantes', 'preguntas_sugeridas'] as const;

/**
 * Campos de `datos_administrativos` OBRIGATÓRIOS (os que o prompt não marca como condicionais). Se `valor` é `null`, a chave
 * tem de constar em `campos_faltantes`. Acoplamento: a lista espelha o Doc do prompt; mudou o Doc, muda aqui.
 */
export const SUMMARY_REQUIRED_FIELDS = [
  'resp_nombre_completo', 'resp_relacion', 'resp_whatsapp', 'pac_nombre_completo', 'pac_fecha_nacimiento',
  'direccion_prestacion', 'dias_horarios_requeridos',
] as const;

export type SummaryShapeVerdict =
  | { ok: true }
  | { ok: false; reason: 'json_invalid' | 'schema_invalid'; fields: string[] };

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

const isNullValue = (entry: unknown): boolean => entry === null || (isObject(entry) && (entry.valor === null || entry.valor === undefined));

const norm = (s: string): string => s.trim().toLowerCase();

/** Um item de `campos_faltantes` cobre a chave `k`: string igual, string cujo último segmento após `.` é `k`, ou objeto com algum valor assim. */
export function coversField(item: unknown, k: string): boolean {
  const key = norm(k);
  const matchesString = (v: string): boolean => norm(v) === key || norm(v.split('.').pop() ?? '') === key;
  if (typeof item === 'string') return matchesString(item);
  if (isObject(item)) return Object.values(item).some((v) => typeof v === 'string' && matchesString(v));
  return false;
}

export function validateSummaryShape(input: { structured?: unknown | null; jsonInvalid?: boolean }): SummaryShapeVerdict {
  if (input.jsonInvalid || input.structured === undefined || input.structured === null) return { ok: false, reason: 'json_invalid', fields: [] };
  const json = input.structured;
  if (!isObject(json)) return { ok: false, reason: 'schema_invalid', fields: [] };
  const missing = SUMMARY_TOP_KEYS.filter((k) => !(k in json));
  const notList = SUMMARY_LIST_KEYS.filter((k) => k in json && !Array.isArray(json[k]));
  if (missing.length || notList.length || json.estado !== SUMMARY_STATE_DRAFT || !isObject(json.datos_administrativos)) {
    const bad = [...missing, ...notList, ...(json.estado !== SUMMARY_STATE_DRAFT ? ['estado'] : [])];
    return { ok: false, reason: 'schema_invalid', fields: bad };
  }
  const faltantes = json.campos_faltantes as unknown[];
  const admin = json.datos_administrativos;
  const unlisted = SUMMARY_REQUIRED_FIELDS.filter((k) => k in admin && isNullValue(admin[k]) && !faltantes.some((item) => coversField(item, k)));
  if (unlisted.length) return { ok: false, reason: 'schema_invalid', fields: unlisted };
  return { ok: true };
}
