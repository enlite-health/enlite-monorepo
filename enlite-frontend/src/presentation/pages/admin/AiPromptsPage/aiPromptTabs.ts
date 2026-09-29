// Spec 029 (US1) — Prompts de IA editáveis. Molde:
// `$FE/src/presentation/components/features/admin/PatientDetail/patientTabs.ts`.
//
// Cada aba é 1:1 com um dos três identificadores FECHADOS do backend
// (`worker-functions/src/modules/integration/domain/AiPromptSlug.ts`, `AI_PROMPT_SLUGS`) — o
// mesmo `SCREAMING_SNAKE_CASE`, sem tradução nem reformatação, porque é o valor que trafega na
// URL (`GET/PUT /api/admin/ai-prompts/{slug}`) e no `CHECK` da tabela `ai_prompts` (migration
// 485). Tipo novo só nasce quando o backend alargar `AI_PROMPT_SLUGS` — nunca só aqui.
//
// Diferente de `patientTabs.ts` (cujo mapa de chaves i18n mora no componente de tab bar,
// `PatientProfileTabs.tsx`), aqui o mapa entra NESTE arquivo: a página e o editor (T023/T024,
// fora desta task) ainda não existem, e o mapa é o contrato entre a lista de abas e as chaves
// acrescentadas em `es.json`/`pt-BR.json` (T020, `admin.aiPrompts.tabs.*`).
export type AiPromptTab = 'VACANCY_DESCRIPTION' | 'PRESCREENING_AT' | 'PRESCREENING_CAREGIVER';

export const AI_PROMPT_TABS: readonly AiPromptTab[] = [
  'VACANCY_DESCRIPTION',
  'PRESCREENING_AT',
  'PRESCREENING_CAREGIVER',
];

export const AI_PROMPT_TAB_I18N_KEYS: Record<AiPromptTab, string> = {
  VACANCY_DESCRIPTION: 'admin.aiPrompts.tabs.vacancyDescription',
  PRESCREENING_AT: 'admin.aiPrompts.tabs.prescreeningAt',
  PRESCREENING_CAREGIVER: 'admin.aiPrompts.tabs.prescreeningCaregiver',
};
