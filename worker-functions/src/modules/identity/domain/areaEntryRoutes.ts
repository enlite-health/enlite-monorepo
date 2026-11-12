/**
 * Para onde cada par (área, papel) leva o login (design §3, DF-5).
 *
 * Mapa estático em código [ESCOLHA MINHA, design §3]. `null` = a área existe mas ainda não tem tela:
 * aparece em `GET /v1/me/areas` e não é navegável. `learn`·* troca o `null` na spec B.
 */
export const AREA_ORDER = ['backoffice', 'care', 'clinic', 'learn'] as const;
export type AreaName = (typeof AREA_ORDER)[number];

const ENTRY_ROUTES: Readonly<Record<string, string | null>> = {
  'backoffice:staff': '/admin',
  'care:worker': '/',
  'care:family': null,
  'learn:learner': null,
  'learn:teacher': null,
  'learn:manager': null,
};

export function entryRouteFor(area: string, role: string): string | null {
  return ENTRY_ROUTES[`${area}:${role}`] ?? null;
}
