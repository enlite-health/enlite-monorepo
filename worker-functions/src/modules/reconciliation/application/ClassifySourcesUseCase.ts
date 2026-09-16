/**
 * ClassifySourcesUseCase — passo 2 do modelo: quem está onde (spec 003, H1).
 *
 * Para o último snapshot de cada fonte, resolve a identidade de cada registro
 * contra os pacientes da plataforma (IdentityMatcher) e grava/atualiza o link:
 *   MATCH      → AUTO (patient_id)
 *   AMBIGUOUS  → AMBIGUOUS (candidate_patient_id) — fila do Gabriel
 *   NONE       → AUTO com match_key NONE e patient_id NULL ("só na fonte")
 * Links CONFIRMED/DENIED nunca são tocados (o repositório garante).
 *
 * Rodada PARTIAL classifica o que leu, mas NÃO infere ausência: nenhum link é
 * marcado como "sumiu" — ausência numa leitura parcial não é ausência (H1 c.3).
 * A view v_patient_source_inventory deriva os quatro conjuntos.
 */
import { logger } from '@shared/logging';
import type { Country, Source } from '../domain/enums';
import { IdentityMatcher, type IdentityCandidate, type MatchOutcome } from '../domain/IdentityMatcher';
import type { IdentityLinkRepository, InventoryCounts } from '../infrastructure/IdentityLinkRepository';
import type { SnapshotRepository } from '../infrastructure/SnapshotRepository';
import type { SourceRunRepository, SourceRun } from '../infrastructure/SourceRunRepository';

const log = logger.child({ source: 'ClassifySourcesUseCase' });

export interface ClassifyDeps {
  runs: Pick<SourceRunRepository, 'findLatestUsable'>;
  snapshots: Pick<SnapshotRepository, 'latestBySource'>;
  links: Pick<IdentityLinkRepository, 'identityCandidates' | 'deniedPatientIds' | 'upsertAutomatic' | 'inventoryCounts'>;
  matcher?: IdentityMatcher;
}

export interface ClassifyResult {
  runs: Partial<Record<Source, SourceRun>>;
  perSource: Partial<Record<Source, { matched: number; ambiguous: number; unmatched: number; partial: boolean }>>;
  counts: InventoryCounts;
}

export class ClassifySourcesUseCase {
  private readonly matcher: IdentityMatcher;

  constructor(private readonly deps: ClassifyDeps) {
    this.matcher = deps.matcher ?? new IdentityMatcher();
  }

  async execute(input: { country: Country }): Promise<ClassifyResult> {
    const candidates = await this.deps.links.identityCandidates(input.country);
    const result: ClassifyResult = { runs: {}, perSource: {}, counts: { onlyClickup: 0, onlyAnacare: 0, both: 0, ambiguous: 0, total: 0 } };

    for (const source of ['CLICKUP', 'ANACARE'] as const) {
      const run = await this.deps.runs.findLatestUsable(source, input.country);
      if (!run) continue;
      result.runs[source] = run;
      const rows = await this.deps.snapshots.latestBySource(source, input.country);
      const tally = { matched: 0, ambiguous: 0, unmatched: 0, partial: run.completeness === 'PARTIAL' };

      for (const snap of rows) {
        const denied = await this.deps.links.deniedPatientIds(source, snap.externalId);
        // Id do espelho é a chave mais forte, simétrica: patients.clickup_task_id (D56) e
        // patients.ana_care_id (migration 300). Só depois entra a heurística de pessoa.
        const byExternalId = candidates.find(c =>
          (source === 'CLICKUP' ? c.clickupTaskId : c.anaCareId) === snap.externalId && !denied.has(c.patientId));
        const outcome: MatchOutcome = byExternalId
          ? { kind: 'MATCH', matchKey: 'EXTERNAL_ID', patientId: byExternalId.patientId }
          : this.matcher.match(snap.canonical, candidates as readonly IdentityCandidate[], denied);
        if (outcome.kind === 'MATCH') {
          tally.matched += 1;
          await this.deps.links.upsertAutomatic({ source, country: input.country, externalId: snap.externalId,
            patientId: outcome.patientId, matchKey: outcome.matchKey, state: 'AUTO', lastRunId: run.id });
        } else if (outcome.kind === 'AMBIGUOUS') {
          tally.ambiguous += 1;
          await this.deps.links.upsertAutomatic({ source, country: input.country, externalId: snap.externalId,
            patientId: null, matchKey: 'NONE', state: 'AMBIGUOUS', candidatePatientId: outcome.candidatePatientId, lastRunId: run.id });
        } else {
          tally.unmatched += 1;
          await this.deps.links.upsertAutomatic({ source, country: input.country, externalId: snap.externalId,
            patientId: null, matchKey: 'NONE', state: 'AUTO', lastRunId: run.id });
        }
      }
      result.perSource[source] = tally;
      log.info({ msg: 'classify.source', source, runId: run.id, ...tally, records: rows.length });
    }

    result.counts = await this.deps.links.inventoryCounts(input.country);
    log.info({ msg: 'classify.done', country: input.country, ...result.counts });
    return result;
  }
}
