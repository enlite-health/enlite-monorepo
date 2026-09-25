/**
 * vacancyLockedFields — fase 4 (`completar-vacante-em-rascunho`).
 *
 * Duas responsabilidades puras, sem React:
 *   1. `LOCKED_COLUMN_TO_FORM_FIELD` — o mapa `nome-do-campo-do-form → coluna` de
 *      `buildVacancyPayload` (`vacancy-form-schema.ts:208-237`), invertido: coluna do backend →
 *      campo do form que a edita. Reusa `KNOWN_LOCKED_FIELDS` (o espelho de `SOURCE_LOCKED_FIELDS`
 *      já mantido pela Fase 2 em `VacancyDetail/draftVacancyFields.ts`) em vez de duplicar a lista
 *      de 8 nomes. Nenhuma lista nova digitada — só a correspondência coluna→campo, que a Fase 2
 *      não precisava fazer (ela só contava, não desabilitava inputs).
 *   2. `stripLockedFields` — remove do body do PUT qualquer chave presente em `locked_fields`,
 *      não importa o que o form (ou uma sabotagem) tenha colocado lá. A API já recusa (422,
 *      fase 1) qualquer uma dessas chaves mesmo com valor igual (`f in updates`,
 *      `vacancyCrudHelpers.ts:188`) — esta função existe para o front parar de tropeçar nisso,
 *      não para substituir a recusa do backend.
 */

import { KNOWN_LOCKED_FIELDS } from './VacancyDetail/draftVacancyFields';
import type { VacancyFormData } from './vacancy-form-schema';

export type SourceLockedField = (typeof KNOWN_LOCKED_FIELDS)[number];

/**
 * Coluna travada → campo do form que a edita, ou `null` quando a coluna não tem campo de FORM
 * (RHF) correspondente:
 *   - `case_number`, `patient_id` — já são texto estático em modo edição (`VacancyFormLeftColumn`
 *     #1 e #2: `case-number-display` e o nome do paciente), nunca um input editável.
 *   - `contracted_service_id` — não é lido nem exibido em lugar nenhum do passo 1 hoje.
 */
export const LOCKED_COLUMN_TO_FORM_FIELD: Record<SourceLockedField, keyof VacancyFormData | null> = {
  case_number: null,
  patient_id: null,
  patient_address_id: 'patientAddressId',
  contracted_service_id: null,
  age_range_min: 'age_range_min',
  age_range_max: 'age_range_max',
  schedule: 'schedule',
  providers_needed: 'providers_needed',
};

/** As colunas travadas sem campo de form — só para o teste de paridade nomear o que fica de
 *  fora (fase-4.md: "declarada 'sem campo no form', ex. `contracted_service_id`"). */
export const LOCKED_COLUMNS_WITHOUT_FORM_FIELD: readonly SourceLockedField[] = (
  Object.keys(LOCKED_COLUMN_TO_FORM_FIELD) as SourceLockedField[]
).filter((column) => LOCKED_COLUMN_TO_FORM_FIELD[column] === null);

/**
 * Deriva o conjunto de campos do FORM que devem nascer `disabled`, a partir de `locked_fields`
 * do GET (nunca uma lista digitada na tela). Nomes que `LOCKED_COLUMN_TO_FORM_FIELD` não
 * reconhece são ignorados aqui — `assertKnownLockedFields` (fase 2) já é quem lança nomeando o
 * campo desconhecido; esta função não duplica aquela checagem.
 */
export function lockedFormFields(
  lockedFields: readonly string[] | null | undefined,
): Set<keyof VacancyFormData> {
  const out = new Set<keyof VacancyFormData>();
  for (const column of lockedFields ?? []) {
    const field = LOCKED_COLUMN_TO_FORM_FIELD[column as SourceLockedField];
    if (field) out.add(field);
  }
  return out;
}

/**
 * Remove de `body` toda chave presente em `lockedFields`. Pura — não muta `body`. `[]`/ausente
 * devolve `body` como veio (vaga sem origem, ex. criada direto por `POST /vacancies`).
 */
export function stripLockedFields<T extends Record<string, unknown>>(
  body: T,
  lockedFields: readonly string[] | null | undefined,
): T {
  if (!lockedFields || lockedFields.length === 0) return body;
  const result: Record<string, unknown> = { ...body };
  for (const field of lockedFields) {
    if (field in result) delete result[field];
  }
  return result as T;
}
