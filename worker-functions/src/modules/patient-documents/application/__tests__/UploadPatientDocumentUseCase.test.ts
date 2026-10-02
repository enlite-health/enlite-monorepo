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
const mockLoggerWarn = jest.fn();
jest.mock('@shared/logging', () => ({
  reportError: jest.fn(),
  logger: { warn: (...a: unknown[]) => mockLoggerWarn(...a), info: jest.fn(), error: jest.fn() },
}));

import { createHash } from 'crypto';
import type { PoolClient } from 'pg';
import { UploadPatientDocumentUseCase } from '../UploadPatientDocumentUseCase';
import { AttachmentRejectedError } from '@modules/conversation/application/UploadConversationAttachmentUseCase';
import { InvalidDocumentLabelError, PatientNotFoundError } from '../../domain/PatientDocument';
import type { ConversationAttachmentValidator, AttachmentValidationResult } from '@modules/conversation/infrastructure/ConversationAttachmentValidator';
import type { ConversationAttachmentStorage } from '@modules/conversation/infrastructure/ConversationAttachmentStorage';
import { POOL, PATIENT_ID, DOC_ID, row, fakeRepository, runWithActorContext } from './patientDocumentTestKit';

function fakeValidator(result: AttachmentValidationResult): ConversationAttachmentValidator {
  return { validate: jest.fn(async () => result) } as unknown as ConversationAttachmentValidator;
}
function fakeStorage(overrides: Partial<ConversationAttachmentStorage> = {}): ConversationAttachmentStorage {
  return {
    uploadBuffer: jest.fn(async () => ({ objectPath: 'patient-documents/uuid-1.pdf' })),
    delete: jest.fn(async () => undefined),
    ...overrides,
  } as unknown as ConversationAttachmentStorage;
}

const CONTENT = Buffer.from('conteudo-validado');
const OK = { ok: true, buffer: CONTENT, contentType: 'application/pdf' } as unknown as AttachmentValidationResult;
const PARAMS = { patientId: PATIENT_ID, actorUid: 'staff:1', buffer: Buffer.from('bruto'), originalFilename: 'scan0012.pdf', label: '  DNI frente ' };

beforeEach(() => {
  mockWithActorContext.mockReset();
  mockEncrypt.mockClear();
  mockLoggerWarn.mockClear();
});

describe('UploadPatientDocumentUseCase', () => {
  it('nome inválido → 400 ANTES de validar ou subir qualquer coisa', async () => {
    const storage = fakeStorage();
    const validator = fakeValidator(OK);
    const useCase = new UploadPatientDocumentUseCase(fakeRepository(), validator, () => storage);

    await expect(useCase.execute(POOL, { ...PARAMS, label: '   ' })).rejects.toBeInstanceOf(InvalidDocumentLabelError);
    expect(validator.validate).not.toHaveBeenCalled();
    expect(storage.uploadBuffer).not.toHaveBeenCalled();
  });

  it('paciente inexistente → PatientNotFoundError, nada sobe', async () => {
    const storage = fakeStorage();
    const repo = fakeRepository({ patientExists: jest.fn(async () => false) });
    const useCase = new UploadPatientDocumentUseCase(repo, fakeValidator(OK), () => storage);

    await expect(useCase.execute(POOL, PARAMS)).rejects.toBeInstanceOf(PatientNotFoundError);
    expect(storage.uploadBuffer).not.toHaveBeenCalled();
  });

  it.each([
    ['FILE_TOO_LARGE', 413],
    ['UNSUPPORTED_MEDIA_TYPE', 415],
  ] as const)('validação recusa %s → AttachmentRejectedError %i e NUNCA sobe ao storage (FR-003: no servidor)', async (code, status) => {
    const storage = fakeStorage();
    const useCase = new UploadPatientDocumentUseCase(fakeRepository(), fakeValidator({ ok: false, code, message: 'x' }), () => storage);

    await expect(useCase.execute(POOL, PARAMS)).rejects.toMatchObject({ code, status });
    await expect(useCase.execute(POOL, PARAMS)).rejects.toBeInstanceOf(AttachmentRejectedError);
    expect(storage.uploadBuffer).not.toHaveBeenCalled();
  });

  it('feliz: sobe com o prefixo patient-documents/, cifra caminho+nome+rótulo (trim), grava na transação e devolve o item da lista', async () => {
    const storage = fakeStorage();
    const client = { query: jest.fn() } as unknown as PoolClient;
    const order: string[] = [];
    runWithActorContext(mockWithActorContext, client, order);
    const repo = fakeRepository({
      findByPatient: jest.fn(async () => [row({ id: DOC_ID, labelEncrypted: 'enc:DNI frente' })]),
    });
    const useCase = new UploadPatientDocumentUseCase(repo, fakeValidator(OK), () => storage);

    const out = await useCase.execute(POOL, PARAMS);

    expect(storage.uploadBuffer).toHaveBeenCalledWith(CONTENT, 'application/pdf', 'patient-documents');
    expect(repo.insertTabDocument).toHaveBeenCalledWith(
      {
        patientId: PATIENT_ID,
        labelEncrypted: 'enc:DNI frente',
        filePathEncrypted: 'enc:patient-documents/uuid-1.pdf',
        originalNameEncrypted: 'enc:scan0012.pdf',
        contentType: 'application/pdf',
        sizeBytes: CONTENT.byteLength,
        sha256: createHash('sha256').update(CONTENT).digest(),
        createdByUid: 'staff:1',
      },
      client,
    );
    expect(repo.findByPatient).toHaveBeenCalledWith(PATIENT_ID, POOL, DOC_ID);
    expect(out).toMatchObject({ id: DOC_ID, origin: 'tab', label: 'DNI frente' });
    expect(order).toEqual(['tx:begin', 'tx:commit']);
  });

  it('INSERT falhou → apaga o objeto novo (órfão) e relança; falha ao apagar vira log SÓ com o código, sem caminho', async () => {
    const storage = fakeStorage({
      delete: jest.fn(async () => {
        throw Object.assign(new Error('No such object: bucket/patient-documents/uuid-1.pdf'), { code: 503 });
      }),
    });
    const client = { query: jest.fn() } as unknown as PoolClient;
    runWithActorContext(mockWithActorContext, client, []);
    const repo = fakeRepository({
      insertTabDocument: jest.fn(async () => {
        throw new Error('db caiu');
      }),
    });
    const useCase = new UploadPatientDocumentUseCase(repo, fakeValidator(OK), () => storage);

    await expect(useCase.execute(POOL, PARAMS)).rejects.toThrow('db caiu');

    expect(storage.delete).toHaveBeenCalledWith('patient-documents/uuid-1.pdf');
    expect(mockLoggerWarn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockLoggerWarn.mock.calls)).not.toContain('uuid-1');
    expect(JSON.stringify(mockLoggerWarn.mock.calls)).not.toContain('scan0012');
  });
});
