jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: jest.fn(async () => ({ rows: [] })) }) }) },
}));

import { ListPatientDocumentsUseCase } from '../ListPatientDocumentsUseCase';

const PID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('ListPatientDocumentsUseCase', () => {
  it('devolve lista vazia quando o paciente não tem documento', async () => {
    const repo = { listForPatient: jest.fn(async () => []) };
    const uc = new ListPatientDocumentsUseCase(repo as never);
    const result = await uc.execute(PID);
    expect(result).toEqual([]);
    expect(repo.listForPatient).toHaveBeenCalledWith(PID);
  });

  it('mapeia as colunas do repositório para o formato de saída, SEM url/objectPath', async () => {
    const row = {
      id: 'doc-1',
      patient_id: PID,
      document_type: 'image_consent',
      object_path_encrypted: 'segredo-cifrado',
      content_type: 'application/pdf',
      size_bytes: 123,
      sha256: 'abc',
      uploaded_by: 'uid-1',
      uploaded_at: '2026-09-14T10:00:00.000Z',
    };
    const repo = { listForPatient: jest.fn(async () => [row]) };
    const uc = new ListPatientDocumentsUseCase(repo as never);
    const result = await uc.execute(PID);
    expect(result).toEqual([
      { id: 'doc-1', documentType: 'image_consent', contentType: 'application/pdf', sizeBytes: 123, uploadedAt: '2026-09-14T10:00:00.000Z' },
    ]);
    // Trava de regressão: nunca vaza objectPathEncrypted nem qualquer campo de URL/caminho de storage.
    expect(JSON.stringify(result)).not.toMatch(/object_path|objectPath|segredo-cifrado|url/i);
  });

  it('ordena por uploaded_at DESC (mais recente primeiro), sem mutar o array do repositório', async () => {
    const older = { id: 'doc-old', patient_id: PID, document_type: 'image_consent', object_path_encrypted: 'x', content_type: 'application/pdf', size_bytes: 1, sha256: 'a', uploaded_by: 'u', uploaded_at: '2026-09-01T00:00:00.000Z' };
    const newer = { id: 'doc-new', patient_id: PID, document_type: 'image_consent_revocation', object_path_encrypted: 'y', content_type: 'image/jpeg', size_bytes: 2, sha256: 'b', uploaded_by: 'u', uploaded_at: '2026-09-10T00:00:00.000Z' };
    const rows = [older, newer];
    const repo = { listForPatient: jest.fn(async () => rows) };
    const uc = new ListPatientDocumentsUseCase(repo as never);
    const result = await uc.execute(PID);
    expect(result.map((r) => r.id)).toEqual(['doc-new', 'doc-old']);
    expect(rows).toEqual([older, newer]); // array original do repo não foi reordenado in-place
  });

  it('constrói pelo DEFAULT do construtor (caminho de produção)', () => {
    // eslint-disable-next-line no-new
    new ListPatientDocumentsUseCase();
  });
});
