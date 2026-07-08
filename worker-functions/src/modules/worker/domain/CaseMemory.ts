/**
 * Dossiê do lead (Camada A) — forma canônica + regras server-side. O servidor é
 * a FONTE DE VERDADE da forma: aplica FIFO/caps/validação de stage ao gravar, pra
 * a IA não conseguir corromper o dossiê. Ver triage-service/docs/FEATURE_LUZ_CASE_MEMORY.md.
 */

export const CASE_MEMORY_STAGES = [
  'new',
  'registered',
  'docs_pending',
  'interview',
  'complete',
  'lost',
] as const;

export type CaseMemoryStage = (typeof CASE_MEMORY_STAGES)[number];

/** `tried` guarda no máximo os N últimos intentos (FIFO). */
export const CASE_MEMORY_TRIED_MAX = 5;
/** Cap de tamanho por campo de texto (o dossiê é resumo, não log). */
export const CASE_MEMORY_TEXT_CAP = 280;
/** Máximo de itens em `missing`. */
export const CASE_MEMORY_MISSING_MAX = 10;

export interface CaseMemory {
  stage?: CaseMemoryStage;
  missing?: string[];
  tried?: string[];
  blocker?: string;
  lastPromise?: string;
}

/** Patch parcial vindo da tool update_case_memory (via MCP). */
export interface CaseMemoryPatch {
  stage?: string;
  missing?: string[];
  blocker?: string;
  lastPromise?: string;
  note?: string;
}

function isStage(value: unknown): value is CaseMemoryStage {
  return (
    typeof value === 'string' &&
    (CASE_MEMORY_STAGES as readonly string[]).includes(value)
  );
}

function cap(value: string): string {
  return value.slice(0, CASE_MEMORY_TEXT_CAP);
}

function cleanText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? cap(value.trim())
    : undefined;
}

/**
 * Normaliza o que veio do JSONB pra forma canônica (descarta lixo / campos
 * desconhecidos / stage inválido). Usado na leitura.
 */
export function normalizeCaseMemory(raw: unknown): CaseMemory {
  if (!raw || typeof raw !== 'object') return {};
  const d = raw as Record<string, unknown>;
  const strArr = (v: unknown): string[] | undefined =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === 'string')
      : undefined;
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length > 0 ? v : undefined;
  return {
    stage: isStage(d.stage) ? d.stage : undefined,
    missing: strArr(d.missing),
    tried: strArr(d.tried),
    blocker: str(d.blocker),
    lastPromise: str(d.lastPromise),
  };
}

/**
 * MERGE parcial: só os campos presentes no patch são tocados. `note` é
 * ACRESCENTADO a `tried` (FIFO máx N) — a IA nunca reescreve a lista inteira.
 * Aplica caps de tamanho e ignora stage inválido. Usado na escrita.
 */
export function applyCaseMemoryPatch(
  current: CaseMemory,
  patch: CaseMemoryPatch,
): CaseMemory {
  const next: CaseMemory = { ...current };

  if (isStage(patch.stage)) next.stage = patch.stage;

  if (Array.isArray(patch.missing)) {
    next.missing = patch.missing
      .map((x) => cleanText(x))
      .filter((x): x is string => x !== undefined)
      .slice(0, CASE_MEMORY_MISSING_MAX);
  }

  const blocker = cleanText(patch.blocker);
  if (blocker) next.blocker = blocker;

  const lastPromise = cleanText(patch.lastPromise);
  if (lastPromise) next.lastPromise = lastPromise;

  const note = cleanText(patch.note);
  if (note) {
    next.tried = [...(current.tried ?? []), note].slice(-CASE_MEMORY_TRIED_MAX);
  }

  return next;
}
