/**
 * vacancySemaphorePort — a porta do `n` do semáforo da vaga (semaforo-da-vaga, F2). Molde de `ServiceReserveReaderPort`
 * (`serviceReserve.ts`): o leitor em lote do use case de leitura, UMA consulta para todas as vagas.
 * O dono de `n` é o fragmento `semaforoContagemSql` (matching/infrastructure); a cor sai de `corDoSemaforo` (matching/domain).
 */
export interface VacancySemaphoreReaderPort {
  /** `n` por id de vaga; todo id pedido volta no mapa (vaga sem candidatura = 0). Lista vazia = mapa vazio, sem consulta. */
  readMany(vacancyIds: string[]): Promise<Map<string, number>>;
}
