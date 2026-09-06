/**
 * ProviderAgeBandMapping — fonte ÚNICA do mapa franja→vaga (spec 015, US-A6.2; D254 item 6;
 * D191/D256). `ActivatePatientUseCase` importa `vacancyRangeForProviderAgeBand` em vez de
 * reimplementar o mapa — regressão aqui não pode divergir do que a spec pede em silêncio (mesmo
 * molde de `computePatientCompleteness`/`PatientCompleteness.ts`, D1.1 do lex do bloco D).
 *
 * ── O mapa (spec 015, corpo do pedido) ────────────────────────────────────────
 *   ANY        → { min: null, max: null }  ("edad indistinta" — não filtra, explícito)
 *   AGE_20_30  → { min: 20,   max: 29   }
 *   AGE_30_45  → { min: 30,   max: 44   }
 *   AGE_45_PLUS→ { min: 45,   max: null }
 *
 * `contracts/clickup-fields.md` (linha 85, medido) marcava "30 está nas duas faixas — fronteira
 * ambígua". Esta spec resolve a ambiguidade: os intervalos de VAGA não se sobrepõem (20-29 /
 * 30-44 / 45+) — um prestador de 30 anos cai só em AGE_30_45.
 *
 * ── `null` (não informado) NUNCA toca a vaga ──────────────────────────────────
 * `vacancyRangeForProviderAgeBand(null)` devolve `{min:null,max:null}` — MESMO shape numérico de
 * `ANY`, mas os dois nascem de decisões diferentes (o operador não abriu a franja vs. abriu e
 * escolheu "indistinta"). `ActivatePatientUseCase` não distingue os dois porque o resultado na
 * vaga é idêntico (nenhum filtro de idade); quem precisar da distinção lê
 * `patient_contracted_services.provider_age_band` diretamente (NULL vs 'ANY').
 *
 * ── Só a vaga NASCIDA DO SERVIÇO herda ────────────────────────────────────────
 * O fallback de `ActivatePatientUseCase` (paciente sem serviço contratado ativo, uma vaga por
 * endereço) não chama esta função — continua com `age_range_min/max: null`, igual a antes desta
 * spec (FR-3, "fallback intocado").
 */
import type { ProviderAgeBand } from './enums/ContractedService';

export interface VacancyAgeRange {
  min: number | null;
  max: number | null;
}

/** O mapa em si — exportado para quem precisar inspecionar todos os pares de uma vez (testes, painel de auditoria). */
export const PROVIDER_AGE_BAND_TO_VACANCY_RANGE: Record<ProviderAgeBand, VacancyAgeRange> = {
  ANY: { min: null, max: null },
  AGE_20_30: { min: 20, max: 29 },
  AGE_30_45: { min: 30, max: 44 },
  AGE_45_PLUS: { min: 45, max: null },
};

/**
 * `band` null/undefined ("não informado", coluna nova em serviço pré-existente ou operador que
 * não escolheu franja) → `{min:null,max:null}`, não toca a vaga. Enum reconhecido → o par do
 * mapa acima.
 */
export function vacancyRangeForProviderAgeBand(
  band: ProviderAgeBand | null | undefined,
): VacancyAgeRange {
  if (band == null) return { min: null, max: null };
  return PROVIDER_AGE_BAND_TO_VACANCY_RANGE[band];
}

/**
 * Grafia VIVA do ClickUp (`contracts/clickup-fields.md`, linha 82, medida 03/09) → enum
 * canônico. FR-4: exportada para o espelho usar QUANDO a admissão do ClickUp for lida — hoje não
 * há caminho de escrita do espelho para `patient_contracted_services` (a entidade nasceu vazia,
 * spec 013), então este mapa fica pronto e sem chamador ainda (LISTA do relatório).
 */
export const CLICKUP_AGE_LABEL_TO_PROVIDER_AGE_BAND: Record<string, ProviderAgeBand> = {
  'Edad Indistinta': 'ANY',
  '20 a 30 Años': 'AGE_20_30',
  '30 a 45 Años': 'AGE_30_45',
  '+ 45 Años': 'AGE_45_PLUS',
};
