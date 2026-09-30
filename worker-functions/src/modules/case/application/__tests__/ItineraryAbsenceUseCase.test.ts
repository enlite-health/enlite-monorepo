/**
 * ItineraryAbsenceUseCase — DX-13.7/DX-13.6 (P17). `reader`, `writer`, `allocationWriter` e a
 * TRANSAÇÃO (`runInTransaction`) injetados — sem banco real (molde `ItineraryAllocationUseCase.test.ts`).
 * A transação injetada só chama `fn` direto no client dublê, provando que leitor e escritores
 * recebem o MESMO client.
 */
import {
  ItineraryAbsenceUseCase,
  AbsenceNotFoundError,
  AbsenceCancelledError,
  AbsenceDateInPastError,
  AbsenceAlreadyExistsError,
  AbsenceWeekdayMismatchError,
  AbsenceOutsideAllocationError,
  SubstituteIsTitularError,
  type ItineraryAbsenceReaderPort,
  type ItineraryAbsenceWriterPort,
  type ItineraryAbsenceAllocationPort,
  type ItineraryAbsenceReasonCatalogPort,
  type ItineraryAbsenceChangeLogPort,
} from '../ItineraryAbsenceUseCase';
import { ServiceExitReasonRequiredError, ServiceExitReasonInvalidError } from '../../domain/serviceExitReason';
import { NotSelectedForServiceError, AllocationNotFoundError, AllocationNotActiveError } from '../ItineraryAllocationUseCase';
import { ItineraryOverlapError } from '../../domain/itineraryOverlap';
import type { ServiceTeamRows } from '../../infrastructure/ServiceTeamReader';

const FAKE_CLIENT = { marker: 'fake-client' } as never;

type RunInTransaction = ConstructorParameters<typeof ItineraryAbsenceUseCase>[3];

function runInTransactionStub(): RunInTransaction & jest.Mock {
  const fn = jest.fn((cb: (client: unknown) => Promise<unknown>) => cb(FAKE_CLIENT));
  return fn as unknown as RunInTransaction & jest.Mock;
}

function writerStub(overrides: Partial<ItineraryAbsenceWriterPort> = {}): ItineraryAbsenceWriterPort {
  return {
    insertAbsence: jest.fn(),
    findAbsence: jest.fn(),
    updateSubstitute: jest.fn(),
    cancelAbsence: jest.fn(),
    ...overrides,
  };
}

/** Catálogo dublê: só os códigos listados existem e estão ativos. */
function catalogStub(active: string[] = ['OTHER']): ItineraryAbsenceReasonCatalogPort & { findActiveByCode: jest.Mock } {
  return {
    findActiveByCode: jest.fn(async (_client: unknown, code: string) => (active.includes(code) ? { code, label: code } : null)),
  };
}

function changeLogStub(overrides: Partial<ItineraryAbsenceChangeLogPort> = {}): ItineraryAbsenceChangeLogPort & { insert: jest.Mock } {
  return { insert: jest.fn().mockResolvedValue({ id: 'log-1' }), ...overrides } as ItineraryAbsenceChangeLogPort & { insert: jest.Mock };
}

function allocationWriterStub(overrides: Partial<ItineraryAbsenceAllocationPort> = {}): ItineraryAbsenceAllocationPort {
  return {
    findAllocation: jest.fn(),
    findApplicationId: jest.fn(),
    ...overrides,
  };
}

const SELECTED_ROW: ServiceTeamRows = {
  serviceId: 's-1',
  country: 'AR',
  liveVacancyId: 'v-live',
  candidacies: [{ workerId: 'w-sub', vacancyId: 'v-live', stage: 'QUICK_RESPONSE_TEAM', firstNameEncrypted: null, lastNameEncrypted: null }],
  assignments: [],
  marks: [],
  substitutions: [],
};

const NOT_SELECTED_ROW: ServiceTeamRows = {
  serviceId: 's-1',
  country: 'AR',
  liveVacancyId: 'v-live',
  candidacies: [],
  assignments: [],
  marks: [],
  substitutions: [],
};

const IN_SERVICE_CANDIDATE_ROW: ServiceTeamRows = {
  serviceId: 's-1',
  country: 'AR',
  liveVacancyId: 'v-live',
  candidacies: [{ workerId: 'w-sub', vacancyId: 'v-live', stage: 'QUICK_RESPONSE_TEAM', firstNameEncrypted: null, lastNameEncrypted: null }],
  assignments: [
    { workerId: 'w-sub', serviceId: 's-1', vacancyId: 'v-live', validFrom: '2026-01-01', validTo: null, status: 'ACTIVE', firstNameEncrypted: null, lastNameEncrypted: null },
  ],
  marks: [],
  substitutions: [],
};

const ACTIVE_ALLOCATION = { id: 'alloc-1', status: 'ACTIVE' as const, validFrom: '2026-01-01', workerId: 'w-titular' };
const ENDED_ALLOCATION = { id: 'alloc-1', status: 'ENDED' as const, validFrom: '2026-01-01' };

const OPEN_ABSENCE = { id: 'abs-1', allocationId: 'alloc-1', date: '2026-09-28', substituteWorkerId: null, cancelled: false };
const CANCELLED_ABSENCE = { id: 'abs-1', allocationId: 'alloc-1', date: '2026-09-28', substituteWorkerId: null, cancelled: true };

