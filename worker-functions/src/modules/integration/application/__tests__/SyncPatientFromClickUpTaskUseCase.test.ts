/**
 * SyncPatientFromClickUpTaskUseCase — Unit Tests
 *
 * Covers all result branches:
 *  1. SKIPPED_SUBTASK — task with parent set
 *  2. ERROR (mapper throws) — mapper throws during map()
 *  3. SKIPPED_NO_PATIENT_NAME — mapper returns null, no name fields present
 *  4. SKIPPED_MAPPER_NULL — mapper returns null but name fields exist
 *  5. CREATED — upsert returns created=true, flagged=false
 *  6. UPDATED — upsert returns created=false, flagged=false
 *  7. CREATED flagged — upsert returns created=true, flagged=true
 *  8. ERROR (upsert throws) — patientService.upsertFromClickUp throws
 *  9. CASE_NUMBER_CONFLICT — upsert returns conflict='CASE_NUMBER_CONFLICT'
 * 10. correlationId forwarded when provided
 * 11. correlationId auto-generated when not provided
 */

// ── Mocks (before imports) ────────────────────────────────────────────────────

const mockLoggerInfo  = jest.fn();
const mockLoggerWarn  = jest.fn();
const mockLoggerError = jest.fn();

jest.mock('firebase-functions', () => ({
  logger: {
    info:  (...args: unknown[]) => mockLoggerInfo(...args),
    warn:  (...args: unknown[]) => mockLoggerWarn(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
  },
}));

const mockReportError = jest.fn();
jest.mock('@shared/logging', () => ({
  ...jest.requireActual('@shared/logging'),
  reportError: (...args: unknown[]) => mockReportError(...args),
}));

// ── Imports ───────────────────────────────────────────────────────────────────

import {
  SyncPatientFromClickUpTaskUseCase,
  classifyMapperNullReason,
  formatPatientName,
  type SyncPatientDeps,
} from '../SyncPatientFromClickUpTaskUseCase';
import type { ClickUpTask, ClickUpTaskCustomField } from '../../infrastructure/clickup/ClickUpTask';
import type { ClickUpPatientMapper } from '../../infrastructure/clickup/ClickUpPatientMapper';
import type { PatientService, PatientServiceUpsertInput } from '../../../case/application/PatientService';

// ── Task builders ─────────────────────────────────────────────────────────────

function makeCf(name: string, value: unknown): ClickUpTaskCustomField {
  return { id: `cf-${name}`, name, type: 'text', value };
}

function makeTask(overrides: Partial<ClickUpTask> = {}): ClickUpTask {
  return {
    id:           overrides.id           ?? 'task-001',
    name:         overrides.name         ?? 'García, Ana',
    status:       overrides.status       ?? { status: 'activo', color: '#0f0', type: 'custom' },
    parent:       overrides.parent       ?? null,
    custom_fields: overrides.custom_fields ?? [
      makeCf('Nombre de Paciente',    'Ana'),
      makeCf('Apellido del Paciente', 'García'),
    ],
    url:          overrides.url          ?? 'https://app.clickup.com/t/task-001',
    date_created: overrides.date_created ?? '1700000000000',
    date_updated: overrides.date_updated ?? '1700100000000',
  };
}

// ── Dep factory ───────────────────────────────────────────────────────────────

function makeDeps(overrides: Partial<{
  mapResult: PatientServiceUpsertInput | null | Error;
  upsertResult: { id: string; created: boolean; flagged: boolean; conflict?: 'CASE_NUMBER_CONFLICT' } | Error;
  sourceReads: unknown[];
  replaceForField: jest.Mock;
}>): SyncPatientDeps {
  const mapper = {
    map: jest.fn(() => {
      const r = overrides.mapResult;
      if (r instanceof Error) throw r;
      return r ?? null;
    }),
    // Task 2.3: o use case lê o cru depois do upsert. Vazio por padrão aqui — os testes desta
    // suíte são sobre o DESPACHO (kind, log, conflito), não sobre a persistência do cru, que
    // tem suíte própria. O que importa é que a lista exista: `[]` é tratado como FALHA pelo
    // use case (F19), e um teste desta suíte prova isso.
    readSourceLabels: jest.fn(() => overrides.sourceReads ?? [
      { fieldName: 'Segmentos Clínicos', read: { readable: true, labels: [] } },
    ]),
  } as unknown as ClickUpPatientMapper;

  const minimalInput: PatientServiceUpsertInput = {
    clickupTaskId: 'task-001',
    firstName:     'Ana',
    lastName:      'García',
  } as unknown as PatientServiceUpsertInput;

  const patientService = {
    upsertFromClickUp: jest.fn(async () => {
      const r = overrides.upsertResult;
      if (r instanceof Error) throw r;
      return r ?? { id: 'patient-001', created: true, flagged: false };
    }),
  } as unknown as PatientService;

  // When mapResult is not an error, override map to return the actual input
  if (!(overrides.mapResult instanceof Error) && overrides.mapResult !== null && overrides.mapResult !== undefined) {
    (mapper.map as jest.Mock).mockReturnValue(overrides.mapResult);
  }

  // Task 2.3 — dublê do repositório do cru. Nenhum teste desta suíte toca banco.
  const sourceLabelRepository = {
    replaceForField: overrides.replaceForField ?? jest.fn(async () => ({
      fieldName: 'Segmentos Clínicos', outcome: 'written' as const,
      received: 0, empty: 0, accepted: [], rejected: [], newlyRejected: 0,
      rejectionsDurable: 'not-applicable' as const,
    })),
  } as unknown as SyncPatientDeps['sourceLabelRepository'];

  // Task 3.3 — dublê da cobertura múltipla. Nenhum teste desta suíte toca banco.
  const insuranceRepository = {
    replaceForPatient: jest.fn(async () => ({
      outcome: 'written' as const, received: 0, accepted: [], rejected: [],
    })),
  } as unknown as SyncPatientDeps['insuranceRepository'];

  // Task 4.2 — dublê do tipo de dispositivo múltiplo. Nenhum teste desta suíte toca banco.
  const deviceTypeRepository = {
    replaceForPatient: jest.fn(async () => ({
      outcome: 'written' as const, received: 0, accepted: [], rejected: [], quarantined: 0,
    })),
  } as unknown as SyncPatientDeps['deviceTypeRepository'];

  return { mapper, patientService, sourceLabelRepository, insuranceRepository, deviceTypeRepository };
}

function makeUpsertInput(firstName = 'Ana', lastName = 'García'): PatientServiceUpsertInput {
  return {
    clickupTaskId: 'task-001',
    firstName,
    lastName,
  } as unknown as PatientServiceUpsertInput;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('SyncPatientFromClickUpTaskUseCase', () => {
  let useCase: SyncPatientFromClickUpTaskUseCase;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── 1. SKIPPED_SUBTASK ──────────────────────────────────────────────────────

  it('1. returns SKIPPED_SUBTASK when task.parent is not null', async () => {
    const deps = makeDeps({ mapResult: makeUpsertInput() });
    useCase = new SyncPatientFromClickUpTaskUseCase(deps);

    const task = makeTask({ parent: 'parent-task-id' });
    const result = await useCase.execute(task);

    expect(result.kind).toBe('SKIPPED_SUBTASK');
    if (result.kind === 'SKIPPED_SUBTASK') {
      expect(result.taskId).toBe('task-001');
    }
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'clickup_patient_sync.skipped',
      expect.objectContaining({ kind: 'SKIPPED_SUBTASK', taskId: 'task-001' }),
    );
    // mapper should never be called for subtasks
    expect((deps.mapper.map as jest.Mock)).not.toHaveBeenCalled();
  });

  // ── 2. ERROR (mapper throws) ────────────────────────────────────────────────

  it('2. returns ERROR when mapper.map() throws', async () => {
    const mapError = new Error('field resolver exploded');
    const deps = makeDeps({ mapResult: mapError });
    useCase = new SyncPatientFromClickUpTaskUseCase(deps);

    const result = await useCase.execute(makeTask());

    expect(result.kind).toBe('ERROR');
    if (result.kind === 'ERROR') {
      expect(result.error.message).toBe('field resolver exploded');
      expect(result.taskId).toBe('task-001');
    }
    expect(mockLoggerError).toHaveBeenCalledWith(
      'clickup_patient_sync.error',
      expect.objectContaining({ taskId: 'task-001', error: 'field resolver exploded' }),
    );
  });

  // ── 3. SKIPPED_NO_PATIENT_NAME ──────────────────────────────────────────────

  it('3. returns SKIPPED_NO_PATIENT_NAME when mapper returns null and no name fields', async () => {
    const deps = makeDeps({ mapResult: null });
    useCase = new SyncPatientFromClickUpTaskUseCase(deps);

    // Task with no Nombre or Apellido custom fields
    const task = makeTask({
      custom_fields: [makeCf('Diagnóstico (si lo conoce)', 'TEA')],
    });
    const result = await useCase.execute(task);

    expect(result.kind).toBe('SKIPPED_NO_PATIENT_NAME');
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'clickup_patient_sync.skipped',
      expect.objectContaining({ kind: 'SKIPPED_NO_PATIENT_NAME' }),
    );
  });

  // ── 4. SKIPPED_MAPPER_NULL ──────────────────────────────────────────────────

  it('4. returns SKIPPED_MAPPER_NULL when mapper returns null but name fields are present', async () => {
    const deps = makeDeps({ mapResult: null });
    useCase = new SyncPatientFromClickUpTaskUseCase(deps);

    // Task HAS name fields (mapper chose to return null for another reason)
    const task = makeTask({
      custom_fields: [
        makeCf('Nombre de Paciente',    'Ana'),
        makeCf('Apellido del Paciente', 'García'),
      ],
    });
    const result = await useCase.execute(task);

    expect(result.kind).toBe('SKIPPED_MAPPER_NULL');
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'clickup_patient_sync.skipped',
      expect.objectContaining({ kind: 'SKIPPED_MAPPER_NULL' }),
    );
  });

  // ── 5. CREATED ─────────────────────────────────────────────────────────────

  it('5. returns CREATED when upsert returns created=true', async () => {
    const input = makeUpsertInput('Ana', 'García');
    const deps = makeDeps({
      mapResult:    input,
      upsertResult: { id: 'patient-xyz', created: true, flagged: false },
    });
    useCase = new SyncPatientFromClickUpTaskUseCase(deps);

    const result = await useCase.execute(makeTask(), {}, 'corr-001');

    expect(result.kind).toBe('CREATED');
    if (result.kind === 'CREATED') {
      expect(result.patientId).toBe('patient-xyz');
      expect(result.flagged).toBe(false);
      expect(result.taskId).toBe('task-001');
      expect(result.patientName).toBe('García, Ana');
    }
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      'clickup_patient_sync.completed',
      expect.objectContaining({ kind: 'CREATED', patientId: 'patient-xyz', correlationId: 'corr-001' }),
    );
  });

  // ── 6. UPDATED ─────────────────────────────────────────────────────────────

  it('6. returns UPDATED when upsert returns created=false', async () => {
    const input = makeUpsertInput('Pedro', 'López');
    const deps = makeDeps({
      mapResult:    input,
      upsertResult: { id: 'patient-aaa', created: false, flagged: false },
    });
    useCase = new SyncPatientFromClickUpTaskUseCase(deps);

    const task = makeTask({ id: 'task-002', custom_fields: [
      makeCf('Nombre de Paciente',    'Pedro'),
      makeCf('Apellido del Paciente', 'López'),
    ]});
    const result = await useCase.execute(task);

    expect(result.kind).toBe('UPDATED');
    if (result.kind === 'UPDATED') {
      expect(result.patientId).toBe('patient-aaa');
      expect(result.patientName).toBe('López, Pedro');
    }
  });

  // ── 7. CREATED flagged ────────────────────────────────────────────────────

  it('7. propagates flagged=true when upsert flags the record', async () => {
    const input = makeUpsertInput('Elvira', 'Peralta');
    const deps = makeDeps({
      mapResult:    input,
      upsertResult: { id: 'patient-bbb', created: true, flagged: true },
    });
    useCase = new SyncPatientFromClickUpTaskUseCase(deps);

    const result = await useCase.execute(makeTask());

    expect(result.kind).toBe('CREATED');
    if (result.kind === 'CREATED') {
      expect(result.flagged).toBe(true);
    }
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      'clickup_patient_sync.completed',
      expect.objectContaining({ flagged: true }),
    );
  });

  // ── 8. ERROR (upsert throws) ────────────────────────────────────────────────

  it('8. returns ERROR when patientService.upsertFromClickUp throws', async () => {
    const input = makeUpsertInput();
    const upsertError = new Error('DB constraint violation');
    const deps = makeDeps({
      mapResult:    input,
      upsertResult: upsertError,
    });
    useCase = new SyncPatientFromClickUpTaskUseCase(deps);

    const result = await useCase.execute(makeTask());

    expect(result.kind).toBe('ERROR');
    if (result.kind === 'ERROR') {
      expect(result.error.message).toBe('DB constraint violation');
    }
    expect(mockLoggerError).toHaveBeenCalledWith(
      'clickup_patient_sync.error',
      expect.objectContaining({ error: 'DB constraint violation' }),
    );
  });

  // ── 9. CASE_NUMBER_CONFLICT ───────────────────────────────────────────────

  it('9. returns CASE_NUMBER_CONFLICT when upsertFromClickUp returns conflict field', async () => {
    const input: PatientServiceUpsertInput = {
      ...makeUpsertInput('Valentín', 'Ojeda Noha'),
      caseNumber: 695,
    } as unknown as PatientServiceUpsertInput;

    const deps = makeDeps({
      mapResult:    input,
      upsertResult: { id: 'patient-conflict-01', created: false, flagged: true, conflict: 'CASE_NUMBER_CONFLICT' },
    });
    useCase = new SyncPatientFromClickUpTaskUseCase(deps);

    const result = await useCase.execute(makeTask(), {}, 'corr-conflict-01');

    expect(result.kind).toBe('CASE_NUMBER_CONFLICT');
    if (result.kind === 'CASE_NUMBER_CONFLICT') {
      expect(result.patientId).toBe('patient-conflict-01');
      expect(result.taskId).toBe('task-001');
      expect(result.caseNumber).toBe(695);
      expect(result.patientName).toBe('Ojeda Noha, Valentín');
    }
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'clickup_patient_sync.case_number_conflict',
      expect.objectContaining({
        taskId:        'task-001',
        caseNumber:    695,
        patientId:     'patient-conflict-01',
        correlationId: 'corr-conflict-01',
      }),
    );
    // Must NOT log the normal completed event
    expect(mockLoggerInfo).not.toHaveBeenCalledWith(
      'clickup_patient_sync.completed',
      expect.anything(),
    );
  });

  // ── 10. correlationId forwarded ───────────────────────────────────────────

  it('10. forwards provided correlationId to all logger calls', async () => {
    const input = makeUpsertInput();
    const deps = makeDeps({
      mapResult:    input,
      upsertResult: { id: 'p-001', created: true, flagged: false },
    });
    useCase = new SyncPatientFromClickUpTaskUseCase(deps);

    await useCase.execute(makeTask(), {}, 'webhook-req-abc123');

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      'clickup_patient_sync.start',
      expect.objectContaining({ correlationId: 'webhook-req-abc123' }),
    );
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      'clickup_patient_sync.completed',
      expect.objectContaining({ correlationId: 'webhook-req-abc123' }),
    );
  });

  // ── 11. correlationId auto-generated ─────────────────────────────────────

  it('11. auto-generates correlationId when not provided', async () => {
    const input = makeUpsertInput();
    const deps = makeDeps({
      mapResult:    input,
      upsertResult: { id: 'p-002', created: false, flagged: false },
    });
    useCase = new SyncPatientFromClickUpTaskUseCase(deps);

    await useCase.execute(makeTask());

    const startCall = mockLoggerInfo.mock.calls.find(
      (c: unknown[]) => c[0] === 'clickup_patient_sync.start',
    );
    expect(startCall).toBeDefined();
    const payload = startCall![1] as Record<string, unknown>;
    expect(typeof payload['correlationId']).toBe('string');
    expect((payload['correlationId'] as string).length).toBeGreaterThan(0);
  });
});

