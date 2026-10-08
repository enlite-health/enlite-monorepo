/**
 * deletePatientAddress — regra de remoção de Localización (spec 044, D4).
 * `withActorContext` é mockado para entregar o client falso (a transação real é dele; aqui vale a LÓGICA).
 * Endereços de ficção; nenhum texto de endereço participa.
 */
const mockQuery = jest.fn();
jest.mock('@shared/database/actorContext', () => ({
  withActorContext: jest.fn(async (_pool: unknown, fn: (c: unknown) => Promise<unknown>) => fn({ query: mockQuery })),
}));
const mockLogDeleted = jest.fn();
jest.mock('../PatientAddressAuditRepository', () => ({
  ...jest.requireActual('../PatientAddressAuditRepository'),
  PatientAddressAuditRepository: jest.fn().mockImplementation(() => ({ logDeleted: (...a: unknown[]) => mockLogDeleted(...a) })),
}));

import type { Pool } from 'pg';
import { deletePatientAddress } from '../deletePatientAddress';

const POOL = {} as Pool;
const INPUT = { patientId: 'pat-1', addressId: 'addr-1', actorUserId: 'uid-1', traceId: 'trace-1' };
const LINHA = { id: 'addr-1', address_type: 'casa_madre', neighborhood: 'Barrio Ficticio', is_default: false };

/** Roteia cada SQL para uma resposta; SQL não roteado falha o teste (não responde por chute). */
function roteia(r: { found?: unknown[]; others?: number; refs?: { vacancies: number; services: number }; deleteError?: unknown }) {
  mockQuery.mockImplementation(async (sql: string) => {
    if (/FOR UPDATE/.test(sql)) return { rows: r.found ?? [], rowCount: (r.found ?? []).length };
    if (/id <> \$2/.test(sql)) return { rows: [], rowCount: r.others ?? 0 };
    if (/count\(\*\)/.test(sql)) return { rows: [r.refs ?? { vacancies: 0, services: 0 }], rowCount: 1 };
    if (/^\s*DELETE FROM patient_addresses/.test(sql)) {
      if (r.deleteError) throw r.deleteError;
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`SQL inesperado: ${sql}`);
  });
}
const sqls = () => mockQuery.mock.calls.map((c) => String(c[0]));

