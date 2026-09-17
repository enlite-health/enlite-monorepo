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
import type { EnliteDirectorySource, ShiftSyncRepository } from '../domain/AnaCareHoursSyncPorts';
import { ANACARE_HOURS_SOURCE_ENV, FakeAnaCareShiftsSource } from './FakeAnaCareShiftsSource';
import { FakeEnliteDirectory, FakeAnaCareShiftRepository } from './FakeAnaCareSyncDependencies';
import { AnaCareShiftRepository } from './AnaCareShiftRepository';

export interface AnaCareSyncDependencies {
  source: AnaCareShiftsSource;
  directory: EnliteDirectorySource;
  repository: ShiftSyncRepository;
}

export function createAnaCareSyncDependencies(env: NodeJS.ProcessEnv = process.env): AnaCareSyncDependencies | null {
  const selected = env[ANACARE_HOURS_SOURCE_ENV];
  if (selected === 'fake') {
    return { source: new FakeAnaCareShiftsSource(), directory: new FakeEnliteDirectory(), repository: new FakeAnaCareShiftRepository() };
  }
  if (selected === 'real') {
    try {
      const client = new AnaCareSessionClient();
      return { source: new AnaCareShiftsSourceReal(client), directory: new AnaCareEnliteDirectory(client), repository: new AnaCareShiftRepository() };
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      reportError(e, { source: 'createAnaCareSyncDependencies:real' });
      return null;
    }
  }
  return null;
}