function pgError(code: string, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error('db error'), { code, ...extra });
}

describe('ItineraryAbsenceUseCase.register', () => {
  it('alocação null → AllocationNotFoundError (404); 0 leitura do time, 0 insert', async () => {
    const reader: ItineraryAbsenceReaderPort = { readWith: jest.fn() };
    const writer = writerStub();
    const allocationWriter = allocationWriterStub({ findAllocation: jest.fn().mockResolvedValue(null) });
    const useCase = new ItineraryAbsenceUseCase(reader, writer, allocationWriter, runInTransactionStub(), catalogStub(), changeLogStub());

    await expect(
      useCase.register({ patientId: 'p-1', serviceId: 's-1', allocationId: 'alloc-1', date: '2026-09-28', reasonCategory: 'OTHER', actorUid: 'u-1' }),
    ).rejects.toThrow(AllocationNotFoundError);

    expect(reader.readWith).not.toHaveBeenCalled();
    expect(writer.insertAbsence).not.toHaveBeenCalled();
  });

  it('alocação ENDED → AllocationNotActiveError (422), ANTES do leitor', async () => {
    const reader: ItineraryAbsenceReaderPort = { readWith: jest.fn() };
    const writer = writerStub();
    const allocationWriter = allocationWriterStub({ findAllocation: jest.fn().mockResolvedValue(ENDED_ALLOCATION) });
    const useCase = new ItineraryAbsenceUseCase(reader, writer, allocationWriter, runInTransactionStub(), catalogStub(), changeLogStub());

    await expect(
      useCase.register({ patientId: 'p-1', serviceId: 's-1', allocationId: 'alloc-1', date: '2026-09-28', reasonCategory: 'OTHER', actorUid: 'u-1' }),
    ).rejects.toThrow(AllocationNotActiveError);

    expect(reader.readWith).not.toHaveBeenCalled();
  });

  it('serviço/paciente some entre a alocação e o leitor → AllocationNotFoundError (defensivo)', async () => {
    const reader: ItineraryAbsenceReaderPort = { readWith: jest.fn().mockResolvedValue(null) };
    const writer = writerStub();
    const allocationWriter = allocationWriterStub({ findAllocation: jest.fn().mockResolvedValue(ACTIVE_ALLOCATION) });
    const useCase = new ItineraryAbsenceUseCase(reader, writer, allocationWriter, runInTransactionStub(), catalogStub(), changeLogStub());

    await expect(
      useCase.register({ patientId: 'p-1', serviceId: 's-1', allocationId: 'alloc-1', date: '2026-09-28', reasonCategory: 'OTHER', actorUid: 'u-1' }),
    ).rejects.toThrow(AllocationNotFoundError);
  });

  it('date < asOf (UTC sem ambiguidade) → AbsenceDateInPastError (422); 0 insert', async () => {
    const reader: ItineraryAbsenceReaderPort = { readWith: jest.fn().mockResolvedValue(SELECTED_ROW) };
    const writer = writerStub();
    const allocationWriter = allocationWriterStub({ findAllocation: jest.fn().mockResolvedValue(ACTIVE_ALLOCATION) });
    const useCase = new ItineraryAbsenceUseCase(reader, writer, allocationWriter, runInTransactionStub(), catalogStub(), changeLogStub());
    const now = new Date('2026-09-28T15:00:00Z'); // meio-dia em Buenos Aires (UTC-3), asOf = 2026-09-28

    await expect(
      useCase.register({ patientId: 'p-1', serviceId: 's-1', allocationId: 'alloc-1', date: '2026-09-27', reasonCategory: 'OTHER', actorUid: 'u-1', now }),
    ).rejects.toThrow(AbsenceDateInPastError);

    expect(writer.insertAbsence).not.toHaveBeenCalled();
  });

  it('date == asOf de BA apesar de now já ser outro dia em UTC (02:30Z) → NÃO é passada, insere', async () => {
    const reader: ItineraryAbsenceReaderPort = { readWith: jest.fn().mockResolvedValue(SELECTED_ROW) };
    const writer = writerStub({ insertAbsence: jest.fn().mockResolvedValue({ id: 'abs-1', date: '2026-09-28' }) });
    const allocationWriter = allocationWriterStub({ findAllocation: jest.fn().mockResolvedValue(ACTIVE_ALLOCATION) });
    const useCase = new ItineraryAbsenceUseCase(reader, writer, allocationWriter, runInTransactionStub(), catalogStub(), changeLogStub());
    // 2026-09-29T02:30:00Z = 2026-09-28 23:30 em Buenos Aires (UTC-3) — asOf de BA é 2026-09-28, não 2026-09-29 (UTC).
    const now = new Date('2026-09-29T02:30:00Z');

    const result = await useCase.register({ patientId: 'p-1', serviceId: 's-1', allocationId: 'alloc-1', date: '2026-09-28', reasonCategory: 'OTHER', actorUid: 'u-1', now });

    expect(result.status).toBe('OPEN');
    expect(writer.insertAbsence).toHaveBeenCalledTimes(1);
  });

  it('sem substituto → insert com os dois campos NULL e 0 leitura de findApplicationId', async () => {
    const reader: ItineraryAbsenceReaderPort = { readWith: jest.fn().mockResolvedValue(SELECTED_ROW) };
    const writer = writerStub({ insertAbsence: jest.fn().mockResolvedValue({ id: 'abs-1', date: '2026-09-28' }) });
    const allocationWriter = allocationWriterStub({ findAllocation: jest.fn().mockResolvedValue(ACTIVE_ALLOCATION) });
    const useCase = new ItineraryAbsenceUseCase(reader, writer, allocationWriter, runInTransactionStub(), catalogStub(), changeLogStub());
    const now = new Date('2026-09-28T15:00:00Z');

    await useCase.register({ patientId: 'p-1', serviceId: 's-1', allocationId: 'alloc-1', date: '2026-09-28', reasonCategory: 'OTHER', actorUid: 'u-1', now });

    expect(allocationWriter.findApplicationId).not.toHaveBeenCalled();
    expect(writer.insertAbsence).toHaveBeenCalledWith(FAKE_CLIENT, {
      allocationId: 'alloc-1',
      date: '2026-09-28',
      substituteWorkerId: null,
      substituteApplicationId: null,
      actorUid: 'u-1',
    });
  });

  it('substituto em Selecionado → insert com a candidatura de findApplicationId', async () => {
    const reader: ItineraryAbsenceReaderPort = { readWith: jest.fn().mockResolvedValue(SELECTED_ROW) };
    const writer = writerStub({ insertAbsence: jest.fn().mockResolvedValue({ id: 'abs-1', date: '2026-09-28' }) });
    const allocationWriter = allocationWriterStub({
      findAllocation: jest.fn().mockResolvedValue(ACTIVE_ALLOCATION),
      findApplicationId: jest.fn().mockResolvedValue('wja-sub'),
    });
    const useCase = new ItineraryAbsenceUseCase(reader, writer, allocationWriter, runInTransactionStub(), catalogStub(), changeLogStub());
    const now = new Date('2026-09-28T15:00:00Z');

    await useCase.register({ patientId: 'p-1', serviceId: 's-1', allocationId: 'alloc-1', date: '2026-09-28', substituteWorkerId: 'w-sub', reasonCategory: 'OTHER', actorUid: 'u-1', now });

    expect(writer.insertAbsence).toHaveBeenCalledWith(FAKE_CLIENT, {
      allocationId: 'alloc-1',
      date: '2026-09-28',
      substituteWorkerId: 'w-sub',
      substituteApplicationId: 'wja-sub',
      actorUid: 'u-1',
    });
  });

  it('substituto Em Atendimento (inService) MAS ainda candidato → aceita (Q-13.3)', async () => {
    const reader: ItineraryAbsenceReaderPort = { readWith: jest.fn().mockResolvedValue(IN_SERVICE_CANDIDATE_ROW) };
    const writer = writerStub({ insertAbsence: jest.fn().mockResolvedValue({ id: 'abs-1', date: '2026-09-28' }) });
    const allocationWriter = allocationWriterStub({
      findAllocation: jest.fn().mockResolvedValue(ACTIVE_ALLOCATION),
      findApplicationId: jest.fn().mockResolvedValue('wja-sub'),
    });
    const useCase = new ItineraryAbsenceUseCase(reader, writer, allocationWriter, runInTransactionStub(), catalogStub(), changeLogStub());
    const now = new Date('2026-09-28T15:00:00Z');

    const result = await useCase.register({
      patientId: 'p-1',
      serviceId: 's-1',
      allocationId: 'alloc-1',
      date: '2026-09-28',
      substituteWorkerId: 'w-sub',
      reasonCategory: 'OTHER', actorUid: 'u-1',
      now,
    });

    expect(result.status).toBe('OPEN');
  });

  it('substituto Rejeitado/sem candidatura (fora de candidacyIds) → NotSelectedForServiceError; 0 insert', async () => {
    const reader: ItineraryAbsenceReaderPort = { readWith: jest.fn().mockResolvedValue(NOT_SELECTED_ROW) };
    const writer = writerStub();
    const allocationWriter = allocationWriterStub({ findAllocation: jest.fn().mockResolvedValue(ACTIVE_ALLOCATION) });
    const useCase = new ItineraryAbsenceUseCase(reader, writer, allocationWriter, runInTransactionStub(), catalogStub(), changeLogStub());
    const now = new Date('2026-09-28T15:00:00Z');

    await expect(
      useCase.register({ patientId: 'p-1', serviceId: 's-1', allocationId: 'alloc-1', date: '2026-09-28', substituteWorkerId: 'w-sub', reasonCategory: 'OTHER', actorUid: 'u-1', now }),
    ).rejects.toThrow(NotSelectedForServiceError);

    expect(writer.insertAbsence).not.toHaveBeenCalled();
  });

  it('substituto sem vaga viva (liveVacancyId null) → NotSelectedForServiceError, sem chamar findApplicationId', async () => {
    const row: ServiceTeamRows = { ...SELECTED_ROW, liveVacancyId: null };
    const reader: ItineraryAbsenceReaderPort = { readWith: jest.fn().mockResolvedValue(row) };
    const writer = writerStub();
    const allocationWriter = allocationWriterStub({ findAllocation: jest.fn().mockResolvedValue(ACTIVE_ALLOCATION) });
    const useCase = new ItineraryAbsenceUseCase(reader, writer, allocationWriter, runInTransactionStub(), catalogStub(), changeLogStub());
    const now = new Date('2026-09-28T15:00:00Z');

    await expect(
      useCase.register({ patientId: 'p-1', serviceId: 's-1', allocationId: 'alloc-1', date: '2026-09-28', substituteWorkerId: 'w-sub', reasonCategory: 'OTHER', actorUid: 'u-1', now }),
    ).rejects.toThrow(NotSelectedForServiceError);

    expect(allocationWriter.findApplicationId).not.toHaveBeenCalled();
  });

  it('23P01 do escritor → ItineraryOverlapError decodificado do DETAIL', async () => {
    const reader: ItineraryAbsenceReaderPort = { readWith: jest.fn().mockResolvedValue(SELECTED_ROW) };
    const detail = JSON.stringify({
      existingServiceId: 's-old',
      existingWeekday: 1,
      existingStart: '08:00',
      existingEnd: '12:00',
      requestedServiceId: 's-1',
      requestedWeekday: 1,
      requestedStart: '11:30',
      requestedEnd: '15:00',
      sameAddress: true,
      minGapMinutes: null,
    });
    const writer = writerStub({ insertAbsence: jest.fn().mockRejectedValue(pgError('23P01', { message: 'itinerary_overlap', detail })) });
    const allocationWriter = allocationWriterStub({ findAllocation: jest.fn().mockResolvedValue(ACTIVE_ALLOCATION) });
    const useCase = new ItineraryAbsenceUseCase(reader, writer, allocationWriter, runInTransactionStub(), catalogStub(), changeLogStub());
    const now = new Date('2026-09-28T15:00:00Z');

    const err = await useCase.register({ patientId: 'p-1', serviceId: 's-1', allocationId: 'alloc-1', date: '2026-09-28', reasonCategory: 'OTHER', actorUid: 'u-1', now }).catch((e) => e);

    expect(err).toBeInstanceOf(ItineraryOverlapError);
    expect((err as InstanceType<typeof ItineraryOverlapError>).existing.serviceId).toBe('s-old');
  });

  it('23505 uq_piab_open → AbsenceAlreadyExistsError (409)', async () => {
    const reader: ItineraryAbsenceReaderPort = { readWith: jest.fn().mockResolvedValue(SELECTED_ROW) };
    const writer = writerStub({ insertAbsence: jest.fn().mockRejectedValue(pgError('23505', { constraint: 'uq_piab_open' })) });
    const allocationWriter = allocationWriterStub({ findAllocation: jest.fn().mockResolvedValue(ACTIVE_ALLOCATION) });
    const useCase = new ItineraryAbsenceUseCase(reader, writer, allocationWriter, runInTransactionStub(), catalogStub(), changeLogStub());
    const now = new Date('2026-09-28T15:00:00Z');

    await expect(
      useCase.register({ patientId: 'p-1', serviceId: 's-1', allocationId: 'alloc-1', date: '2026-09-28', reasonCategory: 'OTHER', actorUid: 'u-1', now }),
    ).rejects.toThrow(AbsenceAlreadyExistsError);
  });

  it.each([
    ['piab_dia_da_semana', AbsenceWeekdayMismatchError],
    ['piab_fora_da_vigencia', AbsenceOutsideAllocationError],
    ['piab_substituto_e_o_titular', SubstituteIsTitularError],
  ])('23514 %s → %p', async (message, ErrorClass) => {
    const reader: ItineraryAbsenceReaderPort = { readWith: jest.fn().mockResolvedValue(SELECTED_ROW) };
    const writer = writerStub({ insertAbsence: jest.fn().mockRejectedValue(pgError('23514', { message })) });
    const allocationWriter = allocationWriterStub({ findAllocation: jest.fn().mockResolvedValue(ACTIVE_ALLOCATION) });
    const useCase = new ItineraryAbsenceUseCase(reader, writer, allocationWriter, runInTransactionStub(), catalogStub(), changeLogStub());
    const now = new Date('2026-09-28T15:00:00Z');

    await expect(
      useCase.register({ patientId: 'p-1', serviceId: 's-1', allocationId: 'alloc-1', date: '2026-09-28', reasonCategory: 'OTHER', actorUid: 'u-1', now }),
    ).rejects.toThrow(ErrorClass);
  });

  it('outro 23505 (constraint diferente) → relança o erro original', async () => {
    const reader: ItineraryAbsenceReaderPort = { readWith: jest.fn().mockResolvedValue(SELECTED_ROW) };
    const original = pgError('23505', { constraint: 'some_other_constraint' });
    const writer = writerStub({ insertAbsence: jest.fn().mockRejectedValue(original) });
    const allocationWriter = allocationWriterStub({ findAllocation: jest.fn().mockResolvedValue(ACTIVE_ALLOCATION) });
    const useCase = new ItineraryAbsenceUseCase(reader, writer, allocationWriter, runInTransactionStub(), catalogStub(), changeLogStub());
    const now = new Date('2026-09-28T15:00:00Z');

    const err = await useCase.register({ patientId: 'p-1', serviceId: 's-1', allocationId: 'alloc-1', date: '2026-09-28', reasonCategory: 'OTHER', actorUid: 'u-1', now }).catch((e) => e);

    expect(err).toBe(original);
  });

  it('outro 23514 (mensagem diferente) → relança o erro original', async () => {
    const reader: ItineraryAbsenceReaderPort = { readWith: jest.fn().mockResolvedValue(SELECTED_ROW) };
    const original = pgError('23514', { message: 'some_other_check' });
    const writer = writerStub({ insertAbsence: jest.fn().mockRejectedValue(original) });
    const allocationWriter = allocationWriterStub({ findAllocation: jest.fn().mockResolvedValue(ACTIVE_ALLOCATION) });
    const useCase = new ItineraryAbsenceUseCase(reader, writer, allocationWriter, runInTransactionStub(), catalogStub(), changeLogStub());
    const now = new Date('2026-09-28T15:00:00Z');

    const err = await useCase.register({ patientId: 'p-1', serviceId: 's-1', allocationId: 'alloc-1', date: '2026-09-28', reasonCategory: 'OTHER', actorUid: 'u-1', now }).catch((e) => e);

    expect(err).toBe(original);
  });

  it('feliz: leitor e escritor no MESMO client', async () => {
    const reader: ItineraryAbsenceReaderPort = { readWith: jest.fn().mockResolvedValue(SELECTED_ROW) };
    const writer = writerStub({ insertAbsence: jest.fn().mockResolvedValue({ id: 'abs-1', date: '2026-09-28' }) });
    const allocationWriter = allocationWriterStub({ findAllocation: jest.fn().mockResolvedValue(ACTIVE_ALLOCATION) });
    const useCase = new ItineraryAbsenceUseCase(reader, writer, allocationWriter, runInTransactionStub(), catalogStub(), changeLogStub());
    const now = new Date('2026-09-28T15:00:00Z');

    await useCase.register({ patientId: 'p-1', serviceId: 's-1', allocationId: 'alloc-1', date: '2026-09-28', reasonCategory: 'OTHER', actorUid: 'u-1', now });

    expect((allocationWriter.findAllocation as jest.Mock).mock.calls[0][0]).toBe(FAKE_CLIENT);
    expect((reader.readWith as jest.Mock).mock.calls[0][0]).toBe(FAKE_CLIENT);
    expect((writer.insertAbsence as jest.Mock).mock.calls[0][0]).toBe(FAKE_CLIENT);
  });
});

