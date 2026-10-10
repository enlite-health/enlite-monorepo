/**
 * Portas da importação do Tactiq (spec 049 F6): o cofre da transcrição e o gerador do resumo.
 *
 * Regra transversal: NENHUM erro desta camada carrega trecho da transcrição, do resumo, nome de objeto nem corpo de resposta de
 * terceiro — só um `reason` fechado. Quem captura loga o `reason`.
 */

export type VaultPutResult =
  /** O objeto nasceu agora. `generation` é o número do GCS (ou `null` se o adapter não o informou). */
  | { outcome: 'created'; generation: string | null }
  /** Já havia um objeto com esse nome: a precondição `ifGenerationMatch=0` recusou (412). Nada foi sobrescrito. */
  | { outcome: 'already_exists' };

export type TranscriptVaultFailure = 'not_configured' | 'write_failed';

export class TranscriptVaultError extends Error {
  readonly code = 'TRANSCRIPT_VAULT_ERROR';
  constructor(readonly reason: TranscriptVaultFailure) {
    super(`transcript_vault:${reason}`);
    this.name = 'TranscriptVaultError';
  }
}

/**
 * O cofre da transcrição crua (§4.4): SÓ CRIA. Sem ler, listar, apagar nem sobrescrever — a conta de serviço de prd só terá
 * `roles/storage.objectCreator` (F8). Por isso a porta tem UM método.
 */
export interface TranscriptVaultPort {
  putOnce(objectName: string, body: Buffer, meta: { sha256: string }): Promise<VaultPutResult>;
}

/**
 * `prompt_missing`: `ADMISSION_SUMMARY_PROMPT_DOC_ID` sem valor (H4 pendente). `prompt_unavailable`: o Google Doc não leu.
 * Nos dois casos NÃO há resumo com prompt inventado; a próxima execução do job tenta de novo.
 */
export type AdmissionSummaryFailure = 'vertex_failed' | 'empty_response' | 'prompt_missing' | 'prompt_unavailable' | 'prompt_unfilled_placeholder' | 'prompt_catalog_empty' | 'catalog_read_failed' | 'output_truncated' | 'blocked_by_model';

export class AdmissionSummaryError extends Error {
  readonly code = 'ADMISSION_SUMMARY_ERROR';
  /** Só NOMES de marcador/catálogo (`prompt_unfilled_placeholder`, `prompt_catalog_empty`): nunca texto do prompt, do resumo ou da transcrição. */
  constructor(readonly reason: AdmissionSummaryFailure, readonly placeholders: readonly string[] = [], readonly errorClass?: string) {
    super(`admission_summary:${reason}`);
    this.name = 'AdmissionSummaryError';
  }
}

export interface AdmissionSummaryResult {
  /** Resumo legível (sem o JSON). */
  summary: string;
  promptVersion: string;
  /** JSON estruturado do Gem, já parseado; `null` quando inválido/ausente. Só vai ao anexo do PDF. */
  structured?: unknown | null;
  jsonInvalid?: boolean;
}

/** O "Gem" da Enlite, do nosso lado (D482): transcrição -> resumo, via Vertex dentro do perímetro GCP. */
export interface AdmissionSummaryPort {
  generate(input: { transcript: string; entrevistaId?: string; fecha?: string }): Promise<AdmissionSummaryResult>;
}

/** Motivos de `summary_failed` que CHEGARAM ao Vertex (do lado do modelo/rede): só estes contam para o teto de tentativas. */
export const MODEL_SIDE_SUMMARY_FAILURES = ['empty_response', 'output_truncated', 'blocked_by_model', 'vertex_failed'] as const;
export const MAX_SUMMARY_ATTEMPTS = 3;
export const SUMMARY_ATTEMPTS_EXHAUSTED = 'summary_attempts_exhausted';
