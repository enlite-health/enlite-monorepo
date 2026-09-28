/**
 * GetServiceTeamUseCase — Fase 10, DX-10.6 (1). `reader` e `kms` injetados (dublês, sem banco/rede
 * real); `now` fixo para a conta de `asOf` ser determinística. `kms.decrypt` devolve o texto após
 * `enc:` — o mesmo dublê de `projectWorkerFields.test.ts`.
 */
import { GetServiceTeamUseCase, ServiceTeamNotFoundError, type ServiceTeamReaderPort } from '../GetServiceTeamUseCase';
import type { ServiceTeamRows } from '../../infrastructure/ServiceTeamReader';
import { CELL_WORKER_CONTACT_READ, type Decryptor } from '@modules/identity/permissions';

function readerStub(row: ServiceTeamRows | null): ServiceTeamReaderPort {
  return { read: jest.fn().mockResolvedValue(row) };
}

function kmsSpy(): { kms: Decryptor; decrypt: jest.Mock } {
  const decrypt = jest.fn(async (c?: string | null) => String(c ?? '').replace(/^enc:/, ''));
  return { kms: { decrypt }, decrypt };
}

/** 1 candidato, 1 alocado, 1 rejeitado — 3 prestadores DISTINTOS, cada um com só o primeiro nome. */
function umRow(): ServiceTeamRows {
  return {
    serviceId: 's-1',
    country: 'AR',
    liveVacancyId: 'v-live',
    candidacies: [
      {
        workerId: 'w-selected',
        vacancyId: 'v-live',
        stage: 'QUICK_RESPONSE_TEAM',
        firstNameEncrypted: 'enc:Selected',
        lastNameEncrypted: null,
      },
    ],
    assignments: [
      {
        workerId: 'w-inservice',
        serviceId: 's-1',
        vacancyId: 'v-old',
        validFrom: '2026-09-01',
        validTo: null,
        status: 'ACTIVE',
        firstNameEncrypted: 'enc:InService',
        lastNameEncrypted: null,
      },
    ],
    marks: [
      {
        workerId: 'w-rejected',
        serviceId: 's-1',
        rejectReasonCategory: 'OTHER',
        firstNameEncrypted: 'enc:Rejected',
        lastNameEncrypted: null,
      },
    ],
  };
}

/** 2026-09-28T02:30:00Z = 2026-09-27 23:30 em America/Argentina/Buenos_Aires (-03:00). */
const NOW = new Date('2026-09-28T02:30:00Z');

