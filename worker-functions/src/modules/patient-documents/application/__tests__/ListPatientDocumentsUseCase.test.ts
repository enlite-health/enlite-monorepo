const mockDecrypt = jest.fn(async (v: string | null) => (v ? v.replace(/^enc:/, '') : ''));
jest.mock('@shared/security/KMSEncryptionService', () => ({
  KMS_DECRYPT_CONCURRENCY_LIMIT: 10,
  KMSEncryptionService: jest.fn().mockImplementation(() => ({ decrypt: mockDecrypt })),
}));
const mockReportError = jest.fn();
jest.mock('@shared/logging', () => ({
  reportError: (...args: unknown[]) => mockReportError(...args),
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() },
}));

import { ListPatientDocumentsUseCase } from '../ListPatientDocumentsUseCase';
import { PatientNotFoundError } from '../../domain/PatientDocument';
import { POOL, PATIENT_ID, DOC_ID, row, fakeRepository } from './patientDocumentTestKit';

beforeEach(() => {
  mockDecrypt.mockClear();
  mockReportError.mockClear();
});

describe('ListPatientDocumentsUseCase', () => {
  it('paciente inexistente (ou de outro país, RLS) → PatientNotFoundError, nunca lista', async () => {
    const repo = fakeRepository({ patientExists: jest.fn(async () => false) });
    await expect(new ListPatientDocumentsUseCase(repo).execute(POOL, PATIENT_ID)).rejects.toBeInstanceOf(PatientNotFoundError);
    expect(repo.findByPatient).not.toHaveBeenCalled();
  });

  it('lista vazia → [] (estado vazio é só "não há documento")', async () => {
    const repo = fakeRepository();
    await expect(new ListPatientDocumentsUseCase(repo).execute(POOL, PATIENT_ID)).resolves.toEqual([]);
  });

  it('decifra o rótulo, serializa datas em ISO e preserva a ordem do repositório (FR-004)', async () => {
    const repo = fakeRepository({
      findByPatient: jest.fn(async () => [
        row({ id: 'd2', origin: 'chat', labelEncrypted: 'enc:resumen.pdf', createdAt: new Date('2026-10-02T11:00:00.000Z'), labelUpdatedAt: new Date('2026-10-02T12:00:00.000Z') }),
        row({ id: 'd1' }),
      ]),
    });

    const out = await new ListPatientDocumentsUseCase(repo).execute(POOL, PATIENT_ID);

    expect(out.map((d) => d.id)).toEqual(['d2', 'd1']);
    expect(out[0]).toEqual({
      id: 'd2',
      origin: 'chat',
      label: 'resumen.pdf',
      contentType: 'application/pdf',
      sizeBytes: 2048,
      createdAt: '2026-10-02T11:00:00.000Z',
      createdByUid: 'staff:1',
      createdByDisplayName: 'Ana',
      labelUpdatedAt: '2026-10-02T12:00:00.000Z',
    });
    expect(out[1].labelUpdatedAt).toBeNull();
    expect(repo.findByPatient).toHaveBeenCalledWith(PATIENT_ID, POOL);
  });

  it('falha de KMS num item isola SÓ aquele (label null) e reporta só o UUID — nunca o nome', async () => {
    mockDecrypt.mockImplementationOnce(async () => {
      throw new Error('Failed to decrypt data');
    });
    const repo = fakeRepository({
      findByPatient: jest.fn(async () => [row({ id: 'd-ruim', labelEncrypted: 'enc:SEGREDO' }), row({ id: DOC_ID })]),
    });

    const out = await new ListPatientDocumentsUseCase(repo).execute(POOL, PATIENT_ID);

    expect(out.map((d) => d.label)).toEqual([null, 'DNI frente']);
    expect(mockReportError).toHaveBeenCalledTimes(1);
    const ctx = mockReportError.mock.calls[0][1];
    expect(ctx).toMatchObject({ documentId: 'd-ruim' });
    expect(JSON.stringify(ctx)).not.toContain('SEGREDO');
  });
});
