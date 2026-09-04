/**
 * spec 016 F4 — `SyncPatientFromClickUpTaskUseCase` ganha um passo best-effort que sincroniza
 * "Tipo de Patología" com o diagnóstico CID-11, via `ClickUpDiagnosisMapper` (Facade
 * `PatientDiagnosisService` por baixo, escopado a `DiagnosisSource.CLICKUP`).
 *
 * Molde: `clickup-2.3-mapper-alimenta-o-cru.test.ts` (mesma bancada de dublês, sem banco).
 *
 * Regra do passo, igual aos irmãos (`persistInsuranceVerified`/`persistDeviceTypes`): o
 * paciente JÁ foi gravado quando este passo roda — falhar aqui NUNCA derruba o `kind` do sync,
 * mas também NÃO passa muda (vai para o log de erro, com contagem/causa, nunca o rótulo).
 *
 * `diagnosisMapper` é OPCIONAL — chamadores que não o passam (scripts de import em lote,
 * reconcile) simplesmente não sincronizam diagnóstico nesta fase; é uma decisão de escopo
 * registrada no relatório da F4, não um esquecimento.
 */
import { ClickUpPatientMapper } from '../../../src/modules/integration/infrastructure/clickup/ClickUpPatientMapper';
import { SyncPatientFromClickUpTaskUseCase } from '../../../src/modules/integration/application/SyncPatientFromClickUpTaskUseCase';
import type { SyncPatientDeps } from '../../../src/modules/integration/application/SyncPatientFromClickUpTaskUseCase';
import type { ClickUpFieldResolver } from '../../../src/modules/integration/infrastructure/clickup/ClickUpFieldResolver';
import type { ClickUpTask } from '../../../src/modules/integration/infrastructure/clickup/ClickUpTask';
import type { PatientService } from '../../../src/modules/case/application/PatientService';

const PATOLOGIA = 'Tipo de Patología';

function resolverFalso(): ClickUpFieldResolver {
  return {
    getFieldType: () => 'drop_down',
    resolveDropdown: (f: string, v: number | string | null | undefined) => {
      if (v === null || v === undefined || v === '') return null;
      if (f === PATOLOGIA) return ['Trastorno del Espectro Autista'][Number(v)] ?? null;
      return null;
    },
    resolveLabels: () => [],
    resolveLabel: () => null,
  } as unknown as ClickUpFieldResolver;
}

function tarefa(campos: Record<string, unknown>): ClickUpTask {
  return {
    id: 'task-f4',
    name: 'FIXTURE, Paciente',
    status: { status: 'admisión' },
    parent: null,
    custom_fields: Object.entries(campos).map(([name, value]) => ({ name, value })),
  } as unknown as ClickUpTask;
}

function noopRepo() {
  return {
    replaceForField: jest.fn(async () => ({ outcome: 'skipped-unreadable' as const, received: 0, empty: 0, accepted: [], rejected: [], newlyRejected: 0, rejectionsDurable: 'not-applicable' as const })),
    replaceForPatient: jest.fn(async () => ({ outcome: 'written' as const, received: 0, accepted: [], rejected: [], quarantined: 0 })),
  };
}

function bancada(diagnosisMapper?: { syncFromLabel: jest.Mock }) {
  const mapper = new ClickUpPatientMapper(resolverFalso());
  const patientService = {
    upsertFromClickUp: jest.fn(async () => ({ id: 'patient-f4', created: false, flagged: false })),
  } as unknown as PatientService;

  const erros: unknown[] = [];
  const infos: unknown[] = [];
  jest.spyOn(require('firebase-functions').logger, 'error').mockImplementation((...a: unknown[]) => { erros.push(a); });
  jest.spyOn(require('firebase-functions').logger, 'info').mockImplementation((...a: unknown[]) => { infos.push(a); });
  jest.spyOn(require('firebase-functions').logger, 'warn').mockImplementation(() => {});

  const repo = noopRepo();
  const deps: SyncPatientDeps = {
    mapper,
    patientService,
    sourceLabelRepository: repo as unknown as SyncPatientDeps['sourceLabelRepository'],
    insuranceRepository: repo as unknown as SyncPatientDeps['insuranceRepository'],
    deviceTypeRepository: repo as unknown as SyncPatientDeps['deviceTypeRepository'],
    diagnosisMapper: diagnosisMapper as unknown as SyncPatientDeps['diagnosisMapper'],
  };
  return { deps, erros, infos };
}

