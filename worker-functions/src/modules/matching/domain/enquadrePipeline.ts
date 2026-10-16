/**
 * Selos da esteira pós-call do evento (spec 052, Fase 3, T-36c). O servidor DERIVA do `import_status` + existência do documento do
 * resumo (`enquadre_event_documents`) + presença; a tela só traduz.
 *
 * Sem a quinta célula (`enquadre_summary:read`) o campo `summary` NÃO vem na resposta (a chave some, não vira `null`): "nem o selo
 * aparece". `cells === null` = o engine não decidiu nesta request (família fora de `PERMISSION_ENFORCED_ROUTES`, engine desligado):
 * comportamento inalterado, como em `projectWorkerFields` (D113).
 */
export const ENQUADRE_SUMMARY_CELL = 'enquadre_summary:read';

export interface EnquadrePipelineState {
  importStatus: string | null;
  /** AUSENTE sem a célula `enquadre_summary:read`. */
  summary?: 'waiting' | 'ready' | 'unavailable';
  /** Código fechado do motivo (`meet_scope_missing`, `no_link`, ...), só com `importStatus === 'blocked'`. */
  blockedReason: string | null;
  /** Convocados com presença `unidentified` (período de teste da ligação por nome). 0 = nenhum ou presença ainda não medida. */
  unidentifiedCount: number;
}

export interface PipelineInput {
  importStatus: string | null;
  blockedReason: string | null;
  hasSummary: boolean;
  unidentifiedCount: number;
}

export function canSeeSummary(cells: readonly string[] | null): boolean {
  return cells === null || cells.includes(ENQUADRE_SUMMARY_CELL);
}

/** Enquanto `import_status` é nulo não há esteira: `pipeline: null`. */
export function pipelineOf(input: PipelineInput, cells: readonly string[] | null): EnquadrePipelineState | null {
  if (input.importStatus === null) return null;
  const state: EnquadrePipelineState = {
    importStatus: input.importStatus,
    blockedReason: input.importStatus === 'blocked' ? input.blockedReason : null,
    unidentifiedCount: input.unidentifiedCount,
  };
  if (canSeeSummary(cells)) state.summary = input.hasSummary ? 'ready' : input.importStatus === 'done' ? 'unavailable' : 'waiting';
  return state;
}
