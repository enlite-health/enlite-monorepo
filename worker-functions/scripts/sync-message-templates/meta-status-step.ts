import { logger } from '@shared/logging';
import type { SyncResult } from '../../src/modules/notification/infrastructure/MetaTemplateStatusProvider';

/**
 * meta-status-step — grava o estado de autorização da Meta, e SÓ isso.
 *
 * 🔒 Por que é um passo separado, e não uma mudança no `collectApprovedTwilio`
 * (decisão do Gabriel em 31/08, opção "c"):
 *
 * O `collectApprovedTwilio` filtra por `status === 'approved'`, e o que ele
 * devolve alimenta o `approvedSids` do `computePlan` — que decide o **DELETE**.
 * Medido com o código real: um template que a Meta PAUSE sai do conjunto de
 * aprovados e a linha dele entra no plano de remoção
 * (`DELETE FROM message_templates WHERE id = $1`). Só 5 dos 28 slugs têm a
 * guarda `HARDCODED_SLUGS`; os outros 23 são apagados em silêncio.
 *
 * Isso é um defeito real e ANTERIOR a esta feature, e consertá-lo muda o que o
 * sync apaga — semântica, não robustez. Por isso ele foi para task própria, e
 * este passo NÃO toca no plano: escreve apenas as colunas `meta_approval_*`.
 *
 * Consequência honesta enquanto o bug viver: uma mensagem pausada pela Meta
 * pode ter o estado gravado aqui e a linha removida logo depois pelo plano.
 * O estado gravado não a protege — ele só a descreve.
 */

/** O provider real e o dublê de teste compartilham só o que este passo usa. */
export interface MetaStatusSyncer {
  readonly configured: boolean;
  syncStatuses(): Promise<SyncResult>;
}

export interface MetaStatusStepOutcome {
  /** Preenchido quando rodou. */
  result: SyncResult | null;
  /** Por que não rodou, quando não rodou. */
  skipped: 'dry-run' | 'sem-credencial' | null;
  /** Mensagem de erro quando a Meta falhou. Não derruba o sync. */
  error: string | null;
}

/**
 * Roda o passo, ou explica por que não rodou.
 *
 * Nunca lança: o trabalho principal do sync é Twilio → banco, e a Meta estar
 * fora do ar não pode impedir que ele aconteça. Falha vira campo no resultado
 * — quem chama decide o que fazer, e o resultado é impresso, nunca engolido.
 */
export async function runMetaStatusStep(
  provider: MetaStatusSyncer,
  opts: { apply: boolean },
): Promise<MetaStatusStepOutcome> {
  if (!opts.apply) {
    return { result: null, skipped: 'dry-run', error: null };
  }
  if (!provider.configured) {
    logger.warn({ msg: 'meta_status_step_sem_credencial' });
    return { result: null, skipped: 'sem-credencial', error: null };
  }
  try {
    return { result: await provider.syncStatuses(), skipped: null, error: null };
  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    logger.warn({ msg: 'meta_status_step_falhou', erro: e.message });
    return { result: null, skipped: null, error: e.message };
  }
}

/**
 * Linhas para o console do sync. Separado da execução porque relatório é
 * formatação, e formatação não merece um `try` em volta.
 *
 * Imprime as LISTAS, não só as contagens: contagem zero tanto significa "nada
 * fora do lugar" quanto "não olhei", e só a lista distingue os dois.
 */
export function describeMetaStatusStep(o: MetaStatusStepOutcome): string[] {
  if (o.skipped === 'dry-run') return ['[meta] dry-run — estado da Meta não gravado. Use --apply.'];
  if (o.skipped === 'sem-credencial') return ['[meta] WABA_ID/WABA_TOKEN ausentes — estado não atualizado.'];
  if (o.error) return [`[meta] falhou (o sync seguiu): ${o.error}`];
  const r = o.result;
  if (!r) return ['[meta] sem resultado.'];
  const out = [`[meta] ${r.fetched} templates lidos, ${r.matched} com estado gravado.`];
  if (r.withoutContentSid.length > 0) {
    out.push(`[meta] ${r.withoutContentSid.length} sem content_sid no nome (não nasceram na Twilio): ${r.withoutContentSid.join(', ')}`);
  }
  if (r.unknownToUs.length > 0) {
    out.push(`[meta] ${r.unknownToUs.length} content_sid que a Meta tem e o banco não: ${r.unknownToUs.join(', ')}`);
  }
  if (r.unknownStatuses.length > 0) {
    out.push(`[meta] estados fora dos 10 documentados (gravados assim mesmo): ${r.unknownStatuses.join(', ')}`);
  }
  return out;
}
