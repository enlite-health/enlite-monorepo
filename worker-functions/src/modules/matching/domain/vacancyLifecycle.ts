/**
 * vacancyLifecycle — o DONO do selo da vaga (semaforo-da-vaga F4; antes: estado-automatico-do-paciente, F2).
 *
 * Ninguém escolhe estado para a vaga: "no ar" é `vacancyPublication.ts`. O que sobra aqui é o MARCADOR de publicação,
 * 2 valores — `rascunho` (`is_draft`) e `baja` (`DE_BAJA`) — e `null` para o resto (sem selo; D6: o legado pausado ou
 * fechado fica sem selo e fora do ar). Calculado por UMA tabela; a versão SQL (`cicloDeVidaSql`) é GERADA dela.
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

export const CICLOS_DE_VIDA = ['rascunho', 'baja'] as const;
export type CicloDeVida = (typeof CICLOS_DE_VIDA)[number];

/** O marcador de cada valor do CHECK; `null` = sem selo. Só `DE_BAJA` tem selo próprio; `rascunho` vem de `is_draft`. */
export const CICLO_POR_STATUS: Readonly<Record<VacancyStatusValue, Exclude<CicloDeVida, 'rascunho'> | null>> = {
  SEARCHING: null,
  SEARCHING_REPLACEMENT: null,
  RAPID_RESPONSE: null,
  ACTIVE: null,
  PENDING_ACTIVATION: null,
  ON_HOLD: null,
  SUSPENDED: null,
  CLOSED: null,
  DE_BAJA: 'baja',
};

/** `is_draft` manda; senão a tabela. Ternário único, sem `if`. */
export const cicloDeVidaDaVaga = (v: { status: VacancyStatusValue; isDraft: boolean }): CicloDeVida | null =>
  (v.isDraft ? 'rascunho' : CICLO_POR_STATUS[v.status]);

/**
 * O que o CLIENTE pode gravar em `job_postings.status`: NADA. `POST`/`PUT` com `status` dão 400 `VACANCY_STATUS_NOT_WRITABLE`.
 * Escritores de sistema (default de criação `PENDING_ACTIVATION`, baja por serviço, corte legado) não passam por aqui.
 * O contrato `vacancyWritableStatuses` iguala esta lista à do front.
 */
export const STATUS_GRAVAVEIS = [] as const;

/**
 * Versão SQL do mesmo marcador, GERADA da tabela (molde `patientIncompleteAdmissionSql`). `alias` = alias de `job_postings`.
 * Rascunho primeiro; um `WHEN … IN (…)` por marcador com valores; o resto fica NULL (sem selo).
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
