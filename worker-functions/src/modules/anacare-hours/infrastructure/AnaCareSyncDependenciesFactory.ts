/**
 * src/modules/anacare-hours/infrastructure/AnaCareSyncDependenciesFactory.ts
 *
 * Monta as 3 dependências do `AnaCareHoursSyncRunner` (fonte, diretório, repositório) pela MESMA
 * env `ANACARE_HOURS_SOURCE` que `createAnaCareShiftsSource` já usa para a leitura — fail-closed
 * igual: sem a env (ou valor desconhecido), devolve `null` (503 `ANACARE_SOURCE_NOT_CONFIGURED`).
 *
 * `'real'`: fonte e diretório compartilham a MESMA instância de `AnaCareSessionClient` (login,
 * cookie, rate limiter) — nenhuma sessão paralela. `'fake'`: as 3 dependências são 100% em
 * memória (nunca rede/Postgres real), mesmo racional de `FakeAnaCareShiftsSource`.
 */
import { AnaCareSessionClient, AnaCareShiftsSourceReal, AnaCareEnliteDirectory } from '@modules/integration';
import { reportError } from '@shared/logging';
import type { AnaCareShiftsSource } from '../domain/AnaCareShiftsSource';
import type { DirectorySnapshotRepository, EnliteDirectorySource, PatientMonthSyncRepository, SyncRunRepository } from '../domain/AnaCareHoursSyncPorts';
import { ANACARE_HOURS_SOURCE_ENV, FakeAnaCareShiftsSource } from './FakeAnaCareShiftsSource';
import { FakeEnliteDirectory, FakeAnaCareDirectorySnapshotRepository, FakeAnaCarePatientMonthRepository, FakeAnaCareSyncRunRepository } from './FakeAnaCareSyncDependencies';
import { AnaCareDirectorySnapshotRepository } from './AnaCareDirectorySnapshotRepository';
import { AnaCarePatientMonthRepository } from './AnaCarePatientMonthRepository';
import { AnaCareSyncRunRepository } from './AnaCareSyncRunRepository';

export interface AnaCareSyncDependencies {
  source: AnaCareShiftsSource;
  directory: EnliteDirectorySource;
  /** Alarme de queda do diretório (`anacare_directory_snapshot`) — separado do retrato por turno desde o passo 2 (conserto 17/09). */
  directorySnapshotRepository: DirectorySnapshotRepository;
  /** F6.1 (D361): retrato AGREGADO por paciente+mês (`anacare_patient_month`, migration 441). */
  patientMonthRepository: PatientMonthSyncRepository;
  /** Gate `revisao-pr` (fecho 17/09): carimbo da corrida do SERVIDOR (`anacare_sync_run`, migration 443). */
  syncRunRepository: SyncRunRepository;
}

export function createAnaCareSyncDependencies(env: NodeJS.ProcessEnv = process.env): AnaCareSyncDependencies | null {
  const selected = env[ANACARE_HOURS_SOURCE_ENV];
  if (selected === 'fake') {
    return {
      source: new FakeAnaCareShiftsSource(),
      directory: new FakeEnliteDirectory(),
      directorySnapshotRepository: new FakeAnaCareDirectorySnapshotRepository(),
      patientMonthRepository: new FakeAnaCarePatientMonthRepository(),
      syncRunRepository: new FakeAnaCareSyncRunRepository(),
    };
  }
  if (selected === 'real') {
    try {
      const client = new AnaCareSessionClient();
      return {
        source: new AnaCareShiftsSourceReal(client),
        directory: new AnaCareEnliteDirectory(client),
        directorySnapshotRepository: new AnaCareDirectorySnapshotRepository(),
        patientMonthRepository: new AnaCarePatientMonthRepository(),
        syncRunRepository: new AnaCareSyncRunRepository(),
      };
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'createAnaCareSyncDependencies:real' });
      return null;
    }
  }
  return null;
}
