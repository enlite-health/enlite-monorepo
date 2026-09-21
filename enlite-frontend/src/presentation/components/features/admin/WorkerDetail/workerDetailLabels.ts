import { TFunction } from 'i18next';

const GI = 'workerRegistration.generalInfo';

const DOCUMENT_TYPE_KEYS: Record<string, string> = {
  CUIL_CUIT: `${GI}.cuilCuit`,
  CPF: `${GI}.cpf`,
  RG: `${GI}.rg`,
  CNH: `${GI}.cnh`,
};

/**
 * Mapa canônico de sexo/gênero — cobre TODOS os valores que chegam de prod:
 *   EN uppercase canonical (MALE/FEMALE/OTHER) — futuro/backfill
 *   EN lowercase (male/female/other) — legado EN
 *   ES variantes reais em prod (mujer, Mujer, hombre, Hombre, Varón, varón,
 *   Femenino, femenino, Masculino, masculino, Otro, otro)
 *
 * `getSexLabel`/`getGenderLabel` normalizam para minúsculas ANTES do lookup, via
 * `resolveCaseInsensitive()` (defeito 3, 21/09/2026: `WorkerPersonalInfoCard`
 * chama `getSexLabel(t, sex)` com o valor cru do backend, que grava MAIÚSCULO —
 * sem a normalização, "MALE" caía no fallback e aparecia cru na tela). Por isso
 * as entradas do mapa abaixo só precisam ser minúsculas.
 */
const SEX_GENDER_KEYS: Record<string, string> = {
  // EN canonical (backfill/futuro)
  male: `${GI}.male`,
  female: `${GI}.female`,
  other: `${GI}.other`,
  // Aliases ES → mesma key i18n (valores reais mistos em prod)
  mujer: `${GI}.female`,      // "mujer"
  hombre: `${GI}.male`,       // "Hombre" → lowercase
  varón: `${GI}.male`,        // "Varón" → lowercase
  varon: `${GI}.male`,        // sem acento
  femenino: `${GI}.female`,   // "Femenino" → lowercase
  masculino: `${GI}.male`,    // "Masculino" → lowercase
  otro: `${GI}.other`,        // "Otro" → lowercase
};

const LANGUAGE_KEYS: Record<string, string> = {
  pt: `${GI}.portuguese`,
  es: `${GI}.spanish`,
  en: `${GI}.english`,
};

const PROFESSION_KEYS: Record<string, string> = {
  AT: `${GI}.AT`,
  CAREGIVER: `${GI}.CAREGIVER`,
  NURSE: `${GI}.NURSE`,
  KINESIOLOGIST: `${GI}.KINESIOLOGIST`,
  PSYCHOLOGIST: `${GI}.PSYCHOLOGIST`,
};

const KNOWLEDGE_LEVEL_KEYS: Record<string, string> = {
  SECONDARY: `${GI}.SECONDARY`,
  TERTIARY: `${GI}.TERTIARY`,
  TECNICATURA: `${GI}.TECNICATURA`,
  BACHELOR: `${GI}.BACHELOR`,
  POSTGRADUATE: `${GI}.POSTGRADUATE`,
  MASTERS: `${GI}.MASTERS`,
  DOCTORATE: `${GI}.DOCTORATE`,
};

const EXPERIENCE_TYPE_KEYS: Record<string, string> = {
  adicciones: `${GI}.adicciones`,
  psicosis: `${GI}.psicosis`,
  trastorno_alimentar: `${GI}.trastorno_alimentar`,
  trastorno_bipolaridad: `${GI}.trastorno_bipolaridad`,
  trastorno_ansiedad: `${GI}.trastorno_ansiedad`,
  trastorno_discapacidad_intelectual: `${GI}.trastorno_discapacidad_intelectual`,
  trastorno_depresivo: `${GI}.trastorno_depresivo`,
  trastorno_neurologico: `${GI}.trastorno_neurologico`,
  trastorno_opositor_desafiante: `${GI}.trastorno_opositor_desafiante`,
  trastorno_psicologico: `${GI}.trastorno_psicologico`,
  trastorno_psiquiatrico: `${GI}.trastorno_psiquiatrico`,
};

const YEARS_EXPERIENCE_KEYS: Record<string, string> = {
  '0_2': `${GI}.years0to2`,
  '3_5': `${GI}.years3to5`,
  '6_10': `${GI}.years6to10`,
  '10_plus': `${GI}.years10plus`,
};

const AGE_RANGE_KEYS: Record<string, string> = {
  children: `${GI}.ageRangeChildren`,
  adolescents: `${GI}.ageRangeAdolescents`,
  adults: `${GI}.ageRangeAdults`,
  elderly: `${GI}.ageRangeElderly`,
};

function resolve(t: TFunction, map: Record<string, string>, raw: string | null): string | null {
  if (!raw) return null;
  const key = map[raw];
  return key ? t(key) : raw;
}

// Defeito 3 (21/09/2026): só SEX_GENDER_KEYS tem chaves case-insensitive por
// natureza (valores ES/EN mistos vindos de fontes diferentes — ver comentário
// do mapa acima). Os outros mapas (documento, profissão, nível de estudos,
// tipo de experiência) são enums CANÔNICOS maiúsculos por contrato — normalizar
// caixa ali quebraria o lookup exato (ex.: 'MASTERS' via toLowerCase() não bate
// a chave 'MASTERS' do mapa). Por isso a normalização fica só aqui, não em
// `resolve()` — e o fallback devolve o valor ORIGINAL (sem lowercase), não o
// normalizado, para não mascarar um valor realmente desconhecido.
function resolveCaseInsensitive(t: TFunction, map: Record<string, string>, raw: string | null): string | null {
  if (!raw) return null;
  const key = map[raw.toLowerCase()];
  return key ? t(key) : raw;
}

export const getDocumentTypeLabel = (t: TFunction, v: string | null) => resolve(t, DOCUMENT_TYPE_KEYS, v);
export const getSexLabel = (t: TFunction, v: string | null) => resolveCaseInsensitive(t, SEX_GENDER_KEYS, v);
export const getGenderLabel = (t: TFunction, v: string | null) => resolveCaseInsensitive(t, SEX_GENDER_KEYS, v);
export const getLanguageLabel = (t: TFunction, v: string) => resolve(t, LANGUAGE_KEYS, v) ?? v;
export const getProfessionLabel = (t: TFunction, v: string | null) => resolve(t, PROFESSION_KEYS, v);
export const getKnowledgeLevelLabel = (t: TFunction, v: string | null) => resolve(t, KNOWLEDGE_LEVEL_KEYS, v);
export const getExperienceTypeLabel = (t: TFunction, v: string) => resolve(t, EXPERIENCE_TYPE_KEYS, v) ?? v;
export const getYearsExperienceLabel = (t: TFunction, v: string | null) => resolve(t, YEARS_EXPERIENCE_KEYS, v);
export const getAgeRangeLabel = (t: TFunction, v: string) => resolve(t, AGE_RANGE_KEYS, v) ?? v;
