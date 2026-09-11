/**
 * I1/I3 — as BORDAS de `SyncPatientFromClickUpTaskUseCase` que o piso 100/100/100/100 exige.
 *
 * Todos os passos best-effort deste use case (`persistSourceLabels`, `persistInsuranceVerified`,
 * `persistDeviceTypes`, `persistDiagnosis`, `syncChatIds`) têm o MESMO contrato: falhar não
 * derruba o `kind` do sync, mas também NÃO passa mudo. Esse contrato é o que o I1 acabou de
 * mover para cima do early-return — e ele só vale se cada `catch` de fato existir e logar.
 *
 * Aqui os erros são lançados de propósito, inclusive na forma NÃO-`Error` (uma string), que é o
 * ramo `err instanceof Error ? err : new Error(String(err))` — o que nenhum teste exercia e o
 * que, num incidente real, decide entre "erro com mensagem" e `[object Object]` no Cloud Logging.
 */
// O `PatientChatIdsService` REAL abre pool no construtor dos seus repositórios — e o último
// teste deste arquivo existe justamente para provar que ele só é construído sob demanda.
// Dublar a conexão é o que permite exercer esse `??=` sem banco.
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: jest.fn() }) }) },
}));

import { SyncPatientFromClickUpTaskUseCase } from '../SyncPatientFromClickUpTaskUseCase';
import type { SyncPatientDeps } from '../SyncPatientFromClickUpTaskUseCase';
import { ClickUpPatientMapper } from '../../infrastructure/clickup/ClickUpPatientMapper';
import type { ClickUpFieldResolver } from '../../infrastructure/clickup/ClickUpFieldResolver';
import type { ClickUpTask } from '../../infrastructure/clickup/ClickUpTask';
import type { PatientService } from '../../../case/application/PatientService';

const PATIENT_ID = 'patient-bordas-i2c';

function resolverFalso(): ClickUpFieldResolver {
  return {
    getFieldType: () => 'drop_down',
    resolveDropdown: () => null,
    resolveLabel:  () => null,
    resolveLabels: () => [],
    dropdownFieldNames: [], labelsFieldNames: [],
    getDropdownOptions: () => ({}), getLabelsOptions: () => ({}),
  } as unknown as ClickUpFieldResolver;
}

function tarefa(campos: Record<string, unknown> = {}): ClickUpTask {
  return {
    id: 'task-bordas-i2c',
    name: 'QA, Bordas',
    status: { status: 'admisión' },
    parent: null,
    custom_fields: Object.entries({
      'Nombre de Paciente': 'Bordas', 'Apellido del Paciente': 'QA I2C', ...campos,
    }).map(([name, value]) => ({ name, value })),
  } as unknown as ClickUpTask;
}

function repoOk() {
  return {
    replaceForField:   jest.fn(async () => ({ outcome: 'written' as const, received: 0, empty: 0, accepted: [], rejected: [], newlyRejected: 0, rejectionsDurable: 'not-applicable' as const })),
    replaceForPatient: jest.fn(async () => ({ outcome: 'written' as const, received: 0, accepted: [], rejected: [], quarantined: 0 })),
  };
}

function bancada(over: Partial<SyncPatientDeps> = {}) {
  const erros: unknown[][] = [];
  jest.spyOn(require('firebase-functions').logger, 'error').mockImplementation((...a: unknown[]) => { erros.push(a); });
  jest.spyOn(require('firebase-functions').logger, 'info').mockImplementation(() => {});
  jest.spyOn(require('firebase-functions').logger, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});

  const repo = repoOk();
  const deps: SyncPatientDeps = {
    mapper: new ClickUpPatientMapper(resolverFalso()),
    patientService: {
      upsertFromClickUp: jest.fn(async () => ({ id: PATIENT_ID, created: false, flagged: false })),
    } as unknown as PatientService,
    sourceLabelRepository: repo as unknown as SyncPatientDeps['sourceLabelRepository'],
    insuranceRepository:   repo as unknown as SyncPatientDeps['insuranceRepository'],
    deviceTypeRepository:  repo as unknown as SyncPatientDeps['deviceTypeRepository'],
    ...over,
  };
  return { deps, erros };
}

/** A mensagem que só aparece quando o `catch` sabe lidar com quem lança NÃO-`Error`. */
const NAO_ERRO = 'lancado-como-string-i2c';
const eventos = (erros: unknown[][]): string[] => erros.map(a => String(a[0]));

afterEach(() => jest.restoreAllMocks());

