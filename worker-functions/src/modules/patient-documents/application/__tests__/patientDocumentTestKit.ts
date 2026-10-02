/**
 * Kit de teste dos use cases de documentos do paciente (spec 031) — NÃO é suíte (sem `.test.ts`).
 * Mesmo molde dos testes irmãos do chat: `withActorContext` mockado (o `fn` roda com um client
 * fake e a ordem das chamadas fica registrada), KMS mockado por módulo (prefixo `enc:`).
 */
import type { Pool, PoolClient } from 'pg';
import type { PatientDocumentRepository, PatientDocumentRow } from '../../infrastructure/PatientDocumentRepository';

export const POOL = {} as unknown as Pool;
export const PATIENT_ID = '11111111-1111-1111-1111-111111111111';
export const DOC_ID = '22222222-2222-2222-2222-222222222222';

export function row(overrides: Partial<PatientDocumentRow> = {}): PatientDocumentRow {
  return {
    id: DOC_ID,
    origin: 'tab',
    labelEncrypted: 'enc:DNI frente',
    contentType: 'application/pdf',
    sizeBytes: 2048,
    createdByUid: 'staff:1',
    createdByDisplayName: 'Ana',
    createdAt: new Date('2026-10-02T10:00:00.000Z'),
    labelUpdatedAt: null,
    ...overrides,
  };
}

export function fakeRepository(overrides: Partial<Record<keyof PatientDocumentRepository, jest.Mock>> = {}) {
  const repo = {
    patientExists: jest.fn(async () => true),
    findByPatient: jest.fn(async () => [] as PatientDocumentRow[]),
    insertTabDocument: jest.fn(async () => ({ id: DOC_ID })),
    insertFromChatAttachments: jest.fn(async () => 0),
    renameLabel: jest.fn(async () => true),
    deleteDocument: jest.fn(async () => null),
    findFileLocation: jest.fn(async () => null),
    ...overrides,
  };
  return repo as unknown as PatientDocumentRepository & typeof repo;
}

/** `withActorContext` fake: roda `fn` com `client`, anotando `tx:begin` / `tx:commit` (ou `tx:rollback`) em `order`. */
export function runWithActorContext(mock: jest.Mock, client: PoolClient, order: string[]) {
  mock.mockImplementation(async (_pool: Pool, fn: (c: PoolClient) => Promise<unknown>) => {
    order.push('tx:begin');
    try {
      const out = await fn(client);
      order.push('tx:commit');
      return out;
    } catch (err) {
      order.push('tx:rollback');
      throw err;
    }
  });
}
