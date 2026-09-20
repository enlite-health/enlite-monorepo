/**
 * SnapshotSourceUseCase — passo 1 do modelo: tira a "foto" de uma fonte
 * (spec 003, H1).
 *
 * Abre uma rodada, lê a fonte pela porta `PatientSourceReader`, grava um
 * snapshot por registro (só se o hash mudou — lex (a)) e fecha a rodada com a
 * completude MEDIDA:
 *   COMPLETE  read == expected (ou expected desconhecido) e nada pulado
 *   PARTIAL   read < expected, ou houve registros pulados / barrados por C2
 *   FAILED    erro fatal (nada lido)
 *
 * Log só com contagens e ids — nunca dado (lex (e)2).
 */
import { logger, reportError } from '@shared/logging';
import type { PatientSourceReader, SourceReadResult } from '../domain/PatientSourceReader';
import type { RunCompleteness, RunTrigger } from '../domain/enums';
import type { SourceRunRepository, SourceRun } from '../infrastructure/SourceRunRepository';
import { ForbiddenCanonicalError, type SnapshotRepository, type WriteOutcome } from '../infrastructure/SnapshotRepository';

const log = logger.child({ source: 'SnapshotSourceUseCase' });

export interface SnapshotDeps {
  runs: Pick<SourceRunRepository, 'start' | 'finish'>;
  snapshots: Pick<SnapshotRepository, 'writeIfChanged'>;
}

export interface SnapshotInput {
  reader: PatientSourceReader;
  triggeredBy: RunTrigger;
  actorId?: string | null;
}

export type SnapshotCounters = Record<WriteOutcome, number> & { skipped: number; forbidden: number };

export interface SnapshotResult {
  run: SourceRun;
  counters: SnapshotCounters;
  read: SourceReadResult;
}

export function completenessOf(read: SourceReadResult, forbidden = 0): RunCompleteness {
  if (read.fatalError) return 'FAILED';
  if (read.expectedCount !== null && read.readCount < read.expectedCount) return 'PARTIAL';
  if (read.skipped.length > 0 || forbidden > 0) return 'PARTIAL';
  return 'COMPLETE';
}

export class SnapshotSourceUseCase {
  constructor(private readonly deps: SnapshotDeps) {}

  async execute(input: SnapshotInput): Promise<SnapshotResult> {
    const { reader } = input;
    const run = await this.deps.runs.start({
      source: reader.source,
      country: reader.country,
      triggeredBy: input.triggeredBy,
      actorId: input.actorId ?? null,
    });
    log.info({ msg: 'snapshot.start', runId: run.id, source: reader.source, country: reader.country });

    const counters: SnapshotCounters = { CREATED: 0, REPLACED: 0, UNCHANGED: 0, skipped: 0, forbidden: 0 };
    let read: SourceReadResult;
    try {
      read = await reader.read();
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'SnapshotSourceUseCase:read', runId: run.id });
      const finished = await this.deps.runs.finish(run.id, {
        expectedCount: null, readCount: 0, completeness: 'FAILED', error: `reader_threw:${e.name}`,
      });
      return { run: finished, counters, read: { source: reader.source, country: reader.country, records: [], expectedCount: null, readCount: 0, skipped: [], fatalError: e.name } };
    }

    if (!read.fatalError) {
      for (const rec of read.records) {
        try {
          const outcome = await this.deps.snapshots.writeIfChanged({
            runId: run.id, source: reader.source, country: reader.country, externalId: rec.externalId, canonical: rec.canonical,
          });
          counters[outcome] += 1;
        } catch (err) {
          if (err instanceof ForbiddenCanonicalError) {
            counters.forbidden += 1;
            log.warn({ msg: 'snapshot.forbidden_canonical', runId: run.id, externalId: rec.externalId });
            continue;
          }
          throw err;
        }
      }
    }
    counters.skipped = read.skipped.length;

    const completeness = completenessOf(read, counters.forbidden);
    const finished = await this.deps.runs.finish(run.id, {
      expectedCount: read.expectedCount,
      readCount: read.readCount - counters.forbidden,
      completeness,
      error: read.fatalError ?? null,
    });
    log.info({ msg: 'snapshot.finish', runId: run.id, source: reader.source, completeness, ...counters,
      expected: read.expectedCount, read: read.readCount });
    return { run: finished, counters, read };
  }
}
