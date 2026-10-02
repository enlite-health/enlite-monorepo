const mockEncrypt = jest.fn(async (v: string | null) => (v ? `enc:${v}` : null));
const mockDecrypt = jest.fn(async (v: string | null) => (v ? v.replace(/^enc:/, '') : ''));
jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMS_DECRYPT_CONCURRENCY_LIMIT: 10,
  KMSEncryptionService: jest.fn().mockImplementation(() => ({ encrypt: mockEncrypt, decrypt: mockDecrypt })),
}));
const mockWithActorContext = jest.fn();
jest.mock('@shared/database/actorContext', () => ({
  withActorContext: (...args: unknown[]) => mockWithActorContext(...args),
}));
jest.mock('@shared/logging', () => ({ reportError: jest.fn(), logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));

import type { PoolClient } from 'pg';
import { RenamePatientDocumentUseCase } from '../RenamePatientDocumentUseCase';
import { InvalidDocumentLabelError, PatientDocumentNotFoundError } from '../../domain/PatientDocument';
import { POOL, PATIENT_ID, DOC_ID, row, fakeRepository, runWithActorContext } from './patientDocumentTestKit';

const CLIENT = { query: jest.fn() } as unknown as PoolClient;

beforeEach(() => {
  mockWithActorContext.mockReset();
  mockEncrypt.mockClear();
  runWithActorContext(mockWithActorContext, CLIENT, []);
});

describe('RenamePatientDocumentUseCase (FR-013)', () => {
  it.each([['vazio', ''], ['só espaços', '  '], ['256 caracteres', 'a'.repeat(256)]])(
    'nome %s → 400 e o banco nem é tocado (o nome antigo fica)',
    async (_n, label) => {
      const repo = fakeRepository();
      await expect(
        new RenamePatientDocumentUseCase(repo).execute(POOL, { patientId: PATIENT_ID, docId: DOC_ID, actorUid: 'staff:1', label }),
      ).rejects.toBeInstanceOf(InvalidDocumentLabelError);
      expect(mockWithActorContext).not.toHaveBeenCalled();
      expect(repo.renameLabel).not.toHaveBeenCalled();
    },
  );

  it('documento inexistente OU de outro paciente (0 linhas) → 404 e nada é relido', async () => {
    const repo = fakeRepository({ renameLabel: jest.fn(async () => false) });
    await expect(
      new RenamePatientDocumentUseCase(repo).execute(POOL, { patientId: PATIENT_ID, docId: DOC_ID, actorUid: 'staff:1', label: 'Novo' }),
    ).rejects.toBeInstanceOf(PatientDocumentNotFoundError);
    expect(repo.findByPatient).not.toHaveBeenCalled();
  });

  it('feliz: cifra o nome (trim), grava com o ator na transação (trilha de quem renomeou) e devolve o item atualizado', async () => {
    const repo = fakeRepository({
      findByPatient: jest.fn(async () => [row({ labelEncrypted: 'enc:Resumen HC', labelUpdatedAt: new Date('2026-10-02T12:00:00.000Z') })]),
    });

    const out = await new RenamePatientDocumentUseCase(repo).execute(POOL, {
      patientId: PATIENT_ID,
      docId: DOC_ID,
      actorUid: 'staff:9',
      label: '  Resumen HC ',
    });

    expect(repo.renameLabel).toHaveBeenCalledWith(
      { patientId: PATIENT_ID, docId: DOC_ID, labelEncrypted: 'enc:Resumen HC', actorUid: 'staff:9' },
      CLIENT,
    );
    expect(repo.findByPatient).toHaveBeenCalledWith(PATIENT_ID, POOL, DOC_ID);
    expect(out).toMatchObject({ id: DOC_ID, label: 'Resumen HC', labelUpdatedAt: '2026-10-02T12:00:00.000Z' });
  });
});