describe('ItineraryAbsenceUseCase.register — motivo e registro da troca (itinerario-trocas Fase 2)', () => {
  const NOW = new Date('2026-09-28T15:00:00Z');
  const BASE = { patientId: 'p-1', serviceId: 's-1', allocationId: 'alloc-1', date: '2026-09-28', actorUid: 'u-1', now: NOW };

  function build(opts: { catalog?: ReturnType<typeof catalogStub>; changeLog?: ReturnType<typeof changeLogStub>; order?: string[] } = {}) {
    const order = opts.order ?? [];
    const reader: ItineraryAbsenceReaderPort = { readWith: jest.fn().mockResolvedValue(SELECTED_ROW) };
    const writer = writerStub({
      insertAbsence: jest.fn(async () => {
        order.push('absence');
        return { id: 'abs-1', date: '2026-09-28' };
      }),
    });
    const allocationWriter = allocationWriterStub({
      findAllocation: jest.fn().mockResolvedValue(ACTIVE_ALLOCATION),
      findApplicationId: jest.fn().mockResolvedValue('wja-sub'),
    });
    const catalog = opts.catalog ?? catalogStub();
    const changeLog =
      opts.changeLog ??
      changeLogStub({
        insert: jest.fn(async () => {
          order.push('log');
          return { id: 'log-1' };
        }),
      });
    const runInTransaction = runInTransactionStub();
    const useCase = new ItineraryAbsenceUseCase(reader, writer, allocationWriter, runInTransaction, catalog, changeLog);
    return { useCase, writer, catalog, changeLog, runInTransaction, reader };
  }

  it.each([[undefined], [null], ['']])('motivo %p → ServiceExitReasonRequiredError ANTES do banco (0 transação, 0 escrita)', async (reason) => {
    const { useCase, writer, changeLog, runInTransaction } = build();

    await expect(useCase.register({ ...BASE, reasonCategory: reason })).rejects.toThrow(ServiceExitReasonRequiredError);

    expect(runInTransaction).not.toHaveBeenCalled();
    expect(writer.insertAbsence).not.toHaveBeenCalled();
    expect(changeLog.insert).not.toHaveBeenCalled();
  });

  it('motivo não-string → ServiceExitReasonInvalidError ANTES do banco', async () => {
    const { useCase, runInTransaction } = build();
    await expect(useCase.register({ ...BASE, reasonCategory: 42 })).rejects.toThrow(ServiceExitReasonInvalidError);
    expect(runInTransaction).not.toHaveBeenCalled();
  });

  it('código inexistente/inativo no catálogo → ServiceExitReasonInvalidError; 0 ausência, 0 registro', async () => {
    const { useCase, writer, changeLog, catalog } = build({ catalog: catalogStub([]) });

    await expect(useCase.register({ ...BASE, reasonCategory: 'DESATIVADO' })).rejects.toThrow(ServiceExitReasonInvalidError);

    expect(catalog.findActiveByCode).toHaveBeenCalledWith(FAKE_CLIENT, 'DESATIVADO');
    expect(writer.insertAbsence).not.toHaveBeenCalled();
    expect(changeLog.insert).not.toHaveBeenCalled();
  });

  it('com motivo: grava a ausência e DEPOIS o registro ABSENCE, no MESMO client (outgoing = titular, incoming = substituto)', async () => {
    const order: string[] = [];
    const { useCase, changeLog } = build({ order });

    await useCase.register({ ...BASE, substituteWorkerId: 'w-sub', reasonCategory: 'OTHER' });

    expect(order).toEqual(['absence', 'log']);
    expect(changeLog.insert).toHaveBeenCalledTimes(1);
    expect(changeLog.insert).toHaveBeenCalledWith(FAKE_CLIENT, {
      serviceId: 's-1',
      kind: 'ABSENCE',
      outgoingWorkerId: 'w-titular',
      incomingWorkerId: 'w-sub',
      assignmentId: 'alloc-1',
      absenceId: 'abs-1',
      effectiveDate: '2026-09-28',
      reasonCode: 'OTHER',
      actorUid: 'u-1',
    });
  });

  it('sem substituto: o registro ABSENCE leva incoming nulo', async () => {
    const { useCase, changeLog } = build();
    await useCase.register({ ...BASE, reasonCategory: 'OTHER' });
    expect(changeLog.insert).toHaveBeenCalledWith(FAKE_CLIENT, expect.objectContaining({ incomingWorkerId: null }));
  });

  it('falha ao gravar o registro sobe CRU (a transação desfaz a ausência) — não vira erro de ausência', async () => {
    const boom = pgError('23503', { constraint: 'patient_itinerary_change_log_reason_code_fkey' });
    const { useCase } = build({ changeLog: changeLogStub({ insert: jest.fn().mockRejectedValue(boom) }) });

    const err = await useCase.register({ ...BASE, reasonCategory: 'OTHER' }).catch((e) => e);

    expect(err).toBe(boom);
  });

  it('falha na ausência (23505) → 0 registro (a ordem é ausência → registro)', async () => {
    const { useCase, writer, changeLog } = build();
    (writer.insertAbsence as jest.Mock).mockRejectedValue(pgError('23505', { constraint: 'uq_piab_open' }));

    await expect(useCase.register({ ...BASE, reasonCategory: 'OTHER' })).rejects.toThrow(AbsenceAlreadyExistsError);

    expect(changeLog.insert).not.toHaveBeenCalled();
  });
});

