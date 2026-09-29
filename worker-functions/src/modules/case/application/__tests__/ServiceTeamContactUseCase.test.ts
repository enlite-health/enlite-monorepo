/**
 * ServiceTeamContactUseCase — modal do prestador (quadro C, rodada 2, decisão D). `reader`,
 * `contactRepo`, `kms` e `runInTransaction` injetados — sem banco real (molde
 * `ServiceTeamMarkUseCase.test.ts`).
 */
import {
  GetServiceTeamContactUseCase,
  RegisterServiceTeamContactUseCase,
  ServiceTeamContactNotFoundError,
  type ServiceTeamContactReaderPort,
  type ServiceTeamContactRepoPort,
} from '../ServiceTeamContactUseCase';
import type { ServiceTeamRows } from '../../infrastructure/ServiceTeamReader';
import type { ServiceTeamContactLogRow } from '../../infrastructure/ServiceTeamContactLogRepository';
import { CELL_WORKER_CONTACT_READ, NOME_REDIGIDO, type Decryptor } from '@modules/identity/permissions';

const FAKE_CLIENT = { marker: 'fake-client' } as never;

type RunInTransaction = ConstructorParameters<typeof GetServiceTeamContactUseCase>[3];

function runInTransactionStub(): RunInTransaction & jest.Mock {
  const fn = jest.fn((cb: (client: unknown) => Promise<unknown>) => cb(FAKE_CLIENT));
  return fn as unknown as RunInTransaction & jest.Mock;
}

function kmsSpy(): { kms: Decryptor; decrypt: jest.Mock } {
  const decrypt = jest.fn(async (c?: string | null) => String(c ?? '').replace(/^enc:/, ''));
  return { kms: { decrypt }, decrypt };
}

const ROW_WITH_SELECTED: ServiceTeamRows = {
  serviceId: 's-1',
  country: 'AR',
  liveVacancyId: 'v-live',
  candidacies: [
    { workerId: 'w-1', vacancyId: 'v-live', stage: 'QUICK_RESPONSE_TEAM', firstNameEncrypted: 'enc:Marcel', lastNameEncrypted: 'enc:Araujo' },
  ],
  assignments: [],
  marks: [],
};

const HISTORY: ServiceTeamContactLogRow[] = [
  { id: 'c-1', serviceId: 's-1', workerId: 'w-1', contacted: true, eventDate: '2026-09-29', note: 'Confirmou', createdBy: 'u-1', createdAt: '2026-09-29T10:00:00Z' },
];

function readerStub(row: ServiceTeamRows | null): ServiceTeamContactReaderPort {
  return { readWith: jest.fn().mockResolvedValue(row) };
}

function contactRepoStub(opts: { history?: ServiceTeamContactLogRow[]; workerRow?: { id: string; firstNameEncrypted: string | null; lastNameEncrypted: string | null; whatsappPhoneEncrypted: string | null } | null } = {}): ServiceTeamContactRepoPort & { insert: jest.Mock } {
  return {
    listForPair: jest.fn().mockResolvedValue(opts.history ?? []),
    insert: jest.fn().mockResolvedValue(undefined),
    getWorkerContactRow: jest.fn().mockResolvedValue(
      opts.workerRow ?? { id: 'w-1', firstNameEncrypted: 'enc:Marcel', lastNameEncrypted: 'enc:Araujo', whatsappPhoneEncrypted: 'enc:+5511900000000' },
    ),
  };
}

