/**
 * As 12 famílias de rotas governadas pelo painel de grupos — FONTE ÚNICA dos nomes.
 *
 * Por que aqui e não em cada arquivo de rota: o módulo `identity/permissions` não importa de
 * nenhum outro módulo de domínio (D115 §7, `moduleBoundary.test.ts`). A dependência é invertida —
 * cada router importa a SUA constante daqui, e o e2e `permission-enforcement-all-families` afirma
 * que esta lista é igual à varredura viva do app: família nova sem entrar aqui fica vermelha.
 */
export const ADMIN_ANALYTICS_FAMILY = 'admin.analytics' as const;
export const ADMIN_DEDUP_FAMILY = 'admin.dedup' as const;
export const ADMIN_ENCUADRE_FAMILY = 'admin.encuadre' as const;
export const ADMIN_INTEGRATIONS_FAMILY = 'admin.integrations' as const;
export const ADMIN_MESSAGING_FAMILY = 'admin.messaging' as const;
export const ADMIN_PATIENTS_FAMILY = 'admin.patients' as const;
export const ADMIN_PERMISSIONS_FAMILY = 'admin.permissions' as const;
export const ADMIN_RECRUITMENT_FAMILY = 'admin.recruitment' as const;
export const ADMIN_TEST_FIXTURES_FAMILY = 'admin.test_fixtures' as const;
export const ADMIN_USERS_FAMILY = 'admin.users' as const;
export const ADMIN_VACANCIES_FAMILY = 'admin.vacancies' as const;
export const ADMIN_WORKERS_FAMILY = 'admin.workers' as const;

export const ALL_PERMISSION_FAMILIES = [
  ADMIN_ANALYTICS_FAMILY,
  ADMIN_DEDUP_FAMILY,
  ADMIN_ENCUADRE_FAMILY,
  ADMIN_INTEGRATIONS_FAMILY,
  ADMIN_MESSAGING_FAMILY,
  ADMIN_PATIENTS_FAMILY,
  ADMIN_PERMISSIONS_FAMILY,
  ADMIN_RECRUITMENT_FAMILY,
  ADMIN_TEST_FIXTURES_FAMILY,
  ADMIN_USERS_FAMILY,
  ADMIN_VACANCIES_FAMILY,
  ADMIN_WORKERS_FAMILY,
] as const;

export type PermissionFamily = (typeof ALL_PERMISSION_FAMILIES)[number];
