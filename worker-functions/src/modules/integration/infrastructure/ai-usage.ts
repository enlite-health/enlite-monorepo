/**
 * ai-usage (spec 082, DF-10 / DF-13 / §9.6 / §9.7)
 *
 * Atribuição de custo das chamadas Vertex do worker-functions, em 2 trilhas:
 *  1. `labels` no corpo da requisição (aparecem no export de billing por SKU);
 *  2. uma linha de log `ai_usage` por chamada, que o log sink exporta ao BigQuery.
 *
 * A linha tem SOMENTE as 7 chaves de `AiUsageLine`: nunca prompt, resposta, id de pessoa ou paciente (RF-12).
 * Mapa único logTag → { funcao, setor }: tag fora do mapa vira `nao_mapeado`/`plataforma` (nunca some).
 */
import { logger } from '@shared/logging/Logger';
import { loggingAls } from '@shared/logging/als';

export const AI_USAGE_SERVICE = 'worker-functions';

export interface AiAttribution {
  funcao: string;
  setor: string;
}

export const AI_ATTRIBUTION_BY_LOG_TAG: Readonly<Record<string, AiAttribution>> = {
  GeminiParser: { funcao: 'parser_vaga', setor: 'recrutamento' },
  TalentumDesc: { funcao: 'talentum_descricao', setor: 'recrutamento' },
  AdmissionSummary: { funcao: 'resumo_admissao', setor: 'admissao' },
  VertexHealth: { funcao: 'vertex_health', setor: 'plataforma' },
};

const UNMAPPED: AiAttribution = { funcao: 'nao_mapeado', setor: 'plataforma' };

export function attributionFor(logTag: string): AiAttribution {
  return Object.prototype.hasOwnProperty.call(AI_ATTRIBUTION_BY_LOG_TAG, logTag) ? AI_ATTRIBUTION_BY_LOG_TAG[logTag] : UNMAPPED;
}

/** Corpo com `labels` mesclados; chave que o chamador já mandou nunca é sobrescrita. Não muta o objeto do chamador. */
export function withAiLabels(body: Record<string, unknown>, logTag: string): Record<string, unknown> {
  const { funcao, setor } = attributionFor(logTag);
  const existing = body.labels && typeof body.labels === 'object' && !Array.isArray(body.labels) ? (body.labels as Record<string, unknown>) : {};
  return { ...body, labels: { service: AI_USAGE_SERVICE, setor, funcao, ...existing } };
}

/** A linha emitida: exatamente estas chaves (CA-11). */
export interface AiUsageLine {
  event: 'ai_usage';
  service: string;
  setor: string;
  funcao: string;
  model: string;
  tokens_in: number;
  tokens_out: number;
}

function count(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Monta a linha a partir do `usageMetadata`; tokens_out = candidatos + raciocínio (como o assistants-service). */
export function buildAiUsageLine(model: string, logTag: string, usage: unknown): AiUsageLine {
  const u = (usage && typeof usage === 'object' ? usage : {}) as Record<string, unknown>;
  const { funcao, setor } = attributionFor(logTag);
  return {
    event: 'ai_usage',
    service: AI_USAGE_SERVICE,
    setor,
    funcao,
    model,
    tokens_in: count(u.promptTokenCount),
    tokens_out: count(u.candidatesTokenCount) + count(u.thoughtsTokenCount),
  };
}

/**
 * Lê `usageMetadata` de um CLONE da resposta e emite UMA linha `ai_usage`. Best-effort: qualquer falha vira
 * warn sem corpo e a chamada original segue intacta.
 */
export async function emitAiUsage(res: Response, model: string, logTag: string): Promise<void> {
  try {
    const data = (await res.clone().json()) as { usageMetadata?: unknown } | null;
    const line = buildAiUsageLine(model, logTag, data?.usageMetadata);
    // `exit` tira a linha do contexto da request: o mixin do logger acrescentaria workerId/jobPostingId (RF-12: nenhum id).
    loggingAls.exit(() => logger.info(line));
  } catch {
    logger.warn({ event: 'ai_usage_read_failed', funcao: attributionFor(logTag).funcao }, 'ai_usage: could not read usageMetadata');
  }
}