// ── Helper unit tests ─────────────────────────────────────────────────────────

describe('classifyMapperNullReason', () => {
  it('returns SKIPPED_NO_PATIENT_NAME when no name fields exist', () => {
    const task = makeTask({ custom_fields: [makeCf('Diagnóstico (si lo conoce)', 'TEA')] });
    expect(classifyMapperNullReason(task)).toBe('SKIPPED_NO_PATIENT_NAME');
  });

  it('returns SKIPPED_NO_PATIENT_NAME when name fields exist but values are falsy', () => {
    const task = makeTask({
      custom_fields: [
        makeCf('Nombre de Paciente',    null),
        makeCf('Apellido del Paciente', ''),
      ],
    });
    expect(classifyMapperNullReason(task)).toBe('SKIPPED_NO_PATIENT_NAME');
  });

  it('returns SKIPPED_MAPPER_NULL when Nombre de Paciente has a value', () => {
    const task = makeTask({
      custom_fields: [makeCf('Nombre de Paciente', 'Ana')],
    });
    expect(classifyMapperNullReason(task)).toBe('SKIPPED_MAPPER_NULL');
  });

  it('returns SKIPPED_MAPPER_NULL when Apellido del Paciente has a value', () => {
    const task = makeTask({
      custom_fields: [makeCf('Apellido del Paciente', 'García')],
    });
    expect(classifyMapperNullReason(task)).toBe('SKIPPED_MAPPER_NULL');
  });
});

