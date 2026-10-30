/**
 * LinkExistingVacancyPlan — regra campo a campo, PURA, do vínculo vaga existente → serviço contratado
 * (spec 079, plan §3.3). Sem I/O, sem Zod, sem `interfaces/`: o domínio de escrita do serviço entra
 * por `accepts` (injetado). Direção única: nada do serviço vai para a vaga; a vaga só é ZERADA
 * nas colunas que o CHECK da migration 525 exige NULL quando há serviço.
 */
import type { ProviderAgeBand } from './enums/ContractedService';
import type { LinkField, LinkOrigin, LinkPreviewRow, LinkWarning } from './LinkExistingVacancyContract';
import type { ServiceRecruitmentFields } from './PatientCompleteness';
import { providerAgeBandForVacancyRange, vacancyRangeForProviderAgeBand } from './ProviderAgeBandMapping';

/** As 9 colunas do CHECK `job_postings_service_owns_fields_chk` (migration 525:30-36). O repositório zera TODAS no UPDATE do vínculo. */
export const VACANCY_SERVICE_OWNED_COLUMNS = [
  'schedule',
  'providers_needed',
  'age_range_min',
  'age_range_max',
  'required_sex',
  'required_professions',
  'required_experience',
  'work_schedule',
  'payment_day',
] as const;
export type VacancyServiceOwnedColumn = (typeof VACANCY_SERVICE_OWNED_COLUMNS)[number];

export type FeedableRecruitmentField =
  | 'required_professions'
  | 'required_experience'
  | 'work_schedule'
  | 'payment_day'
  | 'required_sex';

/** Injetado: o domínio de escrita do serviço (Zod) vive fora do domínio. */
export type AcceptsServiceValue = (field: FeedableRecruitmentField, value: unknown) => boolean;

export interface VacancyLinkSource {
  required_professions: string[] | null;
  required_experience: string | null;
  work_schedule: string | null;
  payment_day: string | null;
  required_sex: string | null;
  providers_needed: string | null;
  age_range_min: number | null;
  age_range_max: number | null;
  schedule: unknown | null;
  patient_address_id: string | null;
}

export interface ServiceLinkTarget {
  required_professions: string[] | null;
  required_experience: string | null;
  work_schedule: string | null;
  payment_day: string | null;
  required_sex: string | null;
  providers_needed: number | null;
  provider_age_band: ProviderAgeBand | null;
  address_id: string | null;
  hasSchedule: boolean;
}

/** Só o que vai DA VAGA PARA O SERVIÇO. */
export interface ServiceFeed {
  required_professions?: string[];
  required_experience?: string;
  work_schedule?: string;
  payment_day?: string;
  required_sex?: string;
  providers_needed?: number;
  provider_age_band?: ProviderAgeBand;
  address_id?: string;
}

export interface LinkExistingVacancyPlanResult {
  serviceFeed: ServiceFeed;
  /** Só colunas da vaga NÃO vazias (para a auditoria antes→null). */
  vacancyClear: Array<{ column: VacancyServiceOwnedColumn; before: unknown }>;
  /** Só as linhas em que o valor que a vaga exibe MUDA (vacancyValue ≠ effectiveValue, profundo). */
  rows: LinkPreviewRow[];
  warnings: LinkWarning[];
  addressBlocked: boolean;
  /** Serviço já alimentado, em memória, para o portão. */
  effective: { hasAddress: boolean; recruitmentFields: ServiceRecruitmentFields };
}

const PG_INT_MAX = 2147483647;

const isBlankString = (v: string | null | undefined): boolean => v == null || v.trim() === '';
const isEmptyList = (v: string[] | null | undefined): boolean => v == null || v.length === 0;

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

