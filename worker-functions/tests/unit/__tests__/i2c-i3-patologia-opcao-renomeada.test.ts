/**
 * I3 — no diagnóstico, "opção renomeada" NÃO pode virar "sem diagnóstico".
 *
 * ── O DEFEITO ───────────────────────────────────────────────────────────────
 * `ClickUpPatientMapper.resolvePatologiaLabel` chamava `resolver.resolveDropdown` CRU,
 * contornando o `resolveCatalogValue` — o helper de TRÊS estados criado neste mesmo PR para
 * separar "vazio de verdade" de "não consegui ler". `ClickUpDiagnosisMapper.syncFromLabel`
 * mapeia esse `null` ÚNICO para `{kind:'no_label'}`, documentado como "ausência legítima".
 *
 * Resultado: opção renomeada/recriada no ClickUp (o orderindex deixa de resolver) → todo
 * re-sync loga "sem rótulo", NADA é gravado, e nada distingue isso de um campo que a operação
 * simplesmente não preencheu. A regra "o que não mapear fica em LISTA" não é honrada para a
 * classe inteira dos orderindex não resolvidos.
 *
 * Duas linhas abaixo, no mesmo arquivo, `Segmentos Clínicos` e `Cobertura Verificada` já usam
 * o helper certo. Este teste exige o mesmo do 11º campo.
 *
 * Molde da bancada: `clickup-f4-diagnosis-sync.test.ts` (mesmos dublês, sem banco).
 */
import { ClickUpPatientMapper } from '../../../src/modules/integration/infrastructure/clickup/ClickUpPatientMapper';
import { SyncPatientFromClickUpTaskUseCase } from '../../../src/modules/integration/application/SyncPatientFromClickUpTaskUseCase';
import type { SyncPatientDeps } from '../../../src/modules/integration/application/SyncPatientFromClickUpTaskUseCase';
import type { ClickUpFieldResolver } from '../../../src/modules/integration/infrastructure/clickup/ClickUpFieldResolver';
import type { ClickUpTask } from '../../../src/modules/integration/infrastructure/clickup/ClickUpTask';
import type { PatientService } from '../../../src/modules/case/application/PatientService';

const PATOLOGIA = 'Tipo de Patología';
const ROTULO_VIVO = 'Trastorno del Espectro Autista';

/**
 * `catalogoTemAOpcao=false` = o CAMPO continua `drop_down` no catálogo (o preflight da 1.11
 * passa), mas a OPÇÃO que a tarefa referencia não resolve mais. É a "opção renomeada".
 */
function resolverFalso(catalogoTemAOpcao: boolean): ClickUpFieldResolver {
  return {
    getFieldType: () => 'drop_down',
    resolveDropdown: (f: string, v: number | string | null | undefined) => {
      if (v === null || v === undefined || v === '') return null;
      if (f !== PATOLOGIA || !catalogoTemAOpcao) return null;
      return [ROTULO_VIVO][Number(v)] ?? null;
    },
    resolveLabels: () => [],
    resolveLabel: () => null,
  } as unknown as ClickUpFieldResolver;
}

function tarefa(campos: Record<string, unknown>): ClickUpTask {
  return {
    id: 'task-i2c-i3',
    name: 'FIXTURE I2C, Paciente',
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

function bancada(catalogoTemAOpcao: boolean, syncFromLabel: jest.Mock, recordUnreadableLabel?: jest.Mock) {
  const mapper = new ClickUpPatientMapper(resolverFalso(catalogoTemAOpcao));
  const patientService = {
    upsertFromClickUp: jest.fn(async () => ({ id: 'patient-i2c-i3', created: false, flagged: false })),
  } as unknown as PatientService;

  const erros: unknown[][] = [];
  jest.spyOn(require('firebase-functions').logger, 'error').mockImplementation((...a: unknown[]) => { erros.push(a); });
  jest.spyOn(require('firebase-functions').logger, 'info').mockImplementation(() => {});
  jest.spyOn(require('firebase-functions').logger, 'warn').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});

  const repo = noopRepo();
  const deps: SyncPatientDeps = {
    mapper,
    patientService,
    sourceLabelRepository: repo as unknown as SyncPatientDeps['sourceLabelRepository'],
    insuranceRepository:   repo as unknown as SyncPatientDeps['insuranceRepository'],
    deviceTypeRepository:  repo as unknown as SyncPatientDeps['deviceTypeRepository'],
    diagnosisMapper: {
      syncFromLabel,
      // I3b: o registro DURÁVEL do ilegível (migration 329). Sem ele, "parar e gritar" deixava
      // a LISTA vazia para a classe inteira dos orderindex que não resolvem.
      recordUnreadableLabel: recordUnreadableLabel ?? jest.fn().mockResolvedValue({ kind: 'unreadable' }),
    } as unknown as SyncPatientDeps['diagnosisMapper'],
  };
  return { deps, erros, mapper, recordUnreadableLabel: (deps.diagnosisMapper as unknown as { recordUnreadableLabel: jest.Mock }).recordUnreadableLabel };
}

const NOME = { 'Nombre de Paciente': 'JaneI2C', 'Apellido del Paciente': 'DoeI2C' };

afterEach(() => jest.restoreAllMocks());

