/**
 * ConversationAttachmentStorage.test.ts — spec 022, Bloco 3, T309. Molde: `PatientPhotoStorage.ts`
 * (`PatientObjectStorageBase`) — fail-closed sem `PATIENT_DOCUMENTS_BUCKET`, nome UUID + extensão
 * pela `contentType` VALIDADA (nunca a extensão que o cliente mandou).
 */
const PREVIOUS_PATIENT_DOCUMENTS_BUCKET_ENV = process.env.PATIENT_DOCUMENTS_BUCKET;

afterEach(() => {
  if (PREVIOUS_PATIENT_DOCUMENTS_BUCKET_ENV === undefined) delete process.env.PATIENT_DOCUMENTS_BUCKET;
  else process.env.PATIENT_DOCUMENTS_BUCKET = PREVIOUS_PATIENT_DOCUMENTS_BUCKET_ENV;
  jest.resetModules();
});

describe('ConversationAttachmentStorage', () => {
  it('sem PATIENT_DOCUMENTS_BUCKET — lança ConversationAttachmentBucketNotConfiguredError (fail-closed, sem fallback)', async () => {
    delete process.env.PATIENT_DOCUMENTS_BUCKET;
    jest.resetModules();
    const {
      ConversationAttachmentStorage,
      ConversationAttachmentBucketNotConfiguredError,
    } = await import('../ConversationAttachmentStorage');
    expect(() => new ConversationAttachmentStorage()).toThrow(ConversationAttachmentBucketNotConfiguredError);
  });

  it('uploadBuffer gera objectPath com nome UUID + extensão certa por content type', async () => {
    process.env.PATIENT_DOCUMENTS_BUCKET = 'enlite-patient-documents-test';
    jest.resetModules();
    const { ConversationAttachmentStorage } = await import('../ConversationAttachmentStorage');

    const fakeFile = { save: jest.fn().mockResolvedValue(undefined) };
    const fakeBucket = { file: jest.fn().mockReturnValue(fakeFile) };
    const fakeClient = { bucket: jest.fn().mockReturnValue(fakeBucket) } as any;

    const storage = new ConversationAttachmentStorage(fakeClient);
    const result = await storage.uploadBuffer(Buffer.from('conteudo-pdf-sintetico'), 'application/pdf');

    expect(result.objectPath).toMatch(/^[0-9a-f-]{36}\.pdf$/);
    expect(fakeBucket.file).toHaveBeenCalledWith(result.objectPath);
    expect(fakeFile.save).toHaveBeenCalledTimes(1);
    const [, options] = fakeFile.save.mock.calls[0];
    expect(options.metadata.contentType).toBe('application/pdf');
  });

  it.each([
    ['application/pdf', '.pdf'],
    ['image/png', '.png'],
    ['image/jpeg', '.jpg'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.docx'],
  ])('extensão de %s é %s', async (contentType, ext) => {
    process.env.PATIENT_DOCUMENTS_BUCKET = 'enlite-patient-documents-test';
    jest.resetModules();
    const { ConversationAttachmentStorage } = await import('../ConversationAttachmentStorage');
    const fakeFile = { save: jest.fn().mockResolvedValue(undefined) };
    const fakeBucket = { file: jest.fn().mockReturnValue(fakeFile) };
    const fakeClient = { bucket: jest.fn().mockReturnValue(fakeBucket) } as any;
    const storage = new ConversationAttachmentStorage(fakeClient);

    const result = await storage.uploadBuffer(Buffer.from('x'), contentType as any);
    expect(result.objectPath.endsWith(ext)).toBe(true);
  });
});
