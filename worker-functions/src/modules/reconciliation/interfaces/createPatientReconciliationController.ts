/**
 * createPatientReconciliationController — composição manual (sem container),
 * no molde de ReconcileClickUpPatientsController.buildUseCase (spec 003).
 *
 * Leitor de fonte, construído sob demanda:
 *  - ANACARE: API de paciente do Ana Care. Ainda não existe → implementação
 *    `AnaCarePatientApiUnavailable`; quando existir, troca-se AQUI, e só aqui.
 *
 * CLICKUP saiu como fonte de snapshot (D314 — `ClickUpTaskListGateway` removido
 * do main/stage; a 003 original já classificava ClickUp como fonte em
 * transição, não definitiva). `readerFactory` só sabe construir ANACARE; pedir
 * CLICKUP lança erro explícito em vez de silenciosamente devolver algo errado.
 */
import type { Pool } from 'pg';
import { PatientReconciliationController } from './controllers/PatientReconciliationController';
import { SourceRunRepository } from '../infrastructure/SourceRunRepository';
import { SnapshotRepository } from '../infrastructure/SnapshotRepository';
import { IdentityLinkRepository } from '../infrastructure/IdentityLinkRepository';
import { FieldMapRepository } from '../infrastructure/FieldMapRepository';
import { AnaCareApiSourceReader } from '../infrastructure/AnaCareApiSourceReader';
import { SnapshotSourceUseCase } from '../application/SnapshotSourceUseCase';
import { SnapshotSourceWithLockUseCase } from '../application/SnapshotSourceWithLockUseCase';
import { ClassifySourcesUseCase } from '../application/ClassifySourcesUseCase';
import { AnaCarePatientApiUnavailable, type AnaCarePatientApi } from '../domain/AnaCarePatientApi';
import type { Country, Source } from '../domain/enums';
import type { PatientSourceReader } from '../domain/PatientSourceReader';

export interface ControllerFactoryOptions {
  pool?: Pool;
  /** Injetável para teste / para a implementação real quando a API existir. */
  anaCareApi?: AnaCarePatientApi;
}

export function createPatientReconciliationController(opts: ControllerFactoryOptions = {}): PatientReconciliationController {
  const { pool } = opts;
  const runs = new SourceRunRepository(pool);
  const snapshots = new SnapshotRepository(pool);
  const links = new IdentityLinkRepository(pool);
  const fieldMap = new FieldMapRepository(pool);
  const snapshot = new SnapshotSourceUseCase({ runs, snapshots });
  const anaCareApi = opts.anaCareApi ?? new AnaCarePatientApiUnavailable();

  const readerFactory = async (source: Source, country: Country): Promise<PatientSourceReader> => {
    if (source === 'CLICKUP') throw new Error('clickup_source_removed: D314 — ClickUp deixou de ser fonte de reconciliação');
    return new AnaCareApiSourceReader(anaCareApi, await fieldMap.activeFor('ANACARE'), country);
  };

  return new PatientReconciliationController({
    snapshot: async () => new SnapshotSourceWithLockUseCase({ readerFactory, snapshot, pool }),
    classify: async () => new ClassifySourcesUseCase({ runs, snapshots, links }),
    runs,
    links,
    snapshots,
  });
}
