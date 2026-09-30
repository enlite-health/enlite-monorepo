/**
 * ServiceTeamMarkUseCase — Fase 10, DX-10.6 (2). `reader`, `writer`, `kms` e a TRANSAÇÃO
 * (`runInTransaction`) injetados — sem banco real. A transação injetada só chama `fn` direto no
 * client dublê, provando que a ordem (motivo → transação → checagens → escrita → releitura) é a
 * do caso de uso, não da infraestrutura.
 */
import {
  ServiceTeamMarkUseCase,
  ServiceTeamWorkerAllocatedError,
  ServiceTeamNotSelectedError,
  ServiceTeamNotRejectedError,
  ServiceTeamAlreadyRejectedError,
  type ServiceTeamMarkReaderPort,
  type ServiceTeamMarkWriterPort,
  type ServiceTeamReasonCatalogPort,
} from '../ServiceTeamMarkUseCase';
import { ServiceTeamNotFoundError } from '../GetServiceTeamUseCase';
import { ServiceTeamReasonRequiredError, ServiceTeamReasonInvalidError } from '../../domain/serviceTeamReason';
import type { ServiceTeamRows } from '../../infrastructure/ServiceTeamReader';
import type { Decryptor } from '@modules/identity/permissions';

const FAKE_CLIENT = { marker: 'fake-client' } as never;

/** O 4º parâmetro do construtor (`runInTransaction`) é genérico — jest.fn() não tipa genéricos, daí o cast local. */
type RunInTransaction = ConstructorParameters<typeof ServiceTeamMarkUseCase>[3];

/** Catálogo dublê: só os códigos ATIVOS listados existem (o resto = inexistente/inativo → `null`). */
function catalogStub(active: string[] = ['OTHER', 'PERFIL_INADEQUADO_AO_SERVICO', 'NOVO_ITEM_DO_ADMIN']): ServiceTeamReasonCatalogPort & {
  findActiveByCode: jest.Mock;
} {
  return {
    findActiveByCode: jest.fn(async (_client: unknown, code: string) => (active.includes(code) ? { code, label: code } : null)),
  };
}

function kmsSpy(): Decryptor {
  return { decrypt: jest.fn(async (c?: string | null) => String(c ?? '').replace(/^enc:/, '')) };
}

function runInTransactionStub(): RunInTransaction & jest.Mock {
  const fn = jest.fn((cb: (client: unknown) => Promise<unknown>) => cb(FAKE_CLIENT));
  return fn as unknown as RunInTransaction & jest.Mock;
}

const SELECTED_ROW: ServiceTeamRows = {
  serviceId: 's-1',
  country: 'AR',
  liveVacancyId: 'v-live',
  candidacies: [
    { workerId: 'w-1', vacancyId: 'v-live', stage: 'QUICK_RESPONSE_TEAM', firstNameEncrypted: 'enc:Ana', lastNameEncrypted: null },
  ],
  assignments: [],
  marks: [],
};

const ALLOCATED_ROW: ServiceTeamRows = {
  serviceId: 's-1',
  country: 'AR',
  liveVacancyId: 'v-live',
  candidacies: [],
  assignments: [
    {
      workerId: 'w-1',
      serviceId: 's-1',
      vacancyId: 'v-old',
      validFrom: '2020-01-01',
      validTo: null,
      status: 'ACTIVE',
      firstNameEncrypted: null,
      lastNameEncrypted: null,
    },
  ],
  marks: [],
};

const EMPTY_ROW: ServiceTeamRows = {
  serviceId: 's-1',
  country: 'AR',
  liveVacancyId: 'v-live',
  candidacies: [],
  assignments: [],
  marks: [],
};

const REJECTED_ROW: ServiceTeamRows = {
  serviceId: 's-1',
  country: 'AR',
  liveVacancyId: 'v-live',
  candidacies: [],
  assignments: [],
  marks: [{ workerId: 'w-1', serviceId: 's-1', rejectReasonCategory: 'OTHER', firstNameEncrypted: 'enc:Ana', lastNameEncrypted: null }],
};

