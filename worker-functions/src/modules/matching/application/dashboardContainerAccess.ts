/**
 * dashboardContainerAccess — a Gestión a la Vista por BLOCO (D286, pedido do Gabriel de 06/09: "Nela
 * temos vários outros como Números clave, Equipo armado y horas, Prioridades de contacto e outros
 * e não estão como opção para colocar a permissão").
 *
 * A tela é UMA chamada (`GET /analytics/dashboard/management`) que devolve um objeto com vários
 * sub-objetos, e cada seção da tela lê um subconjunto deles — alguns compartilhados (Números clave
 * lê `horas` e `equipoArmada`; Equipo armado também). A regra da D286 vale igual: célula por DADO,
 * a rota PROJETA. Aqui a projeção é por SEÇÃO: um sub-objeto fica na resposta se QUALQUER seção
 * permitida precisar dele; senão vira `null`, com marcador constante `redacted.<seção>`.
 *
 * Nada aqui é dado pessoal — são contagens e percentuais. A célula existe para o painel dizer o
 * que cada grupo enxerga da gestão, não por privacidade. A rota continua exigindo `dashboard:read`
 * (abrir a tela); cada bloco exige a sua. `zones` é rota própria (`zone-analytics`) e por isso a
 * célula dela é a da rota, não desta projeção.
 *
 * `cells = null` = engine não decidiu → tudo, como antes (D113).
 */

import { cellKey } from '@modules/identity/permissions';

export const DASHBOARD_SECTIONS = ['numbers', 'team', 'priorities', 'registrations', 'funnel'] as const;
export type DashboardSection = (typeof DASHBOARD_SECTIONS)[number];

export const DASHBOARD_SECTION_RESOURCE: Readonly<Record<DashboardSection, string>> = {
  numbers: 'dashboard_numbers',
  team: 'dashboard_team',
  priorities: 'dashboard_priorities',
  registrations: 'dashboard_registrations',
  funnel: 'dashboard_funnel',
};

/** Rota própria; entra no catálogo pela rota, e no painel como bloco da mesma tela. */
export const DASHBOARD_ZONES_RESOURCE = 'dashboard_zones';

/** Sub-objetos do payload de `management` que cada seção da tela lê (espelho de ManagementDashboardPage). */
export const DASHBOARD_SECTION_KEYS: Readonly<Record<DashboardSection, readonly string[]>> = {
  // BigNumbersSection: bigNumbers, pacientes, horas, equipoArmada.pctRespostaRapidaArmado, encuadres.pctCapacidadeSemana
  numbers: ['bigNumbers', 'pacientes', 'horas', 'equipoArmada', 'encuadres'],
  team: ['equipoArmada', 'horas'],
  priorities: ['prioridades'],
  registrations: ['cadastros'],
  funnel: ['funnelPorPrestador', 'encuadres', 'funnel'],
};

export const dashboardSectionCell = (s: DashboardSection): string => cellKey(DASHBOARD_SECTION_RESOURCE[s], 'read');

export function canReadDashboardSection(cells: readonly string[] | null | undefined, s: DashboardSection): boolean {
  if (cells === null || cells === undefined) return true;
  return cells.includes(dashboardSectionCell(s));
}

export type DashboardReads = Readonly<Record<DashboardSection, boolean>>;

export function dashboardReadsOf(cells: readonly string[] | null | undefined): DashboardReads {
  const out = {} as Record<DashboardSection, boolean>;
  for (const s of DASHBOARD_SECTIONS) out[s] = canReadDashboardSection(cells, s);
  return out;
}

/**
 * O payload projetado. O MESMO objeto quando o ator lê tudo (D113); senão, sub-objeto que nenhuma
 * seção permitida usa vira `null`, e `redacted` lista as seções ocultas — constante, com ou sem dado.
 */
export function projectManagementDashboard<T extends Record<string, unknown>>(
  data: T,
  cells: readonly string[] | null | undefined,
): T & { redacted?: Partial<Record<DashboardSection, true>> } {
  const reads = dashboardReadsOf(cells);
  const hidden = DASHBOARD_SECTIONS.filter((s) => !reads[s]);
  if (hidden.length === 0) return data;
  const needed = new Set<string>();
  for (const s of DASHBOARD_SECTIONS) if (reads[s]) for (const k of DASHBOARD_SECTION_KEYS[s]) needed.add(k);
  const out: Record<string, unknown> = { ...data };
  for (const s of hidden) for (const k of DASHBOARD_SECTION_KEYS[s]) if (!needed.has(k) && k in out) out[k] = null;
  const redacted: Partial<Record<DashboardSection, true>> = {};
  for (const s of hidden) redacted[s] = true;
  out.redacted = redacted;
  return out as T & { redacted: Partial<Record<DashboardSection, true>> };
}