afterEach(() => jest.restoreAllMocks());

describe('spec 016 F4 — SyncPatientFromClickUpTaskUseCase sincroniza o diagnóstico do ClickUp', () => {
  it('com diagnosisMapper injetado: chama syncFromLabel(patientId, rótulo) DEPOIS do upsert', async () => {
    const syncFromLabel = jest.fn().mockResolvedValue({ kind: 'synced', outcome: 'created' });
    const b = bancada({ syncFromLabel });

    const r = await new SyncPatientFromClickUpTaskUseCase(b.deps).execute(
      tarefa({ 'Nombre de Paciente': 'Jane', 'Apellido del Paciente': 'Doe', [PATOLOGIA]: 0 }),
      {}, 'cid-f4-1',
    );

    expect(r.kind).toBe('UPDATED');
    expect(syncFromLabel).toHaveBeenCalledWith('patient-f4', 'Trastorno del Espectro Autista');
  });

  it('sem diagnosisMapper (dependência opcional ausente): sync completa normalmente, sem erro', async () => {
    const b = bancada(undefined);

    const r = await new SyncPatientFromClickUpTaskUseCase(b.deps).execute(
      tarefa({ 'Nombre de Paciente': 'Jane', 'Apellido del Paciente': 'Doe', [PATOLOGIA]: 0 }),
      {}, 'cid-f4-2',
    );

    expect(r.kind).toBe('UPDATED');
    expect(b.erros.length).toBe(0);
  });

  it('quando syncFromLabel FALHA: o erro vai para o log, mas o `kind` do sync não muda (best-effort)', async () => {
    const syncFromLabel = jest.fn().mockRejectedValue(new Error('boom sintético'));
    const b = bancada({ syncFromLabel });

    const r = await new SyncPatientFromClickUpTaskUseCase(b.deps).execute(
      tarefa({ 'Nombre de Paciente': 'Jane', 'Apellido del Paciente': 'Doe', [PATOLOGIA]: 0 }),
      {}, 'cid-f4-3',
    );

    expect(r.kind).toBe('UPDATED');
    expect(b.erros.length).toBeGreaterThan(0);
  });

  it('quando resolvePatologiaLabel FALHA (preflight do mapper): loga stage=read e NÃO chama syncFromLabel', async () => {
    const syncFromLabel = jest.fn().mockResolvedValue({ kind: 'synced', outcome: 'created' });
    const b = bancada({ syncFromLabel });
    jest.spyOn(b.deps.mapper, 'resolvePatologiaLabel').mockImplementation(() => {
      throw new Error('catálogo mudou no meio da requisição');
    });

    const r = await new SyncPatientFromClickUpTaskUseCase(b.deps).execute(
      tarefa({ 'Nombre de Paciente': 'Jane', 'Apellido del Paciente': 'Doe', [PATOLOGIA]: 0 }),
      {}, 'cid-f4-5',
    );

    expect(r.kind).toBe('UPDATED');
    expect(syncFromLabel).not.toHaveBeenCalled();
    expect(b.erros.length).toBeGreaterThan(0);
  });

  it('campo "Tipo de Patología" VAZIO: chama syncFromLabel com null (ausência legítima, não erro)', async () => {
    const syncFromLabel = jest.fn().mockResolvedValue({ kind: 'no_label' });
    const b = bancada({ syncFromLabel });

    await new SyncPatientFromClickUpTaskUseCase(b.deps).execute(
      tarefa({ 'Nombre de Paciente': 'Jane', 'Apellido del Paciente': 'Doe' }),
      {}, 'cid-f4-4',
    );

    expect(syncFromLabel).toHaveBeenCalledWith('patient-f4', null);
  });
});
