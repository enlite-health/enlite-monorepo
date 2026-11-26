/**
 * `activeMasterUids` — quem recebe a cópia do Acesso Master (change tactiq-vinculo-resiliente, T301, design D12).
 * O SQL enviado é o que se prova aqui (o e2e `tactiq-seat-notice` prova contra o banco real).
 */
import { activeMasterUids } from '../MasterRecipients';

const dbWith = (rows: Array<{ uid: string }>) => {
  const query = jest.fn(async () => ({ rows }));
  return { query, db: { query } as never };
};

describe('activeMasterUids', () => {
  it('devolve só os uids, na ordem do banco', async () => {
    const t = dbWith([{ uid: 'uid-a' }, { uid: 'uid-b' }]);
    await expect(activeMasterUids(t.db)).resolves.toEqual(['uid-a', 'uid-b']);
    expect(t.query).toHaveBeenCalledTimes(1);
  });

  it('sem membro vivo → lista vazia (o chamador decide o caminho `no_recipient`)', async () => {
    await expect(activeMasterUids(dbWith([]).db)).resolves.toEqual([]);
  });

  it('o SQL filtra por filiação VIVA (`iam.is_master_member`) e por staff ativo, e não escreve em lugar nenhum', async () => {
    const t = dbWith([]);
    await activeMasterUids(t.db);
    const sql = String((t.query.mock.calls[0] as unknown[])[0]);
    expect(sql).toContain('iam.is_master_member');
    expect(sql).toContain("status = 'ACTIVE'");
    expect(sql).toContain('is_active IS NOT FALSE');
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });
});