describe('erro NÃO-Error em cada passo best-effort vira mensagem legível, e o sync não cai', () => {
  it('`map()` lançando uma string → kind=ERROR com um Error de verdade no resultado', async () => {
    const b = bancada();
    jest.spyOn(b.deps.mapper, 'map').mockImplementation(() => { throw NAO_ERRO; });

    const r = await new SyncPatientFromClickUpTaskUseCase(b.deps).execute(tarefa(), {}, 'cid-b1');

    expect(r.kind).toBe('ERROR');
    expect((r as { error: Error }).error).toBeInstanceOf(Error);
    expect((r as { error: Error }).error.message).toBe(NAO_ERRO);
  });

  it('`upsertFromClickUp` lançando uma string → kind=ERROR, mensagem preservada', async () => {
    const b = bancada();
    (b.deps.patientService.upsertFromClickUp as jest.Mock).mockRejectedValue(NAO_ERRO);

    const r = await new SyncPatientFromClickUpTaskUseCase(b.deps).execute(tarefa(), {}, 'cid-b2');

    expect(r.kind).toBe('ERROR');
    expect((r as { error: Error }).error.message).toBe(NAO_ERRO);
  });

  it('cobertura: escrita lançando string → evento próprio de erro, `kind` intacto', async () => {
    const b = bancada();
    (b.deps.insuranceRepository.replaceForPatient as unknown as jest.Mock)
      .mockRejectedValueOnce(NAO_ERRO);

    const r = await new SyncPatientFromClickUpTaskUseCase(b.deps).execute(tarefa(), {}, 'cid-b3');

    expect(r.kind).toBe('UPDATED');
    expect(eventos(b.erros)).toContain('clickup_patient_sync.insurance_verified_error');
  });

  it('cobertura: escrita lançando um Error DE VERDADE → NUNCA a mensagem original, só errorName+code', async () => {
    const b = bancada();
    (b.deps.insuranceRepository.replaceForPatient as unknown as jest.Mock)
      .mockRejectedValueOnce(new Error('pool esgotado i2c'));

    const r = await new SyncPatientFromClickUpTaskUseCase(b.deps).execute(tarefa(), {}, 'cid-b3b');

    expect(r.kind).toBe('UPDATED');
    const evento = b.erros.find(a => a[0] === 'clickup_patient_sync.insurance_verified_error');
    expect(evento![1]).toMatchObject({ errorName: 'Error', code: null, stage: 'write' });
    expect(evento![1]).not.toHaveProperty('message');
    expect(evento![1]).not.toHaveProperty('stack');
    expect(JSON.stringify(evento)).not.toContain('pool esgotado i2c');
  });

  it('cru: `readSourceLabels` lançando um Error DE VERDADE → NUNCA a mensagem original, só errorName+code', async () => {
    const b = bancada();
    jest.spyOn(b.deps.mapper, 'readSourceLabels').mockImplementation(() => {
      throw new Error('catálogo mudou no meio da requisição i2c');
    });

    const r = await new SyncPatientFromClickUpTaskUseCase(b.deps).execute(tarefa(), {}, 'cid-b7b');

    expect(r.kind).toBe('UPDATED');
    const evento = b.erros.find(a => a[0] === 'clickup_patient_sync.source_labels_error');
    expect(evento![1]).toMatchObject({ errorName: 'Error', code: null, stage: 'read' });
    expect(evento![1]).not.toHaveProperty('message');
    expect(evento![1]).not.toHaveProperty('stack');
    expect(JSON.stringify(evento)).not.toContain('catálogo mudou no meio da requisição i2c');
  });

  it('dispositivo: escrita lançando string → evento próprio de erro, `kind` intacto', async () => {
    const b = bancada();
    const repo = b.deps.deviceTypeRepository.replaceForPatient as unknown as jest.Mock;
    // A 1ª chamada é a da cobertura (mesmo dublê); a 2ª é a do dispositivo.
    repo.mockResolvedValueOnce({ outcome: 'written', received: 0, accepted: [], rejected: [], quarantined: 0 })
        .mockRejectedValueOnce(NAO_ERRO);

    const r = await new SyncPatientFromClickUpTaskUseCase(b.deps).execute(tarefa(), {}, 'cid-b4');

    expect(r.kind).toBe('UPDATED');
    expect(eventos(b.erros)).toContain('clickup_patient_sync.device_type_error');
  });

  it('dispositivo: escrita lançando um Error DE VERDADE → NUNCA a mensagem original, só errorName+code', async () => {
    const b = bancada();
    const repo = b.deps.deviceTypeRepository.replaceForPatient as unknown as jest.Mock;
    // A 1ª chamada é a da cobertura (mesmo dublê); a 2ª é a do dispositivo.
    repo.mockResolvedValueOnce({ outcome: 'written', received: 0, accepted: [], rejected: [], quarantined: 0 })
        .mockRejectedValueOnce(new Error('pool esgotado i2c-dispositivo'));

    const r = await new SyncPatientFromClickUpTaskUseCase(b.deps).execute(tarefa(), {}, 'cid-b4b');

    expect(r.kind).toBe('UPDATED');
    const evento = b.erros.find(a => a[0] === 'clickup_patient_sync.device_type_error');
    expect(evento![1]).toMatchObject({ errorName: 'Error', code: null, stage: 'write' });
    expect(evento![1]).not.toHaveProperty('message');
    expect(evento![1]).not.toHaveProperty('stack');
    expect(JSON.stringify(evento)).not.toContain('pool esgotado i2c-dispositivo');
  });

  it('diagnóstico: `readPatologia` lançando string → stage=read, `syncFromLabel` não é chamado', async () => {
    const syncFromLabel = jest.fn();
    const b = bancada({ diagnosisMapper: { syncFromLabel } as unknown as SyncPatientDeps['diagnosisMapper'] });
    jest.spyOn(b.deps.mapper, 'readPatologia').mockImplementation(() => { throw NAO_ERRO; });

    const r = await new SyncPatientFromClickUpTaskUseCase(b.deps).execute(tarefa(), {}, 'cid-b5');

    expect(r.kind).toBe('UPDATED');
    expect(syncFromLabel).not.toHaveBeenCalled();
    expect(eventos(b.erros)).toContain('clickup_patient_sync.diagnosis_error');
  });

  it('diagnóstico: `syncFromLabel` lançando string → stage=write, `kind` intacto', async () => {
    const syncFromLabel = jest.fn().mockRejectedValue(NAO_ERRO);
    const b = bancada({ diagnosisMapper: { syncFromLabel } as unknown as SyncPatientDeps['diagnosisMapper'] });

    const r = await new SyncPatientFromClickUpTaskUseCase(b.deps).execute(tarefa(), {}, 'cid-b6');

    expect(r.kind).toBe('UPDATED');
    expect(eventos(b.erros)).toContain('clickup_patient_sync.diagnosis_error');
  });

  it('cru: `readSourceLabels` lançando string → stage=read, nenhum campo é gravado', async () => {
    const b = bancada();
    jest.spyOn(b.deps.mapper, 'readSourceLabels').mockImplementation(() => { throw NAO_ERRO; });

    const r = await new SyncPatientFromClickUpTaskUseCase(b.deps).execute(tarefa(), {}, 'cid-b7');

    expect(r.kind).toBe('UPDATED');
    expect(eventos(b.erros)).toContain('clickup_patient_sync.source_labels_error');
    expect(b.deps.sourceLabelRepository.replaceForField).not.toHaveBeenCalled();
  });

  it('cru: escrita de UM campo lançando string não impede os outros (falha contada, não fatal)', async () => {
    const b = bancada();
    (b.deps.sourceLabelRepository.replaceForField as unknown as jest.Mock)
      .mockRejectedValueOnce(NAO_ERRO);

    const r = await new SyncPatientFromClickUpTaskUseCase(b.deps).execute(tarefa(), {}, 'cid-b8');

    expect(r.kind).toBe('UPDATED');
    expect(eventos(b.erros)).toContain('clickup_patient_sync.source_labels_error');
    // Os demais campos continuaram sendo gravados — o laço não abortou no 1º erro.
    expect((b.deps.sourceLabelRepository.replaceForField as unknown as jest.Mock).mock.calls.length)
      .toBeGreaterThan(1);
  });

  it('CONTAGEM ZERO É FALHA (F19): `readSourceLabels` devolvendo lista vazia é ERRO, não sucesso', async () => {
    const b = bancada();
    jest.spyOn(b.deps.mapper, 'readSourceLabels').mockReturnValue([]);

    const r = await new SyncPatientFromClickUpTaskUseCase(b.deps).execute(tarefa(), {}, 'cid-b9');

    expect(r.kind).toBe('UPDATED');
    const evento = b.erros.find(a => a[0] === 'clickup_patient_sync.source_labels_error');
    expect(evento![1]).toMatchObject({ error: 'readSourceLabels devolveu ZERO campos' });
    expect(b.deps.sourceLabelRepository.replaceForField).not.toHaveBeenCalled();
  });
});