describe('deletePatientAddress', () => {
  beforeEach(() => { jest.clearAllMocks(); mockLogDeleted.mockResolvedValue(undefined); });

  it('404 (not_found): linha inexistente / de outro paciente / arquivada — nada é apagado nem auditado', async () => {
    roteia({ found: [] });
    await expect(deletePatientAddress(POOL, INPUT)).resolves.toEqual({ kind: 'not_found' });
    expect(sqls().some((s) => /DELETE FROM/.test(s))).toBe(false);
    expect(mockLogDeleted).not.toHaveBeenCalled();
    // a busca trava a linha, é do paciente e só vê endereço vivo
    expect(sqls()[0]).toMatch(/FOR UPDATE/);
    expect(sqls()[0]).toMatch(/patient_id = \$2/);
    expect(sqls()[0]).toMatch(/archived_at IS NULL/);
  });

  it('A7: Principal com OUTRO endereço ativo → primary_with_others, sem DELETE', async () => {
    roteia({ found: [{ ...LINHA, is_default: true }], others: 1 });
    await expect(deletePatientAddress(POOL, INPUT)).resolves.toEqual({ kind: 'primary_with_others' });
    expect(sqls().some((s) => /DELETE FROM/.test(s))).toBe(false);
    expect(mockLogDeleted).not.toHaveBeenCalled();
  });

  it('A7: Principal SOZINHO (nenhum outro ativo) pode ser removido', async () => {
    roteia({ found: [{ ...LINHA, is_default: true }], others: 0 });
    await expect(deletePatientAddress(POOL, INPUT)).resolves.toEqual({ kind: 'deleted' });
    expect(mockLogDeleted).toHaveBeenCalledTimes(1);
  });

  it('A4/A4b/A5: com vaga (qualquer status, inclusive soft-deleted) → in_use com os números; contagem SEM filtro', async () => {
    roteia({ found: [LINHA], refs: { vacancies: 2, services: 0 } });
    await expect(deletePatientAddress(POOL, INPUT)).resolves.toEqual({ kind: 'in_use', vacancies: 2, services: 0 });
    const contagem = sqls().find((s) => /count\(\*\)/.test(s))!;
    expect(contagem).toMatch(/FROM job_postings WHERE patient_address_id = \$1/);
    expect(contagem).toMatch(/FROM patient_contracted_services WHERE address_id = \$1/);
    expect(contagem).not.toMatch(/status|deleted_at|active/);
    expect(sqls().some((s) => /DELETE FROM/.test(s))).toBe(false);
    expect(mockLogDeleted).not.toHaveBeenCalled();
  });

  it('A5: só serviço (inativo ou não) apontando → in_use', async () => {
    roteia({ found: [LINHA], refs: { vacancies: 0, services: 1 } });
    await expect(deletePatientAddress(POOL, INPUT)).resolves.toEqual({ kind: 'in_use', vacancies: 0, services: 1 });
  });

  it('A6/A9: sem referência → DELETE físico + auditoria (ator, patient, changes sem texto) na mesma transação (mesmo client)', async () => {
    roteia({ found: [LINHA] });
    await expect(deletePatientAddress(POOL, INPUT)).resolves.toEqual({ kind: 'deleted' });
    const del = mockQuery.mock.calls.find((c) => /^\s*DELETE FROM patient_addresses/.test(String(c[0])))!;
    expect(del[1]).toEqual(['addr-1', 'pat-1']);
    expect(mockLogDeleted).toHaveBeenCalledWith(
      { query: mockQuery },
      {
        patientId: 'pat-1',
        changes: { before: { address_id: 'addr-1', address_type: 'casa_madre', neighborhood: 'Barrio Ficticio' }, after: null },
        actorUserId: 'uid-1',
        traceId: 'trace-1',
      },
    );
  });

  it('sem traceId na entrada, a trilha recebe null', async () => {
    roteia({ found: [LINHA] });
    await deletePatientAddress(POOL, { patientId: 'pat-1', addressId: 'addr-1', actorUserId: null });
    expect(mockLogDeleted.mock.calls[0][1]).toMatchObject({ actorUserId: null, traceId: null });
  });

  it('se a auditoria falha, o erro sobe (a transação desfaz o DELETE) — não vira deleted', async () => {
    roteia({ found: [LINHA] });
    mockLogDeleted.mockRejectedValueOnce(new Error('audit falhou'));
    await expect(deletePatientAddress(POOL, INPUT)).rejects.toThrow('audit falhou');
  });

  it('corrida: 23503 da FK no DELETE + recontagem acha referência → in_use com os números (nunca 500)', async () => {
    let contagens = 0;
    mockQuery.mockImplementation(async (sql: string) => {
      if (/FOR UPDATE/.test(sql)) return { rows: [LINHA], rowCount: 1 };
      if (/count\(\*\)/.test(sql)) return { rows: [contagens++ === 0 ? { vacancies: 0, services: 0 } : { vacancies: 1, services: 0 }], rowCount: 1 };
      if (/^\s*DELETE FROM patient_addresses/.test(sql)) throw Object.assign(new Error('fk'), { code: '23503' });
      throw new Error(`SQL inesperado: ${sql}`);
    });
    await expect(deletePatientAddress(POOL, INPUT)).resolves.toEqual({ kind: 'in_use', vacancies: 1, services: 0 });
  });

  it('23503 SEM referência na recontagem (ex.: FK do ator da trilha) → relança o erro original, nunca um 409 falso', async () => {
    const fk = Object.assign(new Error('fk do ator'), { code: '23503' });
    roteia({ found: [LINHA], deleteError: fk });
    await expect(deletePatientAddress(POOL, INPUT)).rejects.toBe(fk);
  });

  it('outro erro de banco (sem code 23503) sobe sem recontagem', async () => {
    const boom = Object.assign(new Error('boom'), { code: '40001' });
    roteia({ found: [LINHA], deleteError: boom });
    await expect(deletePatientAddress(POOL, INPUT)).rejects.toBe(boom);
    expect(sqls().filter((s) => /count\(\*\)/.test(s))).toHaveLength(1); // só a contagem original
  });

  it('erro lançado que não é objeto (null) também sobe', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (/FOR UPDATE/.test(sql)) return { rows: [LINHA], rowCount: 1 };
      if (/count\(\*\)/.test(sql)) return { rows: [{ vacancies: 0, services: 0 }], rowCount: 1 };
      throw null; // eslint-disable-line no-throw-literal
    });
    await expect(deletePatientAddress(POOL, INPUT)).rejects.toBeNull();
  });
});
