/**
 * vacancyLifecycle — o DONO do ciclo de vida da vaga (estado-automatico-do-paciente, F2, D3/E5).
 *
 * A vaga não tem "estado do paciente": ela mostra `patients.status` por join na hora. O que ela TEM é um
 * ciclo de vida de 5 valores — `rascunho`, `aberta`, `pausada`, `cerrada`, `baja` — calculado aqui, por UMA
 * tabela, e nunca por lista solta em outro arquivo. A versão SQL (`cicloDeVidaSql`) é GERADA da mesma tabela.
 *
 * Valor novo no CHECK de `job_postings.status` sem linha na tabela = erro de compilação (Record exaustivo) e
 * teste vermelho (`vacancyLifecycle.test.ts` lê o CHECK da migration 483). Zero `if` neste arquivo.
 */

/** = CHECK `job_postings_status_check` da migration 483. O teste lê o arquivo da migration e compara. */
export const VACANCY_STATUS_VALUES = [
  'SEARCHING', 'SEARCHING_REPLACEMENT', 'RAPID_RESPONSE', 'PENDING_ACTIVATION', 'ACTIVE',
  'ON_HOLD', 'SUSPENDED', 'CLOSED', 'DE_BAJA',
] as const;
export type VacancyStatusValue = (typeof VACANCY_STATUS_VALUES)[number];

export const CICLOS_DE_VIDA = ['rascunho', 'aberta', 'pausada', 'cerrada', 'baja'] as const;
export type CicloDeVida = (typeof CICLOS_DE_VIDA)[number];

/** Ciclo de cada valor do CHECK. O valor legado (`SEARCHING_REPLACEMENT`, `RAPID_RESPONSE`, `ACTIVE`, `PENDING_ACTIVATION`) é lido como `aberta`. */
export const CICLO_POR_STATUS: Readonly<Record<VacancyStatusValue, Exclude<CicloDeVida, 'rascunho'>>> = {
  SEARCHING: 'aberta',
  SEARCHING_REPLACEMENT: 'aberta',
  RAPID_RESPONSE: 'aberta',
  ACTIVE: 'aberta',
  PENDING_ACTIVATION: 'aberta',
  ON_HOLD: 'pausada',
  SUSPENDED: 'pausada',
  CLOSED: 'cerrada',
  DE_BAJA: 'baja',
};

/** `is_draft` manda; senão a tabela. Ternário único, sem `if`. */
export const cicloDeVidaDaVaga = (v: { status: VacancyStatusValue; isDraft: boolean }): CicloDeVida =>
  (v.isDraft ? 'rascunho' : CICLO_POR_STATUS[v.status]);

/**
 * O que o CLIENTE (editor da vaga, wizard) pode gravar em `job_postings.status` (E5): só o ciclo de vida.
 * Escritores de sistema (default de criação `PENDING_ACTIVATION`, baja por serviço, corte legado) não passam por aqui.
 */
export const STATUS_GRAVAVEIS = ['SEARCHING', 'ON_HOLD', 'SUSPENDED', 'CLOSED'] as const;
export type StatusGravavel = (typeof STATUS_GRAVAVEIS)[number];

export const isStatusGravavel = (s: unknown): s is StatusGravavel =>
  (STATUS_GRAVAVEIS as readonly unknown[]).includes(s);

/** E8 — "Reanudar": o valor de ESCRITA do ciclo de vida do status de antes da pausa (legado vira `SEARCHING`). */
export const STATUS_DE_RETOMADA_POR_CICLO: Readonly<Record<CicloDeVida, StatusGravavel>> = {
  rascunho: 'SEARCHING',
  aberta: 'SEARCHING',
  pausada: 'SEARCHING',
  cerrada: 'CLOSED',
  baja: 'SEARCHING',
};

/** Sem registro de pausa (ou valor fora da tabela) → `aberta` → `SEARCHING`. `??` não é `if`. */
export const statusDeRetomada = (statusBeforeHold: string | null | undefined): StatusGravavel =>
  STATUS_DE_RETOMADA_POR_CICLO[CICLO_POR_STATUS[statusBeforeHold as VacancyStatusValue] ?? 'aberta'];

/**
 * Versão SQL do mesmo ciclo, GERADA da tabela (molde `patientIncompleteAdmissionSql`). `alias` = alias de `job_postings`.
 * Rascunho primeiro; um `WHEN … IN (…)` por ciclo; valor fora da tabela fica NULL (nunca "desconhecido" silencioso).
 */
export function cicloDeVidaSql(alias = 'jp'): string {
  const porCiclo = CICLOS_DE_VIDA.filter((c) => c !== 'rascunho').map((ciclo) => {
    const valores = VACANCY_STATUS_VALUES.filter((s) => CICLO_POR_STATUS[s] === ciclo).map((s) => `'${s}'`);
    return `WHEN ${alias}.status IN (${valores.join(', ')}) THEN '${ciclo}'`;
  });
  return `(CASE WHEN ${alias}.is_draft IS TRUE THEN 'rascunho' ${porCiclo.join(' ')} END)`;
}

/** Filtro da lista (E7): o SQL do ciclo comparado a um valor da tabela. Valor fora dela não vira SQL. */
export const isCicloDeVida = (v: unknown): v is CicloDeVida => (CICLOS_DE_VIDA as readonly unknown[]).includes(v);
