/**
 * Escopo "sem baja" da lista de pacientes do admin (pedido do Gabriel, 29/10/2026).
 *
 * UMA fonte só, lida por `PatientQueryRepository.list` (lista + total/paginação) e
 * `PatientQueryRepository.stats` (cards): a lista e o contador nunca discordam.
 *
 * Opt-in por parâmetro explícito — o default do backend NÃO muda, porque o Kanban (que
 * tem coluna DISCHARGED) e o dashboard de gestão leem os mesmos endpoints sem o parâmetro.
 * `IS DISTINCT FROM` mantém a linha com status NULL (legado) visível.
 */
export const DISCHARGED_STATUS = 'DISCHARGED';

export function excludeDischargedSql(paramIdx: number, alias = 'p'): string {
  return `($${paramIdx}::boolean IS NOT TRUE OR ${alias}.status IS DISTINCT FROM '${DISCHARGED_STATUS}')`;
}
