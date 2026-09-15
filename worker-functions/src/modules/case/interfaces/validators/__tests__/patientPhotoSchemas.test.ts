import {
  patientIdParamsSchema,
  patientDocumentIdParamsSchema,
  patientConsentIdParamsSchema,
  registerImageConsentSchema,
  revokeImageConsentSchema,
  uploadDocumentBodySchema,
} from '../patientPhotoSchemas';

const PID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('patientPhotoSchemas (spec 018 PR-4)', () => {
  it('patientIdParamsSchema — UUID válido passa, resto falha', () => {
    expect(patientIdParamsSchema.safeParse({ id: PID }).success).toBe(true);
    expect(patientIdParamsSchema.safeParse({ id: 'x' }).success).toBe(false);
  });

  it('patientDocumentIdParamsSchema — 2 UUIDs', () => {
    expect(patientDocumentIdParamsSchema.safeParse({ id: PID, documentId: PID }).success).toBe(true);
    expect(patientDocumentIdParamsSchema.safeParse({ id: PID, documentId: 'x' }).success).toBe(false);
  });

  it('patientConsentIdParamsSchema — id + cid', () => {
    expect(patientConsentIdParamsSchema.safeParse({ id: PID, cid: PID }).success).toBe(true);
    expect(patientConsentIdParamsSchema.safeParse({ id: PID, cid: 'x' }).success).toBe(false);
  });

  describe('registerImageConsentSchema (documentId OPCIONAL — decisão 14/09)', () => {
    it('mínimo válido: PATIENT, sem documentId', () => {
      const r = registerImageConsentSchema.safeParse({ consenterKind: 'PATIENT', textVersion: 'v1', consentedAt: '2026-09-14T10:00:00Z' });
      expect(r.success).toBe(true);
    });
    it('REPRESENTATIVE com todos os campos opcionais preenchidos', () => {
      const r = registerImageConsentSchema.safeParse({
        consenterKind: 'REPRESENTATIVE',
        responsibleId: PID,
        documentId: PID,
        textVersion: 'v1',
        consentedAt: '2026-09-14T10:00:00Z',
        representationBasis: 'GUARDIAN_DESIGNATION',
        representationVerifiedBy: 'uid-1',
      });
      expect(r.success).toBe(true);
    });
    it('rejeita consenterKind inválido', () => {
      expect(registerImageConsentSchema.safeParse({ consenterKind: 'OTHER', textVersion: 'v1', consentedAt: '2026-09-14T10:00:00Z' }).success).toBe(false);
    });
    it('rejeita campo a mais (.strict())', () => {
      expect(
        registerImageConsentSchema.safeParse({ consenterKind: 'PATIENT', textVersion: 'v1', consentedAt: '2026-09-14T10:00:00Z', extra: 1 }).success,
      ).toBe(false);
    });
    it('rejeita textVersion vazio', () => {
      expect(registerImageConsentSchema.safeParse({ consenterKind: 'PATIENT', textVersion: '', consentedAt: '2026-09-14T10:00:00Z' }).success).toBe(false);
    });
  });

  describe('revokeImageConsentSchema (revocationDocumentId OPCIONAL)', () => {
    it('só o canal — válido', () => {
      expect(revokeImageConsentSchema.safeParse({ revocationChannel: 'PHONE' }).success).toBe(true);
    });
    it('com revocationDocumentId', () => {
      expect(revokeImageConsentSchema.safeParse({ revocationChannel: 'WRITTEN', revocationDocumentId: PID }).success).toBe(true);
    });
    it('rejeita canal inválido', () => {
      expect(revokeImageConsentSchema.safeParse({ revocationChannel: 'FAX' }).success).toBe(false);
    });
    it('rejeita sem canal', () => {
      expect(revokeImageConsentSchema.safeParse({}).success).toBe(false);
    });
  });

  describe('uploadDocumentBodySchema', () => {
    it('aceita os 2 tipos fechados', () => {
      expect(uploadDocumentBodySchema.safeParse({ documentType: 'image_consent' }).success).toBe(true);
      expect(uploadDocumentBodySchema.safeParse({ documentType: 'image_consent_revocation' }).success).toBe(true);
    });
    it('rejeita tipo fora da lista', () => {
      expect(uploadDocumentBodySchema.safeParse({ documentType: 'anything' }).success).toBe(false);
    });
  });
});
