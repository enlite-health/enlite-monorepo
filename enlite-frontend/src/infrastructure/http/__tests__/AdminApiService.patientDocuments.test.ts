/**
 * AdminApiService — delegação dos 9 métodos de foto/documento/consentimento do paciente
 * (spec 018, PR-4: os 7 originais da rodada B nunca tiveram teste de delegação — achado desta
 * rodada de fecho de furos, 14/09 — + os 2 novos: `listPatientDocuments`/`getVigenteImageConsent`).
 * Sem isto a cobertura do arquivo do diff ficava com essas 9 linhas nunca executadas por teste
 * nenhum. Molde: `AdminApiService.vacancies.test.ts` ("createPatientAddress (delegated)").
 */
import { describe, it, expect, vi } from 'vitest';

const uploadPatientPhoto = vi.fn();
const deletePatientPhoto = vi.fn();
const getPatientPhotoUrl = vi.fn();
const uploadPatientDocument = vi.fn();
const getPatientDocumentUrl = vi.fn();
const listPatientDocuments = vi.fn();
const registerImageConsent = vi.fn();
const revokeImageConsent = vi.fn();
const getVigenteImageConsent = vi.fn();
vi.mock('../AdminPatientPhotoApiService', () => ({
  AdminPatientPhotoApiService: {
    uploadPatientPhoto: (...a: unknown[]) => uploadPatientPhoto(...a),
    deletePatientPhoto: (...a: unknown[]) => deletePatientPhoto(...a),
    getPatientPhotoUrl: (...a: unknown[]) => getPatientPhotoUrl(...a),
    uploadPatientDocument: (...a: unknown[]) => uploadPatientDocument(...a),
    getPatientDocumentUrl: (...a: unknown[]) => getPatientDocumentUrl(...a),
    listPatientDocuments: (...a: unknown[]) => listPatientDocuments(...a),
    registerImageConsent: (...a: unknown[]) => registerImageConsent(...a),
    revokeImageConsent: (...a: unknown[]) => revokeImageConsent(...a),
    getVigenteImageConsent: (...a: unknown[]) => getVigenteImageConsent(...a),
  },
}));

const { AdminApiService } = await import('../AdminApiService');

describe('AdminApiService — patient photo/documents/consent (delegated)', () => {
  it('uploadPatientPhoto delega', async () => {
    const file = new File(['x'], 'foto.jpg', { type: 'image/jpeg' });
    uploadPatientPhoto.mockResolvedValue({ hasPhoto: true });
    await expect(AdminApiService.uploadPatientPhoto('p1', file)).resolves.toEqual({ hasPhoto: true });
    expect(uploadPatientPhoto).toHaveBeenCalledWith('p1', file);
  });

  it('deletePatientPhoto delega', async () => {
    deletePatientPhoto.mockResolvedValue(undefined);
    await expect(AdminApiService.deletePatientPhoto('p1')).resolves.toBeUndefined();
    expect(deletePatientPhoto).toHaveBeenCalledWith('p1');
  });

  it('getPatientPhotoUrl delega', async () => {
    getPatientPhotoUrl.mockResolvedValue({ url: 'https://x', expiresInSeconds: 300 });
    await expect(AdminApiService.getPatientPhotoUrl('p1')).resolves.toEqual({ url: 'https://x', expiresInSeconds: 300 });
    expect(getPatientPhotoUrl).toHaveBeenCalledWith('p1');
  });

  it('uploadPatientDocument delega', async () => {
    const file = new File(['x'], 'doc.pdf', { type: 'application/pdf' });
    uploadPatientDocument.mockResolvedValue({ documentId: 'd1' });
    await expect(AdminApiService.uploadPatientDocument('p1', file, 'image_consent')).resolves.toEqual({ documentId: 'd1' });
    expect(uploadPatientDocument).toHaveBeenCalledWith('p1', file, 'image_consent');
  });

  it('getPatientDocumentUrl delega', async () => {
    getPatientDocumentUrl.mockResolvedValue({ url: 'https://x', expiresInSeconds: 300 });
    await expect(AdminApiService.getPatientDocumentUrl('p1', 'd1')).resolves.toEqual({ url: 'https://x', expiresInSeconds: 300 });
    expect(getPatientDocumentUrl).toHaveBeenCalledWith('p1', 'd1');
  });

  it('listPatientDocuments delega (furo fechado 14/09)', async () => {
    listPatientDocuments.mockResolvedValue([{ id: 'd1' }]);
    await expect(AdminApiService.listPatientDocuments('p1')).resolves.toEqual([{ id: 'd1' }]);
    expect(listPatientDocuments).toHaveBeenCalledWith('p1');
  });

  it('registerImageConsent delega', async () => {
    const payload = { consenterKind: 'PATIENT' as const, textVersion: 'v1', consentedAt: '2026-09-14T00:00:00.000Z' };
    registerImageConsent.mockResolvedValue({ id: 'c1' });
    await expect(AdminApiService.registerImageConsent('p1', payload)).resolves.toEqual({ id: 'c1' });
    expect(registerImageConsent).toHaveBeenCalledWith('p1', payload);
  });

  it('revokeImageConsent delega', async () => {
    revokeImageConsent.mockResolvedValue(undefined);
    await expect(AdminApiService.revokeImageConsent('p1', 'c1', { revocationChannel: 'WRITTEN' })).resolves.toBeUndefined();
    expect(revokeImageConsent).toHaveBeenCalledWith('p1', 'c1', { revocationChannel: 'WRITTEN' });
  });

  it('getVigenteImageConsent delega (furo fechado 14/09)', async () => {
    getVigenteImageConsent.mockResolvedValue(null);
    await expect(AdminApiService.getVigenteImageConsent('p1')).resolves.toBeNull();
    expect(getVigenteImageConsent).toHaveBeenCalledWith('p1');
  });
});