export function linkExistingVacancyPlan(
  vacancy: VacancyLinkSource,
  service: ServiceLinkTarget,
  accepts: AcceptsServiceValue,
): LinkExistingVacancyPlanResult {
  const serviceFeed: ServiceFeed = {};
  const vacancyClear: LinkExistingVacancyPlanResult['vacancyClear'] = [];
  const rows: LinkPreviewRow[] = [];
  const warnings: LinkWarning[] = [];
  let addressBlocked = false;

  // Prévia = só o que MUDA no que a vaga exibe. Campo alimentado pela vaga (origem VACANCY) entrega o MESMO
  // dado ao serviço: não gera linha (decisão do Gabriel, 30/10).
  const addRow = (field: LinkField, vacancyValue: unknown, effectiveValue: unknown, origin: LinkOrigin | 'VACANCY'): void => {
    if (origin === 'VACANCY') return;
    if (!deepEqual(vacancyValue, effectiveValue)) rows.push({ field, vacancyValue, effectiveValue, origin });
  };
  const clearIf = (column: VacancyServiceOwnedColumn, before: unknown, empty: boolean): void => {
    if (!empty) vacancyClear.push({ column, before });
  };

  // ── 4 campos de texto ──────────────────────────────────────────────
  const stringFields = ['required_experience', 'work_schedule', 'payment_day', 'required_sex'] as const;
  const effectiveText: Record<(typeof stringFields)[number], string | null> = {
    required_experience: service.required_experience,
    work_schedule: service.work_schedule,
    payment_day: service.payment_day,
    required_sex: service.required_sex,
  };
  for (const f of stringFields) {
    const vVal = vacancy[f];
    const vEmpty = isBlankString(vVal);
    clearIf(f, vVal, vEmpty);
    let origin: LinkOrigin | 'VACANCY' = 'NONE';
    let effective: string | null = null;
    if (!isBlankString(service[f])) {
      origin = 'SERVICE';
      effective = service[f];
    } else if (!vEmpty) {
      if (accepts(f, vVal)) {
        serviceFeed[f] = vVal as string;
        origin = 'VACANCY';
        effective = vVal;
      } else {
        warnings.push({ field: f, code: 'VALUE_OUTSIDE_SERVICE_DOMAIN' });
      }
    }
    effectiveText[f] = origin === 'NONE' ? service[f] : effective;
    addRow(f, vEmpty ? null : vVal, origin === 'NONE' ? null : effective, origin);
  }

  // ── required_professions (lista) ───────────────────────────────────
  {
    const vVal = vacancy.required_professions;
    const vEmpty = isEmptyList(vVal);
    clearIf('required_professions', vVal, vEmpty);
    let origin: LinkOrigin | 'VACANCY' = 'NONE';
    let effective: string[] | null = null;
    if (!isEmptyList(service.required_professions)) {
      origin = 'SERVICE';
      effective = service.required_professions;
    } else if (!vEmpty) {
      if (accepts('required_professions', vVal)) {
        serviceFeed.required_professions = vVal as string[];
        origin = 'VACANCY';
        effective = vVal;
      } else {
        warnings.push({ field: 'required_professions', code: 'VALUE_OUTSIDE_SERVICE_DOMAIN' });
      }
    }
    addRow('required_professions', vEmpty ? null : vVal, effective, origin);
  }

  // ── providers_needed (TEXT na vaga, INT no serviço) ────────────────
  {
    const vVal = vacancy.providers_needed;
    const vEmpty = isBlankString(vVal);
    clearIf('providers_needed', vVal, vEmpty);
    let origin: LinkOrigin | 'VACANCY' = 'NONE';
    let effective: number | null = null;
    if (service.providers_needed != null) {
      origin = 'SERVICE';
      effective = service.providers_needed;
    } else if (!vEmpty) {
      const text = vVal as string;
      const n = /^\s*\d+\s*$/.test(text) ? Number(text.trim()) : NaN;
      if (Number.isSafeInteger(n) && n > 0 && n <= PG_INT_MAX) {
        serviceFeed.providers_needed = n;
        origin = 'VACANCY';
        effective = n;
      } else {
        warnings.push({ field: 'providers_needed', code: 'PROVIDERS_NEEDED_NOT_INTEGER' });
      }
    }
    addRow('providers_needed', vEmpty ? null : vVal, effective, origin);
  }

  // ── age_range (par min/max ↔ provider_age_band) ────────────────────
  {
    const min = vacancy.age_range_min ?? null;
    const max = vacancy.age_range_max ?? null;
    clearIf('age_range_min', vacancy.age_range_min, min === null);
    clearIf('age_range_max', vacancy.age_range_max, max === null);
    let band: ProviderAgeBand | null = service.provider_age_band;
    let origin: LinkOrigin | 'VACANCY' = 'NONE';
    if (service.provider_age_band != null) {
      origin = 'SERVICE';
    } else if (min !== null || max !== null) {
      const found = providerAgeBandForVacancyRange(min, max);
      if (found) {
        serviceFeed.provider_age_band = found;
        band = found;
        origin = 'VACANCY';
      } else {
        warnings.push({ field: 'age_range', code: 'AGE_RANGE_NO_EXACT_BAND' });
      }
    }
    addRow('age_range', { min, max }, vacancyRangeForProviderAgeBand(band), origin);
  }

  // ── schedule: NUNCA alimenta; sempre esvazia ───────────────────────
  if (vacancy.schedule != null) {
    clearIf('schedule', vacancy.schedule, false);
    rows.push({
      field: 'schedule',
      vacancyValue: vacancy.schedule,
      effectiveValue: null,
      origin: service.hasSchedule ? 'SERVICE' : 'NONE',
    });
  }

  // ── endereço (a vaga mantém o dela; fora do CHECK) ─────────────────
  {
    const v = vacancy.patient_address_id;
    const s = service.address_id;
    if (v != null && s != null) {
      if (v !== s) addressBlocked = true;
    } else if (v != null && s == null) {
      serviceFeed.address_id = v; // mesmo dado → sem linha
    }
    // v == null && s != null: a vaga mantém patient_address_id próprio (null) → nada muda na vaga → sem linha
  }

  return {
    serviceFeed,
    vacancyClear,
    rows,
    warnings,
    addressBlocked,
    effective: {
      hasAddress: (service.address_id ?? serviceFeed.address_id) != null,
      recruitmentFields: {
        requiredProfessions: serviceFeed.required_professions ?? service.required_professions,
        requiredSex: effectiveText.required_sex,
        requiredExperience: effectiveText.required_experience,
        workSchedule: effectiveText.work_schedule,
        paymentDay: effectiveText.payment_day,
      },
    },
  };
}