describe('ItineraryAbsenceUseCase.setSubstitute', () => {
  it('ausência null → AbsenceNotFoundError (404)', async () => {
    const reader: ItineraryAbsenceReaderPort = { readWith: jest.fn() };
    const writer = writerStub({ findAbsence: jest.fn().mockResolvedValue(null) });
    const allocationWriter = allocationWriterStub();
    const useCase = new ItineraryAbsenceUseCase(reader, writer, allocationWriter, runInTransactionStub());

    await expect(
      useCase.setSubstitute({ patientId: 'p-1', serviceId: 's-1', absenceId: 'abs-1', substituteWorkerId: null, actorUid: 'u-1' }),
    ).rejects.toThrow(AbsenceNotFoundError);

    expect(writer.updateSubstitute).not.toHaveBeenCalled();
  });

  it('ausência cancelada → AbsenceCancelledError (422), sem updateSubstitute', async () => {
    const reader: ItineraryAbsenceReaderPort = { readWith: jest.fn() };
    const writer = writerStub({ findAbsence: jest.fn().mockResolvedValue(CANCELLED_ABSENCE) });
    const allocationWriter = allocationWriterStub();
    const useCase = new ItineraryAbsenceUseCase(reader, writer, allocationWriter, runInTransactionStub());

    await expect(
      useCase.setSubstitute({ patientId: 'p-1', serviceId: 's-1', absenceId: 'abs-1', substituteWorkerId: 'w-sub', actorUid: 'u-1' }),
    ).rejects.toThrow(AbsenceCancelledError);

    expect(reader.readWith).not.toHaveBeenCalled();
    expect(writer.updateSubstitute).not.toHaveBeenCalled();
  });

  it('serviço/paciente some entre a ausência e o leitor → AbsenceNotFoundError (defensivo)', async () => {
    const reader: ItineraryAbsenceReaderPort = { readWith: jest.fn().mockResolvedValue(null) };
    const writer = writerStub({ findAbsence: jest.fn().mockResolvedValue(OPEN_ABSENCE) });
    const allocationWriter = allocationWriterStub();
    const useCase = new ItineraryAbsenceUseCase(reader, writer, allocationWriter, runInTransactionStub());

    await expect(
      useCase.setSubstitute({ patientId: 'p-1', serviceId: 's-1', absenceId: 'abs-1', substituteWorkerId: null, actorUid: 'u-1' }),
    ).rejects.toThrow(AbsenceNotFoundError);
  });

  it('data da ausência já passou (asOf avançou) → AbsenceDateInPastError', async () => {
    const reader: ItineraryAbsenceReaderPort = { readWith: jest.fn().mockResolvedValue(SELECTED_ROW) };
    const writer = writerStub({ findAbsence: jest.fn().mockResolvedValue(OPEN_ABSENCE) });
    const allocationWriter = allocationWriterStub();
    const useCase = new ItineraryAbsenceUseCase(reader, writer, allocationWriter, runInTransactionStub());
    const now = new Date('2026-09-29T15:00:00Z'); // asOf BA = 2026-09-29, ausência é 2026-09-28

    await expect(
      useCase.setSubstitute({ patientId: 'p-1', serviceId: 's-1', absenceId: 'abs-1', substituteWorkerId: null, actorUid: 'u-1', now }),
    ).rejects.toThrow(AbsenceDateInPastError);

    expect(writer.updateSubstitute).not.toHaveBeenCalled();
  });

  it('substituteWorkerId null (TIRAR) → updateSubstitute(…, null, null, …) SEM gate, sem findApplicationId', async () => {
    const reader: ItineraryAbsenceReaderPort = { readWith: jest.fn().mockResolvedValue(SELECTED_ROW) };
    const writer = writerStub({ findAbsence: jest.fn().mockResolvedValue(OPEN_ABSENCE), updateSubstitute: jest.fn().mockResolvedValue(1) });
    const allocationWriter = allocationWriterStub();
    const useCase = new ItineraryAbsenceUseCase(reader, writer, allocationWriter, runInTransactionStub());
    const now = new Date('2026-09-28T15:00:00Z');

    const result = await useCase.setSubstitute({ patientId: 'p-1', serviceId: 's-1', absenceId: 'abs-1', substituteWorkerId: null, actorUid: 'u-1', now });

    expect(allocationWriter.findApplicationId).not.toHaveBeenCalled();
    expect(writer.updateSubstitute).toHaveBeenCalledWith(FAKE_CLIENT, 'abs-1', null, null, 'u-1');
    expect(result).toEqual({ absenceId: 'abs-1', allocationId: 'alloc-1', date: '2026-09-28', substituteWorkerId: null, status: 'OPEN' });
  });

  it('substituteWorkerId válido (candidato Selecionado) → updateSubstitute com a candidatura de findApplicationId', async () => {
    const reader: ItineraryAbsenceReaderPort = { readWith: jest.fn().mockResolvedValue(SELECTED_ROW) };
    const writer = writerStub({ findAbsence: jest.fn().mockResolvedValue(OPEN_ABSENCE), updateSubstitute: jest.fn().mockResolvedValue(1) });
    const allocationWriter = allocationWriterStub({ findApplicationId: jest.fn().mockResolvedValue('wja-sub') });
    const useCase = new ItineraryAbsenceUseCase(reader, writer, allocationWriter, runInTransactionStub());
    const now = new Date('2026-09-28T15:00:00Z');

    await useCase.setSubstitute({ patientId: 'p-1', serviceId: 's-1', absenceId: 'abs-1', substituteWorkerId: 'w-sub', actorUid: 'u-1', now });

    expect(writer.updateSubstitute).toHaveBeenCalledWith(FAKE_CLIENT, 'abs-1', 'w-sub', 'wja-sub', 'u-1');
  });

  it('substituto fora de Selecionado/Em Atendimento+candidato → NotSelectedForServiceError, sem updateSubstitute', async () => {
    const reader: ItineraryAbsenceReaderPort = { readWith: jest.fn().mockResolvedValue(NOT_SELECTED_ROW) };
    const writer = writerStub({ findAbsence: jest.fn().mockResolvedValue(OPEN_ABSENCE) });
    const allocationWriter = allocationWriterStub();
    const useCase = new ItineraryAbsenceUseCase(reader, writer, allocationWriter, runInTransactionStub());
    const now = new Date('2026-09-28T15:00:00Z');

    await expect(
      useCase.setSubstitute({ patientId: 'p-1', serviceId: 's-1', absenceId: 'abs-1', substituteWorkerId: 'w-sub', actorUid: 'u-1', now }),
    ).rejects.toThrow(NotSelectedForServiceError);

    expect(writer.updateSubstitute).not.toHaveBeenCalled();
  });

  it('rowCount 0 no updateSubstitute (corrida: cancelou entre o findAbsence e o update) → AbsenceCancelledError', async () => {
    const reader: ItineraryAbsenceReaderPort = { readWith: jest.fn().mockResolvedValue(SELECTED_ROW) };
    const writer = writerStub({ findAbsence: jest.fn().mockResolvedValue(OPEN_ABSENCE), updateSubstitute: jest.fn().mockResolvedValue(0) });
    const allocationWriter = allocationWriterStub();
    const useCase = new ItineraryAbsenceUseCase(reader, writer, allocationWriter, runInTransactionStub());
    const now = new Date('2026-09-28T15:00:00Z');

    await expect(
      useCase.setSubstitute({ patientId: 'p-1', serviceId: 's-1', absenceId: 'abs-1', substituteWorkerId: null, actorUid: 'u-1', now }),
    ).rejects.toThrow(AbsenceCancelledError);
  });

  it('23514 piab_substituto_e_o_titular do updateSubstitute → SubstituteIsTitularError', async () => {
    const reader: ItineraryAbsenceReaderPort = { readWith: jest.fn().mockResolvedValue(SELECTED_ROW) };
    const writer = writerStub({
      findAbsence: jest.fn().mockResolvedValue(OPEN_ABSENCE),
      updateSubstitute: jest.fn().mockRejectedValue(pgError('23514', { message: 'piab_substituto_e_o_titular' })),
    });
    const allocationWriter = allocationWriterStub({ findApplicationId: jest.fn().mockResolvedValue('wja-sub') });
    const useCase = new ItineraryAbsenceUseCase(reader, writer, allocationWriter, runInTransactionStub());
    const now = new Date('2026-09-28T15:00:00Z');

    await expect(
      useCase.setSubstitute({ patientId: 'p-1', serviceId: 's-1', absenceId: 'abs-1', substituteWorkerId: 'w-sub', actorUid: 'u-1', now }),
    ).rejects.toThrow(SubstituteIsTitularError);
  });
});