describe('ServiceTeamMarkUseCase', () => {
  it('reject sem motivo → ServiceTeamReasonRequiredError; 0 chamadas ao leitor/escritor/transação', async () => {
    const reader: ServiceTeamMarkReaderPort = { readWith: jest.fn() };
    const writer: ServiceTeamMarkWriterPort = { insertRejection: jest.fn(), revertRejection: jest.fn() };
    const runInTransaction = runInTransactionStub();
    const useCase = new ServiceTeamMarkUseCase(reader, writer, kmsSpy(), runInTransaction, catalogStub());

    await expect(
      useCase.reject({ patientId: 'p-1', serviceId: 's-1', workerId: 'w-1', reasonCategory: undefined, actorUid: 'u-1', cells: null }),
    ).rejects.toThrow(ServiceTeamReasonRequiredError);

    expect(reader.readWith).not.toHaveBeenCalled();
    expect(writer.insertRejection).not.toHaveBeenCalled();
    expect(runInTransaction).not.toHaveBeenCalled();
  });

  it('reject com código inexistente no catálogo (ex.: motivo de REVERTER) → ServiceTeamReasonInvalidError; 0 leitura do time, 0 escrita', async () => {
    const reader: ServiceTeamMarkReaderPort = { readWith: jest.fn() };
    const writer: ServiceTeamMarkWriterPort = { insertRejection: jest.fn(), revertRejection: jest.fn() };
    const catalog = catalogStub();
    const useCase = new ServiceTeamMarkUseCase(reader, writer, kmsSpy(), runInTransactionStub(), catalog);

    await expect(
      useCase.reject({ patientId: 'p-1', serviceId: 's-1', workerId: 'w-1', reasonCategory: 'REAVALIACAO', actorUid: 'u-1', cells: null }),
    ).rejects.toThrow(ServiceTeamReasonInvalidError);

    expect(catalog.findActiveByCode).toHaveBeenCalledWith(FAKE_CLIENT, 'REAVALIACAO');
    expect(reader.readWith).not.toHaveBeenCalled();
    expect(writer.insertRejection).not.toHaveBeenCalled();
  });

  it('reject com código DESATIVADO no catálogo (findActiveByCode → null) → ServiceTeamReasonInvalidError; 0 escrita', async () => {
    const reader: ServiceTeamMarkReaderPort = { readWith: jest.fn().mockResolvedValue(SELECTED_ROW) };
    const writer: ServiceTeamMarkWriterPort = { insertRejection: jest.fn(), revertRejection: jest.fn() };
    const useCase = new ServiceTeamMarkUseCase(reader, writer, kmsSpy(), runInTransactionStub(), catalogStub([]));

    await expect(
      useCase.reject({ patientId: 'p-1', serviceId: 's-1', workerId: 'w-1', reasonCategory: 'OTHER', actorUid: 'u-1', cells: null }),
    ).rejects.toThrow(ServiceTeamReasonInvalidError);

    expect(writer.insertRejection).not.toHaveBeenCalled();
  });

  it('reject com motivo não-string → ServiceTeamReasonInvalidError ANTES do banco (0 transação)', async () => {
    const runInTransaction = runInTransactionStub();
    const catalog = catalogStub();
    const useCase = new ServiceTeamMarkUseCase(
      { readWith: jest.fn() },
      { insertRejection: jest.fn(), revertRejection: jest.fn() },
      kmsSpy(),
      runInTransaction,
      catalog,
    );

    await expect(
      useCase.reject({ patientId: 'p-1', serviceId: 's-1', workerId: 'w-1', reasonCategory: 42, actorUid: 'u-1', cells: null }),
    ).rejects.toThrow(ServiceTeamReasonInvalidError);

    expect(runInTransaction).not.toHaveBeenCalled();
    expect(catalog.findActiveByCode).not.toHaveBeenCalled();
  });

  it('reject com código criado pelo admin (ativo no catálogo) → grava a marca com esse código', async () => {
    const readWith = jest.fn().mockResolvedValueOnce(SELECTED_ROW).mockResolvedValueOnce(REJECTED_ROW);
    const insertRejection = jest.fn().mockResolvedValue(undefined);
    const useCase = new ServiceTeamMarkUseCase(
      { readWith },
      { insertRejection, revertRejection: jest.fn() },
      kmsSpy(),
      runInTransactionStub(),
      catalogStub(),
    );

    await useCase.reject({ patientId: 'p-1', serviceId: 's-1', workerId: 'w-1', reasonCategory: 'NOVO_ITEM_DO_ADMIN', actorUid: 'u-1', cells: null });

    expect(insertRejection).toHaveBeenCalledWith(FAKE_CLIENT, expect.objectContaining({ category: 'NOVO_ITEM_DO_ADMIN' }));
  });

  it('revert NÃO consulta o catálogo: segue a lista fechada de reverter (motivo de rejeitar → Invalid antes do banco)', async () => {
    const runInTransaction = runInTransactionStub();
    const catalog = catalogStub();
    const useCase = new ServiceTeamMarkUseCase(
      { readWith: jest.fn() },
      { insertRejection: jest.fn(), revertRejection: jest.fn() },
      kmsSpy(),
      runInTransaction,
      catalog,
    );

    await expect(
      useCase.revert({ patientId: 'p-1', serviceId: 's-1', workerId: 'w-1', reasonCategory: 'PERFIL_INADEQUADO_AO_SERVICO', actorUid: 'u-1', cells: null }),
    ).rejects.toThrow(ServiceTeamReasonInvalidError);

    expect(runInTransaction).not.toHaveBeenCalled();
    expect(catalog.findActiveByCode).not.toHaveBeenCalled();
  });

  it('reject de quem está inService → ServiceTeamWorkerAllocatedError; 0 escrita', async () => {
    const reader: ServiceTeamMarkReaderPort = { readWith: jest.fn().mockResolvedValue(ALLOCATED_ROW) };
    const writer: ServiceTeamMarkWriterPort = { insertRejection: jest.fn(), revertRejection: jest.fn() };
    const useCase = new ServiceTeamMarkUseCase(reader, writer, kmsSpy(), runInTransactionStub(), catalogStub());

    await expect(
      useCase.reject({ patientId: 'p-1', serviceId: 's-1', workerId: 'w-1', reasonCategory: 'OTHER', actorUid: 'u-1', cells: null }),
    ).rejects.toThrow(ServiceTeamWorkerAllocatedError);

    expect(writer.insertRejection).not.toHaveBeenCalled();
  });

  it('reject de quem não é candidato (nem selected, nem inService) → ServiceTeamNotSelectedError', async () => {
    const reader: ServiceTeamMarkReaderPort = { readWith: jest.fn().mockResolvedValue(EMPTY_ROW) };
    const writer: ServiceTeamMarkWriterPort = { insertRejection: jest.fn(), revertRejection: jest.fn() };
    const useCase = new ServiceTeamMarkUseCase(reader, writer, kmsSpy(), runInTransactionStub(), catalogStub());

    await expect(
      useCase.reject({ patientId: 'p-1', serviceId: 's-1', workerId: 'w-1', reasonCategory: 'OTHER', actorUid: 'u-1', cells: null }),
    ).rejects.toThrow(ServiceTeamNotSelectedError);

    expect(writer.insertRejection).not.toHaveBeenCalled();
  });

  it('reject feliz: 1 insert + o time recalculado (leitor chamado de novo, mesmo client) com o worker em rejected', async () => {
    const readWith = jest.fn().mockResolvedValueOnce(SELECTED_ROW).mockResolvedValueOnce(REJECTED_ROW);
    const reader: ServiceTeamMarkReaderPort = { readWith };
    const insertRejection = jest.fn().mockResolvedValue(undefined);
    const writer: ServiceTeamMarkWriterPort = { insertRejection, revertRejection: jest.fn() };
    const useCase = new ServiceTeamMarkUseCase(reader, writer, kmsSpy(), runInTransactionStub(), catalogStub());

    const result = await useCase.reject({
      patientId: 'p-1',
      serviceId: 's-1',
      workerId: 'w-1',
      reasonCategory: 'OTHER',
      actorUid: 'staff:u-1',
      cells: null,
      now: new Date('2026-09-28T02:30:00Z'), // AR (UTC-3) = 2026-09-27 local
    });

    expect(insertRejection).toHaveBeenCalledTimes(1);
    expect(insertRejection).toHaveBeenCalledWith(FAKE_CLIENT, {
      serviceId: 's-1',
      workerId: 'w-1',
      category: 'OTHER',
      actorUid: 'staff:u-1',
    });
    expect(readWith).toHaveBeenCalledTimes(2);
    expect(readWith.mock.calls[0]).toEqual([FAKE_CLIENT, 'p-1', 's-1']);
    expect(readWith.mock.calls[1]).toEqual([FAKE_CLIENT, 'p-1', 's-1']);
    expect(result.rejected).toEqual([{ workerId: 'w-1', displayName: 'Ana', vacancyId: 'v-live', reasonCategory: 'OTHER' }]);
    expect(result.selected).toEqual([]);
    expect(result.inService).toEqual([]);
    expect(result.asOf).toBe('2026-09-27');
  });

  it('reject: 23505 do uq_csr_active_pair (corrida do escritor) → ServiceTeamAlreadyRejectedError', async () => {
    const reader: ServiceTeamMarkReaderPort = { readWith: jest.fn().mockResolvedValue(SELECTED_ROW) };
    const insertRejection = jest.fn().mockRejectedValue({ code: '23505', constraint: 'uq_csr_active_pair' });
    const writer: ServiceTeamMarkWriterPort = { insertRejection, revertRejection: jest.fn() };
    const useCase = new ServiceTeamMarkUseCase(reader, writer, kmsSpy(), runInTransactionStub(), catalogStub());

    await expect(
      useCase.reject({ patientId: 'p-1', serviceId: 's-1', workerId: 'w-1', reasonCategory: 'OTHER', actorUid: 'u-1', cells: null }),
    ).rejects.toThrow(ServiceTeamAlreadyRejectedError);
  });

  it('serviço inexistente/de outro paciente (leitor devolve null) → ServiceTeamNotFoundError', async () => {
    const reader: ServiceTeamMarkReaderPort = { readWith: jest.fn().mockResolvedValue(null) };
    const writer: ServiceTeamMarkWriterPort = { insertRejection: jest.fn(), revertRejection: jest.fn() };
    const useCase = new ServiceTeamMarkUseCase(reader, writer, kmsSpy(), runInTransactionStub(), catalogStub());

    await expect(
      useCase.reject({ patientId: 'p-1', serviceId: 's-1', workerId: 'w-1', reasonCategory: 'OTHER', actorUid: 'u-1', cells: null }),
    ).rejects.toThrow(ServiceTeamNotFoundError);
  });

  it('revert quem não está rejected → ServiceTeamNotRejectedError; 0 escrita', async () => {
    const reader: ServiceTeamMarkReaderPort = { readWith: jest.fn().mockResolvedValue(EMPTY_ROW) };
    const writer: ServiceTeamMarkWriterPort = { insertRejection: jest.fn(), revertRejection: jest.fn() };
    const useCase = new ServiceTeamMarkUseCase(reader, writer, kmsSpy(), runInTransactionStub(), catalogStub());

    await expect(
      useCase.revert({ patientId: 'p-1', serviceId: 's-1', workerId: 'w-1', reasonCategory: 'OTHER', actorUid: 'u-1', cells: null }),
    ).rejects.toThrow(ServiceTeamNotRejectedError);

    expect(writer.revertRejection).not.toHaveBeenCalled();
  });

  it('revert: rowCount 0 do UPDATE (corrida — já revertido) → ServiceTeamNotRejectedError', async () => {
    const reader: ServiceTeamMarkReaderPort = { readWith: jest.fn().mockResolvedValue(REJECTED_ROW) };
    const revertRejection = jest.fn().mockResolvedValue(0);
    const writer: ServiceTeamMarkWriterPort = { insertRejection: jest.fn(), revertRejection };
    const useCase = new ServiceTeamMarkUseCase(reader, writer, kmsSpy(), runInTransactionStub(), catalogStub());

    await expect(
      useCase.revert({ patientId: 'p-1', serviceId: 's-1', workerId: 'w-1', reasonCategory: 'OTHER', actorUid: 'u-1', cells: null }),
    ).rejects.toThrow(ServiceTeamNotRejectedError);
  });

  it('revert feliz: 1 update + o time recalculado sem o worker em rejected', async () => {
    const readWith = jest.fn().mockResolvedValueOnce(REJECTED_ROW).mockResolvedValueOnce(EMPTY_ROW);
    const reader: ServiceTeamMarkReaderPort = { readWith };
    const revertRejection = jest.fn().mockResolvedValue(1);
    const writer: ServiceTeamMarkWriterPort = { insertRejection: jest.fn(), revertRejection };
    const useCase = new ServiceTeamMarkUseCase(reader, writer, kmsSpy(), runInTransactionStub(), catalogStub());

    const result = await useCase.revert({
      patientId: 'p-1',
      serviceId: 's-1',
      workerId: 'w-1',
      reasonCategory: 'REAVALIACAO',
      actorUid: 'staff:u-1',
      cells: null,
    });

    expect(revertRejection).toHaveBeenCalledTimes(1);
    expect(revertRejection).toHaveBeenCalledWith(FAKE_CLIENT, {
      serviceId: 's-1',
      workerId: 'w-1',
      category: 'REAVALIACAO',
      actorUid: 'staff:u-1',
    });
    expect(readWith).toHaveBeenCalledTimes(2);
    expect(result.rejected).toEqual([]);
  });
});