describe('espelho dos chat ids — as bordas do passo opcional', () => {
  const COM_GRUPO = { 'Chat ID Familia': '120363000000000001@g.us' };

  beforeEach(() => { process.env.PATIENT_CHAT_IDS_CLICKUP_SYNC_ENABLED = 'true'; });
  afterEach(() => { delete process.env.PATIENT_CHAT_IDS_CLICKUP_SYNC_ENABLED; });

  it('falha de infraestrutura lançada como string é REPORTADA e o sync segue', async () => {
    const chatIdsService = { syncFromClickUp: jest.fn().mockRejectedValue(NAO_ERRO) };
    const b = bancada({ chatIdsService: chatIdsService as unknown as SyncPatientDeps['chatIdsService'] });

    const r = await new SyncPatientFromClickUpTaskUseCase(b.deps).execute(tarefa(COM_GRUPO), {}, 'cid-b10');

    expect(r.kind).toBe('UPDATED');
    expect(chatIdsService.syncFromClickUp).toHaveBeenCalledTimes(1);
  });

  it('sem `chatIdsService` injetado, o serviço REAL é construído sob demanda — e memoizado', async () => {
    // O construtor real não pode abrir conexão (é por isso que ele é preguiçoso); o que este
    // teste fixa é o `??=`: uma instância por use case, criada só quando o passo roda.
    const b = bancada();
    const useCase = new SyncPatientFromClickUpTaskUseCase(b.deps);
    const acesso = () => (useCase as unknown as { chatIdsService(): unknown }).chatIdsService();

    const primeira = acesso();
    expect(primeira).toBeDefined();
    expect(acesso()).toBe(primeira);   // memoizado: o `??=` não reconstrói
  });
});