describe('GetServiceTeamUseCase', () => {
  it('leitor devolve null → ServiceTeamNotFoundError', async () => {
    const reader = readerStub(null);
    const { kms } = kmsSpy();
    const useCase = new GetServiceTeamUseCase(reader, kms);

    await expect(
      useCase.execute({ patientId: 'p-1', serviceId: 's-1', cells: null, now: NOW }),
    ).rejects.toThrow(ServiceTeamNotFoundError);
  });

  it('asOf = operationDateOf("AR", now) → 2026-09-27: alocação que começa em 28/09 não conta', async () => {
    const row: ServiceTeamRows = {
      serviceId: 's-1',
      country: 'AR',
      liveVacancyId: 'v-live',
      candidacies: [],
      assignments: [
        {
          workerId: 'w-x',
          serviceId: 's-1',
          vacancyId: 'v-old',
          validFrom: '2026-09-28',
          validTo: null,
          status: 'ACTIVE',
          firstNameEncrypted: null,
          lastNameEncrypted: null,
        },
      ],
      marks: [],
    };
    const reader = readerStub(row);
    const { kms } = kmsSpy();
    const useCase = new GetServiceTeamUseCase(reader, kms);

    const result = await useCase.execute({ patientId: 'p-1', serviceId: 's-1', cells: null, now: NOW });

    expect(result.inService).toEqual([]);
  });

  it('cells com worker_contact:read → displayName preenchido', async () => {
    const reader = readerStub(umRow());
    const { kms } = kmsSpy();
    const useCase = new GetServiceTeamUseCase(reader, kms);

    const result = await useCase.execute({
      patientId: 'p-1',
      serviceId: 's-1',
      cells: [CELL_WORKER_CONTACT_READ],
      now: NOW,
    });

    expect(result.selected[0].displayName).toBe('Selected');
    expect(result.inService[0].displayName).toBe('InService');
    expect(result.rejected[0].displayName).toBe('Rejected');
  });

  it('cells sem worker_contact:read → displayName: null e 0 chamadas ao kms (a projeção decide ANTES do KMS)', async () => {
    const reader = readerStub(umRow());
    const { kms, decrypt } = kmsSpy();
    const useCase = new GetServiceTeamUseCase(reader, kms);

    const result = await useCase.execute({
      patientId: 'p-1',
      serviceId: 's-1',
      cells: ['worker:read'],
      now: NOW,
    });

    expect(decrypt).toHaveBeenCalledTimes(0);
    expect(result.selected[0].displayName).toBeNull();
    expect(result.inService[0].displayName).toBeNull();
    expect(result.rejected[0].displayName).toBeNull();
  });

  it('cells === null (engine OFF) → como hoje, o nome aparece', async () => {
    const reader = readerStub(umRow());
    const { kms } = kmsSpy();
    const useCase = new GetServiceTeamUseCase(reader, kms);

    const result = await useCase.execute({ patientId: 'p-1', serviceId: 's-1', cells: null, now: NOW });

    expect(result.selected[0].displayName).toBe('Selected');
    expect(result.inService[0].displayName).toBe('InService');
    expect(result.rejected[0].displayName).toBe('Rejected');
  });

  it('1 decrypt por prestador DISTINTO das 3 listas — 3 workers, 3 chamadas', async () => {
    const reader = readerStub(umRow());
    const { kms, decrypt } = kmsSpy();
    const useCase = new GetServiceTeamUseCase(reader, kms);

    await useCase.execute({ patientId: 'p-1', serviceId: 's-1', cells: [CELL_WORKER_CONTACT_READ], now: NOW });

    expect(decrypt).toHaveBeenCalledTimes(3);
  });

  it('vacancyId: selected/inService = a vaga da candidatura/alocação; rejected = a vaga viva do serviço', async () => {
    const reader = readerStub(umRow());
    const { kms } = kmsSpy();
    const useCase = new GetServiceTeamUseCase(reader, kms);

    const result = await useCase.execute({ patientId: 'p-1', serviceId: 's-1', cells: null, now: NOW });

    expect(result.vacancyId).toBe('v-live');
    expect(result.selected[0].vacancyId).toBe('v-live');
    expect(result.inService[0].vacancyId).toBe('v-old');
    expect(result.rejected[0].vacancyId).toBe('v-live');
    expect(result.rejected[0].reasonCategory).toBe('OTHER');
  });

  it('a saída não tem chave que case /phone|email|document|diagnos|clinic|address/i (varredura recursiva)', async () => {
    const reader = readerStub(umRow());
    const { kms } = kmsSpy();
    const useCase = new GetServiceTeamUseCase(reader, kms);

    const result = await useCase.execute({ patientId: 'p-1', serviceId: 's-1', cells: null, now: NOW });

    const proibido = /phone|email|document|diagnos|clinic|address/i;
    function varrer(valor: unknown): void {
      if (valor === null || valor === undefined) return;
      if (Array.isArray(valor)) {
        valor.forEach(varrer);
        return;
      }
      if (typeof valor === 'object') {
        for (const [chave, filho] of Object.entries(valor as Record<string, unknown>)) {
          expect(proibido.test(chave)).toBe(false);
          varrer(filho);
        }
      }
    }
    varrer(result);
  });

  it('reader.read chamado exatamente 1× (não reconsulta para derivar o time)', async () => {
    const reader = readerStub(umRow());
    const { kms } = kmsSpy();
    const useCase = new GetServiceTeamUseCase(reader, kms);

    await useCase.execute({ patientId: 'p-1', serviceId: 's-1', cells: null, now: NOW });

    expect(reader.read).toHaveBeenCalledTimes(1);
  });
});