describe('I3 — orderindex que NÃO resolve não vira "ausência legítima" no diagnóstico', () => {
  it('opção RENOMEADA: `syncFromLabel` NÃO é chamado e a falha vai para o log de ERRO', async () => {
    const syncFromLabel = jest.fn().mockResolvedValue({ kind: 'no_label' });
    const b = bancada(false, syncFromLabel);

    const r = await new SyncPatientFromClickUpTaskUseCase(b.deps).execute(
      tarefa({ ...NOME, [PATOLOGIA]: 0 }), {}, 'i2c-i3-1',
    );

    // O `kind` do sync não muda: o passo é best-effort, como os irmãos.
    expect(r.kind).toBe('UPDATED');
    // ── O CORAÇÃO DO DEFEITO ──────────────────────────────────────────────
    // Antes: `syncFromLabel(patientId, null)` → `{kind:'no_label'}` → "ausência legítima".
    expect(syncFromLabel).not.toHaveBeenCalled();

    // E a falha é NOMEADA, com o motivo ESTRUTURAL — nunca o orderindex (C1/lex).
    const evento = b.erros.find(a => String(a[0]).includes('diagnosis'));
    expect(evento).toBeDefined();
    expect(evento![1]).toMatchObject({ reason: 'options_unresolved' });
    expect(JSON.stringify(evento)).not.toContain('orderindex');

    // ── I3b: gritar não é FICAR EM LISTA. A ocorrência vai para o registro durável… ────────
    expect(b.recordUnreadableLabel).toHaveBeenCalledWith('patient-i2c-i3');
    // …e SEM o valor: a assinatura tem um argumento só, e ele é o paciente.
    expect(b.recordUnreadableLabel.mock.calls[0]).toHaveLength(1);
  });

  it('I3b: falha ao REGISTRAR o ilegível não derruba o sync, e não passa muda (F43)', async () => {
    const syncFromLabel = jest.fn().mockResolvedValue({ kind: 'no_label' });
    const registro = jest.fn().mockRejectedValue(new Error('deadlock detected'));
    const b = bancada(false, syncFromLabel, registro);

    const r = await new SyncPatientFromClickUpTaskUseCase(b.deps).execute(
      tarefa({ ...NOME, [PATOLOGIA]: 0 }), {}, 'i2c-i3-5',
    );

    expect(r.kind).toBe('UPDATED');
    const falha = b.erros.find(a => String(a[0]).includes('diagnosis_error'));
    expect(falha).toBeDefined();
    expect(falha![1]).toMatchObject({ stage: 'reject', error: 'deadlock detected' });
  });

  it('I3b: rejeição NÃO-Error ao registrar vira mensagem legível, sem valor de paciente', async () => {
    const syncFromLabel = jest.fn().mockResolvedValue({ kind: 'no_label' });
    const registro = jest.fn().mockRejectedValue('ECONNRESET');
    const b = bancada(false, syncFromLabel, registro);

    await new SyncPatientFromClickUpTaskUseCase(b.deps).execute(
      tarefa({ ...NOME, [PATOLOGIA]: 0 }), {}, 'i2c-i3-6',
    );

    const falha = b.erros.find(a => String(a[0]).includes('diagnosis_error'));
    expect(falha![1]).toMatchObject({ stage: 'reject', error: 'ECONNRESET' });
  });

  it('CONTROLE POSITIVO — campo VAZIO continua sendo ausência legítima: syncFromLabel(id, null)', async () => {
    const syncFromLabel = jest.fn().mockResolvedValue({ kind: 'no_label' });
    const b = bancada(true, syncFromLabel);

    await new SyncPatientFromClickUpTaskUseCase(b.deps).execute(
      tarefa({ ...NOME, [PATOLOGIA]: null }), {}, 'i2c-i3-2',
    );

    expect(syncFromLabel).toHaveBeenCalledWith('patient-i2c-i3', null);
    expect(b.erros.filter(a => String(a[0]).includes('diagnosis'))).toHaveLength(0);
    // CONTROLE NEGATIVO do I3b: ausência legítima NÃO gera linha de rejeição.
    expect(b.recordUnreadableLabel).not.toHaveBeenCalled();
  });

  it('CONTROLE POSITIVO — opção que RESOLVE continua sincronizando o rótulo (a régua mede)', async () => {
    const syncFromLabel = jest.fn().mockResolvedValue({ kind: 'synced', outcome: 'created' });
    const b = bancada(true, syncFromLabel);

    await new SyncPatientFromClickUpTaskUseCase(b.deps).execute(
      tarefa({ ...NOME, [PATOLOGIA]: 0 }), {}, 'i2c-i3-3',
    );

    expect(syncFromLabel).toHaveBeenCalledWith('patient-i2c-i3', ROTULO_VIVO);
    expect(b.erros.filter(a => String(a[0]).includes('diagnosis'))).toHaveLength(0);
    expect(b.recordUnreadableLabel).not.toHaveBeenCalled();
  });

  it('valor que nem FORMA de índice tem (array) também é ilegível, não ausência', async () => {
    const syncFromLabel = jest.fn().mockResolvedValue({ kind: 'no_label' });
    const b = bancada(true, syncFromLabel);

    await new SyncPatientFromClickUpTaskUseCase(b.deps).execute(
      tarefa({ ...NOME, [PATOLOGIA]: ['uuid-de-labels'] }), {}, 'i2c-i3-4',
    );

    expect(syncFromLabel).not.toHaveBeenCalled();
    const evento = b.erros.find(a => String(a[0]).includes('diagnosis'));
    expect(evento![1]).toMatchObject({ reason: 'value_not_indexable' });
    // Também é ILEGÍVEL: fica em LISTA pelo mesmo caminho (o motivo fino vai só para o log).
    expect(b.recordUnreadableLabel).toHaveBeenCalledWith('patient-i2c-i3');
  });
});