describe('formatPatientName', () => {
  it('formats "Apellido, Nombre" correctly', () => {
    expect(formatPatientName('Ana', 'García')).toBe('García, Ana');
  });

  it('handles missing firstName', () => {
    expect(formatPatientName(null, 'García')).toBe('García');
  });

  it('handles missing lastName', () => {
    expect(formatPatientName('Ana', null)).toBe('Ana');
  });

  it('handles both missing', () => {
    expect(formatPatientName(null, null)).toBe('');
  });

  it('handles empty strings', () => {
    expect(formatPatientName('', '')).toBe('');
  });
});

// ── Chat IDs (ClickUp → patient_chat_ids, task 86ak04ygu) ─────────────────────

describe('SyncPatientFromClickUpTaskUseCase — espelho dos chat IDs', () => {
  const FAM_JID = '120363428306019892@g.us';
  const EQ_JID  = '120363408030915489@g.us';

  function chatIdsServiceMock(result?: {
    applied: string[]; unchanged: string[]; skipped: { role: string; chatId: string; reason: string }[];
  }) {
    return {
      syncFromClickUp: jest.fn().mockResolvedValue(
        result ?? { applied: ['FAMILY'], unchanged: [], skipped: [] },
      ),
    };
  }

  function taskWithChatIds(extra: ClickUpTaskCustomField[] = []): ClickUpTask {
    return makeTask({
      custom_fields: [
        makeCf('Nombre de Paciente',    'Ana'),
        makeCf('Apellido del Paciente', 'García'),
        makeCf('Chat ID Familia',       FAM_JID),
        makeCf('Chat ID Equipo',        EQ_JID),
        ...extra,
      ],
    });
  }

  const FLAG = 'PATIENT_CHAT_IDS_CLICKUP_SYNC_ENABLED';
  let flagBefore: string | undefined;

  beforeEach(() => {
    flagBefore = process.env[FLAG];
    process.env[FLAG] = 'true';
  });

  afterEach(() => {
    if (flagBefore === undefined) delete process.env[FLAG];
    else process.env[FLAG] = flagBefore;
  });

  it('com a flag ligada, espelha os grupos DEPOIS do upsert, no paciente certo', async () => {
    const chatIds = chatIdsServiceMock();
    const deps = makeDeps({ mapResult: makeUpsertInput(), upsertResult: { id: 'patient-001', created: false, flagged: false } });
    const useCase = new SyncPatientFromClickUpTaskUseCase({ ...deps, chatIdsService: chatIds as never });

    const result = await useCase.execute(taskWithChatIds());

    expect(result.kind).toBe('UPDATED');
    expect(chatIds.syncFromClickUp).toHaveBeenCalledWith('patient-001', {
      FAMILY:    FAM_JID,
      PROVIDERS: EQ_JID,
    });
  });

  it('flag desligada: nem toca no serviço de chat ids', async () => {
    process.env[FLAG] = 'false';
    const chatIds = chatIdsServiceMock();
    const deps = makeDeps({ mapResult: makeUpsertInput() });
    const useCase = new SyncPatientFromClickUpTaskUseCase({ ...deps, chatIdsService: chatIds as never });

    const result = await useCase.execute(taskWithChatIds());

    expect(result.kind).toBe('CREATED');
    expect(chatIds.syncFromClickUp).not.toHaveBeenCalled();
  });

  it('task sem campo de chat id: não chama o serviço (nada a espelhar)', async () => {
    const chatIds = chatIdsServiceMock();
    const deps = makeDeps({ mapResult: makeUpsertInput() });
    const useCase = new SyncPatientFromClickUpTaskUseCase({ ...deps, chatIdsService: chatIds as never });

    await useCase.execute(makeTask());

    expect(chatIds.syncFromClickUp).not.toHaveBeenCalled();
  });

  it('valor inválido no ClickUp vira warn e NÃO chega ao serviço; o válido segue', async () => {
    const chatIds = chatIdsServiceMock();
    const deps = makeDeps({ mapResult: makeUpsertInput() });
    const useCase = new SyncPatientFromClickUpTaskUseCase({ ...deps, chatIdsService: chatIds as never });

    await useCase.execute(makeTask({
      custom_fields: [
        makeCf('Nombre de Paciente',    'Ana'),
        makeCf('Apellido del Paciente', 'García'),
        makeCf('Chat ID Familia',       '5491122334455@c.us'), // 1-1, inválido
        makeCf('Chat ID Equipo',        EQ_JID),
      ],
    }));

    // O VALOR nunca vai pro log: um @c.us é literalmente um telefone (Ley
    // 25.326). Vai a categoria + tamanho, suficientes pra achar o campo torto.
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      'clickup_patient_sync.chat_id_invalid',
      expect.objectContaining({ role: 'FAMILY', kind: 'direct_chat', valueLength: 18 }),
    );
    const warnPayload = mockLoggerWarn.mock.calls.find(
      c => c[0] === 'clickup_patient_sync.chat_id_invalid',
    )?.[1] as Record<string, unknown>;
    expect(warnPayload).not.toHaveProperty('value');
    expect(chatIds.syncFromClickUp).toHaveBeenCalledWith('patient-001', { PROVIDERS: EQ_JID });
  });

  it('conflito reportado pelo serviço vira log estruturado e o sync do paciente NÃO falha', async () => {
    const chatIds = chatIdsServiceMock({
      applied: [],
      unchanged: [],
      skipped: [{ role: 'FAMILY', chatId: FAM_JID, reason: 'ChatIdAlreadyLinkedError' }],
    });
    const deps = makeDeps({ mapResult: makeUpsertInput() });
    const useCase = new SyncPatientFromClickUpTaskUseCase({ ...deps, chatIdsService: chatIds as never });

    const result = await useCase.execute(taskWithChatIds());

    expect(result.kind).toBe('CREATED');
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      'clickup_patient_sync.chat_ids',
      expect.objectContaining({
        skipped: [{ role: 'FAMILY', chatId: FAM_JID, reason: 'ChatIdAlreadyLinkedError' }],
      }),
    );
  });

  it('erro de infraestrutura no passo de chat ids: loga error e o resultado do sync fica de pé', async () => {
    const chatIds = {
      syncFromClickUp: jest.fn().mockRejectedValue(new Error('pool exhausted')),
    };
    const deps = makeDeps({ mapResult: makeUpsertInput() });
    const useCase = new SyncPatientFromClickUpTaskUseCase({ ...deps, chatIdsService: chatIds as never });

    const result = await useCase.execute(taskWithChatIds());

    expect(result.kind).toBe('CREATED');
    expect(mockReportError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'pool exhausted' }),
      expect.objectContaining({ source: 'clickup_patient_sync.chat_ids' }),
    );
  });

  it('CASE_NUMBER_CONFLICT: a ficha existe, então os grupos espelham MESMO ASSIM', async () => {
    const chatIds = chatIdsServiceMock();
    const deps = makeDeps({
      mapResult: makeUpsertInput(),
      upsertResult: { id: 'patient-009', created: false, flagged: true, conflict: 'CASE_NUMBER_CONFLICT' },
    });
    const useCase = new SyncPatientFromClickUpTaskUseCase({ ...deps, chatIdsService: chatIds as never });

    const result = await useCase.execute(taskWithChatIds());

    expect(result.kind).toBe('CASE_NUMBER_CONFLICT');
    expect(chatIds.syncFromClickUp).toHaveBeenCalledWith('patient-009', {
      FAMILY:    FAM_JID,
      PROVIDERS: EQ_JID,
    });
  });
});
