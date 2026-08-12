/**
 * WorkerMirrorProvider — porta plugável para espelhamento de workers em sistemas externos.
 *
 * Design para extensibilidade (ADR: plugável p/ HubSpot depois):
 *   - Cada provider implementa esta interface.
 *   - O use case (BackfillWorkerMirrorUseCase) depende apenas desta porta.
 *   - Trocar de AnaCare para HubSpot = injetar novo provider, zero mudança no use case.
 *
 * Implementações disponíveis:
 *   - AnaCareMirrorProvider (v1 — única implementada)
 */
import type { WorkerMirrorRecord } from './WorkerMirrorRecord';

export interface WorkerMirrorUpsertResult {
  /** ID externo atribuído pelo provider (ex: ID numérico do AnaCare) */
  externalId: string;
}

export interface WorkerMirrorProvider {
  /** Nome legível do provider — usado em logs (sem PII) */
  readonly name: string;

  /**
   * Cria ou atualiza o registro no sistema externo.
   *
   * @param record   Dados neutros do worker (vocabulário Enlite)
   * @param externalId  ID externo já conhecido (null = nunca sincronizado → POST)
   * @returns        { externalId } — ID externo após a operação
   * @throws         Em caso de erro HTTP ou de rede (o caller persiste o erro)
   */
  upsert(
    record: WorkerMirrorRecord,
    externalId: string | null,
  ): Promise<WorkerMirrorUpsertResult>;

  /**
   * Desativa o worker no sistema externo (ex: quando merged ou desabilitado).
   *
   * Opcional: nem todos os providers suportam desativação.
   * Não chamado no backfill v1 — reservado para uso futuro.
   *
   * @param externalId  ID externo do registro a desativar
   */
  deactivate?(externalId: string): Promise<void>;
}
