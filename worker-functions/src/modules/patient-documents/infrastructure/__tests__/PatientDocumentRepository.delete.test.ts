/**
 * PatientDocumentRepository.deleteDocument — origem `admission` (spec 049, A1-7): o arquivo é da própria linha
 * (como `tab`), então a exclusão devolve o caminho cifrado e NÃO toca `stored_files` (esse UPDATE é só do `chat`).
 * Texto sintético.
 */
import type { PoolClient } from 'pg';
import { PatientDocumentRepository } from '../PatientDocumentRepository';

function fakeClient(deletedRow: Record<string, unknown> | null) {
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('DELETE FROM patient_documents')) return { rows: deletedRow ? [deletedRow] : [], rowCount: deletedRow ? 1 : 0 };
    return { rows: [], rowCount: 0 };
  });
  return { client: { query } as unknown as PoolClient, query };
}

const touchesStoredFiles = (query: jest.Mock) => query.mock.calls.some(([sql]) => String(sql).includes('stored_files'));

describe('PatientDocumentRepository.deleteDocument', () => {
  it('origem admission: devolve origin admission + caminho cifrado e não toca stored_files', async () => {
    const { client, query } = fakeClient({ origin: 'admission', storedFileId: null, filePathEncrypted: 'enc:patient-documents/r.pdf' });
    const out = await new PatientDocumentRepository().deleteDocument('p1', 'd1', client);
    expect(out).toEqual({ origin: 'admission', storedFileId: null, pathEncrypted: 'enc:patient-documents/r.pdf' });
    expect(touchesStoredFiles(query)).toBe(false);
  });

  it('origem tab: igual (regressão)', async () => {
    const { client, query } = fakeClient({ origin: 'tab', storedFileId: null, filePathEncrypted: 'enc:a.pdf' });
    const out = await new PatientDocumentRepository().deleteDocument('p1', 'd1', client);
    expect(out).toEqual({ origin: 'tab', storedFileId: null, pathEncrypted: 'enc:a.pdf' });
    expect(touchesStoredFiles(query)).toBe(false);
  });

  it('origem chat: marca stored_files e devolve o caminho de lá', async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('DELETE FROM patient_documents')) return { rows: [{ origin: 'chat', storedFileId: 'sf-1', filePathEncrypted: null }], rowCount: 1 };
      if (sql.includes('UPDATE stored_files')) return { rows: [{ pathEncrypted: 'enc:chat.pdf' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const out = await new PatientDocumentRepository().deleteDocument('p1', 'd1', { query } as unknown as PoolClient);
    expect(out).toEqual({ origin: 'chat', storedFileId: 'sf-1', pathEncrypted: 'enc:chat.pdf' });
    expect(touchesStoredFiles(query)).toBe(true);
  });

  it('inexistente → null', async () => {
    const { client } = fakeClient(null);
    expect(await new PatientDocumentRepository().deleteDocument('p1', 'd1', client)).toBeNull();
  });
});
