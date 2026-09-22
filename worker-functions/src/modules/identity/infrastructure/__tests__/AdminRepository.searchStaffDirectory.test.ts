/**
 * AdminRepository.searchStaffDirectory — R2-B (change 022-ux-mencao-e-notificacao, Rodada 2):
 * `isOnline` calculado no SQL e exclusão do próprio requester. Unit puro (pool mockado) — o
 * comportamento do SQL real (isOnline por janela de 5 min, exclusão funcionando de fato) é
 * coberto pelo e2e `adminStaffDirectory.e2e.test.ts` (Postgres real). Aqui só se prova o
 * CONTRATO: quais parâmetros e em que ordem a query recebe, e que a forma da linha devolvida
 * inclui `isOnline`. Molde: `AdminRepository.isLastManager.test.ts`.
 */
const mockQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: mockQuery }) }) },
}));

import { AdminRepository } from '../AdminRepository';

describe('AdminRepository.searchStaffDirectory', () => {
  beforeEach(() => mockQuery.mockReset());

  it('q ausente: SQL sem ILIKE, LIMIT e excludeUid como parâmetros ($1, $2)', async () => {
    mockQuery.mockResolvedValue({ rows: [{ uid: 'u1', displayName: 'Ana', isOnline: true }] });
    const rows = await new AdminRepository().searchStaffDirectory(undefined, 20, 'me-uid');

    expect(rows).toEqual([{ uid: 'u1', displayName: 'Ana', isOnline: true }]);
    const [sql, params] = mockQuery.mock.calls[0];
    const sqlStr = String(sql);
    expect(sqlStr).not.toContain('ILIKE');
    expect(sqlStr).toContain('isOnline');
    expect(sqlStr).toContain("interval '5 minutes'");
    expect(sqlStr).toContain('LEFT JOIN staff_presence');
    // 🔒 Guarda dura (gate revisao-pr, critério 8): se alguém remover a exclusão do PRÓPRIO
    // requester neste ramo (sem `q`), este teste tem de morrer — a cláusula literal
    // `firebase_uid <> $2` é o que impede o requester de aparecer na própria lista de
    // mencionáveis. Provado por sabotagem em cópia (ver relatório da execução): removendo esta
    // linha do `AdminRepository.ts` copiado, este `expect` falha (RED); com o arquivo original,
    // passa (GREEN).
    expect(sqlStr).toContain('firebase_uid <> $2');
    expect(params).toEqual([20, 'me-uid']);
  });

  it('q ausente + sem excludeUid: passa null (não filtra ninguém)', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await new AdminRepository().searchStaffDirectory(undefined, 20);
    expect(mockQuery.mock.calls[0][1]).toEqual([20, null]);
  });

  it('q presente: SQL com ILIKE, params [q escapado, limit, excludeUid]', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await new AdminRepository().searchStaffDirectory('ana', 20, 'me-uid');
    const [sql, params] = mockQuery.mock.calls[0];
    const sqlStr = String(sql);
    expect(sqlStr).toContain('ILIKE');
    expect(sqlStr).toContain('isOnline');
    expect(sqlStr).toContain('LEFT JOIN staff_presence');
    expect(sqlStr).toContain('firebase_uid <> $3');
    expect(params).toEqual(['ana', 20, 'me-uid']);
  });

  it('limit explícito (R2-B "Mostrar todos"): propagado sem alteração', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await new AdminRepository().searchStaffDirectory(undefined, 200, 'me-uid');
    expect(mockQuery.mock.calls[0][1]).toEqual([200, 'me-uid']);
  });
});