describe('ItineraryAbsenceUseCase.cancel', () => {
  it('ausência null → AbsenceNotFoundError (404)', async () => {
    const reader: ItineraryAbsenceReaderPort = { readWith: jest.fn() };
    const writer = writerStub({ findAbsence: jest.fn().mockResolvedValue(null) });
    const allocationWriter = allocationWriterStub();
    const useCase = new ItineraryAbsenceUseCase(reader, writer, allocationWriter, runInTransactionStub());

    await expect(useCase.cancel({ patientId: 'p-1', serviceId: 's-1', absenceId: 'abs-1', actorUid: 'u-1' })).rejects.toThrow(AbsenceNotFoundError);

    expect(writer.cancelAbsence).not.toHaveBeenCalled();
  });

  it('ausência já cancelada → AbsenceCancelledError (422), sem cancelAbsence', async () => {
    const reader: ItineraryAbsenceReaderPort = { readWith: jest.fn() };
    const writer = writerStub({ findAbsence: jest.fn().mockResolvedValue(CANCELLED_ABSENCE) });
    const allocationWriter = allocationWriterStub();
    const useCase = new ItineraryAbsenceUseCase(reader, writer, allocationWriter, runInTransactionStub());

    await expect(useCase.cancel({ patientId: 'p-1', serviceId: 's-1', absenceId: 'abs-1', actorUid: 'u-1' })).rejects.toThrow(AbsenceCancelledError);

    expect(writer.cancelAbsence).not.toHaveBeenCalled();
  });

  it('feliz: status CANCELLED; leitor(findAbsence)/escritor no MESMO client', async () => {
    const writer = writerStub({ findAbsence: jest.fn().mockResolvedValue(OPEN_ABSENCE), cancelAbsence: jest.fn().mockResolvedValue(1) });
    const allocationWriter = allocationWriterStub();
    const useCase = new ItineraryAbsenceUseCase({ readWith: jest.fn() }, writer, allocationWriter, runInTransactionStub());

    const result = await useCase.cancel({ patientId: 'p-1', serviceId: 's-1', absenceId: 'abs-1', actorUid: 'u-1' });

    expect(result).toEqual({ absenceId: 'abs-1', allocationId: 'alloc-1', date: '2026-09-28', substituteWorkerId: null, status: 'CANCELLED' });
    expect((writer.findAbsence as jest.Mock).mock.calls[0][0]).toBe(FAKE_CLIENT);
    expect((writer.cancelAbsence as jest.Mock).mock.calls[0][0]).toBe(FAKE_CLIENT);
  });

  it('achado C4 (veredito parcial-1): rowCount 0 no cancelAbsence (corrida: cancelou entre o findAbsence e o UPDATE) → AbsenceCancelledError, MESMO padrão do setSubstitute', async () => {
    const writer = writerStub({ findAbsence: jest.fn().mockResolvedValue(OPEN_ABSENCE), cancelAbsence: jest.fn().mockResolvedValue(0) });
    const allocationWriter = allocationWriterStub();
    const useCase = new ItineraryAbsenceUseCase({ readWith: jest.fn() }, writer, allocationWriter, runInTransactionStub());

    await expect(useCase.cancel({ patientId: 'p-1', serviceId: 's-1', absenceId: 'abs-1', actorUid: 'u-1' })).rejects.toThrow(AbsenceCancelledError);
  });

  describe('gate parcial #1: erro de validação do banco no cancelAbsence vira erro de domínio (nunca 500)', () => {
    const cancelWith = (rejection: unknown) => {
      const writer = writerStub({ findAbsence: jest.fn().mockResolvedValue(OPEN_ABSENCE), cancelAbsence: jest.fn().mockRejectedValue(rejection) });
      const useCase = new ItineraryAbsenceUseCase({ readWith: jest.fn() }, writer, allocationWriterStub(), runInTransactionStub());
      return useCase.cancel({ patientId: 'p-1', serviceId: 's-1', absenceId: 'abs-1', actorUid: 'u-1' });
    };

    it('23514 piab_fora_da_vigencia → AbsenceOutsideAllocationError', async () => {
      await expect(cancelWith(pgError('23514', { message: 'piab_fora_da_vigencia' }))).rejects.toThrow(AbsenceOutsideAllocationError);
    });

    it('23514 piab_cancelada (corrida) → AbsenceCancelledError, o MESMO 409 de "já cancelada"', async () => {
      await expect(cancelWith(pgError('23514', { message: 'piab_cancelada' }))).rejects.toThrow(AbsenceCancelledError);
    });

    it('erro desconhecido → relança o ORIGINAL', async () => {
      const original = pgError('23514', { message: 'some_other_check' });
      await expect(cancelWith(original)).rejects.toBe(original);
    });
  });
});