describe('GetServiceTeamContactUseCase', () => {
  it('leitor devolve null → ServiceTeamContactNotFoundError (não distingue "sem serviço" de "sem worker")', async () => {
    const reader = readerStub(null);
    const contactRepo = contactRepoStub();
    const { kms } = kmsSpy();
    const useCase = new GetServiceTeamContactUseCase(reader, contactRepo, kms, runInTransactionStub());

    await expect(
      useCase.execute({ patientId: 'p-1', serviceId: 's-1', workerId: 'w-1', cells: null }),
    ).rejects.toThrow(ServiceTeamContactNotFoundError);
  });

  it('worker fora das 3 listas do time (nunca fez parte) → ServiceTeamContactNotFoundError', async () => {
    const reader = readerStub(ROW_WITH_SELECTED);
    const contactRepo = contactRepoStub();
    const { kms } = kmsSpy();
    const useCase = new GetServiceTeamContactUseCase(reader, contactRepo, kms, runInTransactionStub());

    await expect(
      useCase.execute({ patientId: 'p-1', serviceId: 's-1', workerId: 'w-estranho', cells: null }),
    ).rejects.toThrow(ServiceTeamContactNotFoundError);
    expect(contactRepo.getWorkerContactRow).not.toHaveBeenCalled();
  });

  it('worker no time + cells=null (engine off) → nome/telefone projetados (comportamento pré-engine), histórico devolvido', async () => {
    const reader = readerStub(ROW_WITH_SELECTED);
    const contactRepo = contactRepoStub({ history: HISTORY });
    const { kms } = kmsSpy();
    const useCase = new GetServiceTeamContactUseCase(reader, contactRepo, kms, runInTransactionStub());

    const result = await useCase.execute({ patientId: 'p-1', serviceId: 's-1', workerId: 'w-1', cells: null });

    expect(result.workerId).toBe('w-1');
    expect(result.displayName).toBe('Marcel Araujo');
    expect(result.phone).toBe('+5511900000000');
    expect(result.history).toEqual([{ id: 'c-1', contacted: true, eventDate: '2026-09-29', note: 'Confirmou', createdAt: '2026-09-29T10:00:00Z' }]);
  });

  it('worker no time SEM worker_contact:read → displayName redigido ("Contato restrito", NOME_REDIGIDO), phone null; KMS nunca chamado (C3)', async () => {
    const reader = readerStub(ROW_WITH_SELECTED);
    const contactRepo = contactRepoStub();
    const { kms, decrypt } = kmsSpy();
    const useCase = new GetServiceTeamContactUseCase(reader, contactRepo, kms, runInTransactionStub());

    const result = await useCase.execute({ patientId: 'p-1', serviceId: 's-1', workerId: 'w-1', cells: [] });

    expect(result.displayName).toBe(NOME_REDIGIDO);
    expect(result.phone).toBeNull();
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('COM worker_contact:read (cells inclui a célula) → telefone sai', async () => {
    const reader = readerStub(ROW_WITH_SELECTED);
    const contactRepo = contactRepoStub();
    const { kms } = kmsSpy();
    const useCase = new GetServiceTeamContactUseCase(reader, contactRepo, kms, runInTransactionStub());

    const result = await useCase.execute({ patientId: 'p-1', serviceId: 's-1', workerId: 'w-1', cells: [CELL_WORKER_CONTACT_READ] });

    expect(result.phone).toBe('+5511900000000');
  });
});

describe('RegisterServiceTeamContactUseCase', () => {
  it('worker fora do time → ServiceTeamContactNotFoundError; insert NUNCA chamado (autorização antes da escrita)', async () => {
    const reader = readerStub(ROW_WITH_SELECTED);
    const contactRepo = contactRepoStub();
    const { kms } = kmsSpy();
    const useCase = new RegisterServiceTeamContactUseCase(reader, contactRepo, kms, runInTransactionStub());

    await expect(
      useCase.execute({
        patientId: 'p-1', serviceId: 's-1', workerId: 'w-estranho', contacted: true, eventDate: '2026-09-29',
        note: 'nota', actorUid: 'u-1', cells: null,
      }),
    ).rejects.toThrow(ServiceTeamContactNotFoundError);
    expect(contactRepo.insert).not.toHaveBeenCalled();
  });

  it('worker no time → insert com os campos certos, devolve o histórico recalculado (relido, não devolvido pelo insert)', async () => {
    const reader = readerStub(ROW_WITH_SELECTED);
    const contactRepo = contactRepoStub({ history: HISTORY });
    const { kms } = kmsSpy();
    const useCase = new RegisterServiceTeamContactUseCase(reader, contactRepo, kms, runInTransactionStub());

    const result = await useCase.execute({
      patientId: 'p-1', serviceId: 's-1', workerId: 'w-1', contacted: true, eventDate: '2026-09-29',
      note: 'Ligou e confirmou', actorUid: 'staff:u-1', cells: [CELL_WORKER_CONTACT_READ],
    });

    expect(contactRepo.insert).toHaveBeenCalledWith(FAKE_CLIENT, {
      serviceId: 's-1', workerId: 'w-1', contacted: true, eventDate: '2026-09-29', note: 'Ligou e confirmou', actorUid: 'staff:u-1',
    });
    expect(result.history).toHaveLength(1);
    expect(result.phone).toBe('+5511900000000');
  });

  it('note null é aceito e repassado como null pro insert (Notas é opcional)', async () => {
    const reader = readerStub(ROW_WITH_SELECTED);
    const contactRepo = contactRepoStub();
    const { kms } = kmsSpy();
    const useCase = new RegisterServiceTeamContactUseCase(reader, contactRepo, kms, runInTransactionStub());

    await useCase.execute({
      patientId: 'p-1', serviceId: 's-1', workerId: 'w-1', contacted: false, eventDate: '2026-09-29',
      note: null, actorUid: 'staff:u-1', cells: null,
    });

    expect(contactRepo.insert).toHaveBeenCalledWith(FAKE_CLIENT, expect.objectContaining({ note: null }));
  });

  it('a transação é UMA só (runInTransaction chamado 1×) — autorização, escrita e releitura no MESMO client', async () => {
    const reader = readerStub(ROW_WITH_SELECTED);
    const contactRepo = contactRepoStub();
    const { kms } = kmsSpy();
    const runInTransaction = runInTransactionStub();
    const useCase = new RegisterServiceTeamContactUseCase(reader, contactRepo, kms, runInTransaction);

    await useCase.execute({
      patientId: 'p-1', serviceId: 's-1', workerId: 'w-1', contacted: true, eventDate: '2026-09-29',
      note: null, actorUid: 'u-1', cells: null,
    });

    expect(runInTransaction).toHaveBeenCalledTimes(1);
    expect((reader.readWith as jest.Mock).mock.calls[0][0]).toBe(FAKE_CLIENT);
    expect(contactRepo.insert.mock.calls[0][0]).toBe(FAKE_CLIENT);
  });
});
