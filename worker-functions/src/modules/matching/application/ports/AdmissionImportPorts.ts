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
 * O bucket de ENSAIO (spec 050 R-29): a mesma porta, outro destino. `isConfigured()` deixa o serviço FALHAR FECHADO antes de
 * qualquer chamada paga quando `ADMISSION_REHEARSAL_BUCKET` falta — transcrição de ensaio nunca cai no cofre de 5 anos.
 */
export interface RehearsalVaultPort extends TranscriptVaultPort {
  isConfigured(): boolean;
}

/**
 * `prompt_missing`: `ADMISSION_SUMMARY_PROMPT_DOC_ID` sem valor (H4 pendente). `prompt_unavailable`: o Google Doc não leu.
 * Nos dois casos NÃO há resumo com prompt inventado; a próxima execução do job tenta de novo.
 */
export type AdmissionSummaryFailure = 'vertex_failed' | 'empty_response' | 'prompt_missing' | 'prompt_unavailable' | 'prompt_unfilled_placeholder' | 'prompt_catalog_empty' | 'catalog_read_failed' | 'output_truncated' | 'blocked_by_model' | 'vertex_transient' | 'post_model_failed' | 'vertex_timeout' | 'vertex_auth_failed';

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

/**
 * Motivos de `summary_failed` que contam para o teto: o modelo foi chamado e a chamada foi PAGA (resposta ruim ou falha depois dela)
 * ou o pedido foi recusado por configuração/permissão (400/401/403/404 = `vertex_failed`). 429, 5xx, timeout e rede são
 * `vertex_transient` e NÃO contam: não custam token e uma queda do Vertex não pode tirar reuniões da fila. `vertex_timeout` (prazo
 * estourado com o pedido já enviado) CONTA. `vertex_auth_failed` (credencial) NÃO conta.
 */
export const MODEL_SIDE_SUMMARY_FAILURES = ['empty_response', 'output_truncated', 'blocked_by_model', 'vertex_failed', 'vertex_timeout', 'post_model_failed'] as const;
export const MAX_SUMMARY_ATTEMPTS = 3;
export const SUMMARY_ATTEMPTS_EXHAUSTED = 'summary_attempts_exhausted';
