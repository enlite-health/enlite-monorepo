/**
 * ServiceTeamContactLogRepository — modal do prestador (quadro C, rodada 2, decisão D). Mesmo
 * molde do `ServiceTeamMarkWriter.test.ts` irmão: o `client` é injetado (a transação é de quem
 * chama), então o dublê aqui é só o `client`, sem banco real.
 */
import { ServiceTeamContactLogRepository } from '../ServiceTeamContactLogRepository';

function clientStub(rows: unknown[] = [], rowCount = rows.length) {
  const query = jest.fn().mockResolvedValue({ rows, rowCount });
  return { query };
}

describe('ServiceTeamContactLogRepository', () => {
  let repo: ServiceTeamContactLogRepository;

  beforeEach(() => {
    repo = new ServiceTeamContactLogRepository();
  });

  it('listForPair: 1 query, SELECT em service_team_contact_log filtrado por service_id/worker_id, mais recente primeiro', async () => {
    const client = clientStub([
      { id: 'c-2', service_id: 's-1', worker_id: 'w-1', contacted: true, event_date: '2026-09-29', note: 'segunda', created_by: 'u-1', created_at: '2026-09-29T10:00:00Z' },
      { id: 'c-1', service_id: 's-1', worker_id: 'w-1', contacted: false, event_date: '2026-09-20', note: null, created_by: 'u-1', created_at: '2026-09-20T10:00:00Z' },
    ]);

    const result = await repo.listForPair(client as never, 's-1', 'w-1');

    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, params] = client.query.mock.calls[0];
    expect(String(sql)).toMatch(/FROM service_team_contact_log/);
    expect(String(sql)).toMatch(/WHERE service_id = \$1 AND worker_id = \$2/);
    expect(String(sql)).toMatch(/ORDER BY created_at DESC/);
    expect(params).toEqual(['s-1', 'w-1']);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: 'c-2', serviceId: 's-1', workerId: 'w-1', contacted: true, eventDate: '2026-09-29',
      note: 'segunda', createdBy: 'u-1', createdAt: '2026-09-29T10:00:00Z',
    });
    expect(result[1].note).toBeNull();
  });

  it('insert: 1 query, INSERT em service_team_contact_log com os 6 parâmetros na ordem certa (append-only, sem UPDATE)', async () => {
    const client = clientStub();

    await repo.insert(client as never, {
      serviceId: 's-1', workerId: 'w-1', contacted: true, eventDate: '2026-09-29', note: 'ligou e confirmou', actorUid: 'staff:u-1',
    });

    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, params] = client.query.mock.calls[0];
    expect(String(sql)).toMatch(/INSERT INTO service_team_contact_log/);
    expect(String(sql)).not.toMatch(/UPDATE|DELETE/i);
    expect(params).toEqual(['s-1', 'w-1', true, '2026-09-29', 'ligou e confirmou', 'staff:u-1']);
  });

  it('insert: note null é aceito (Notas é opcional)', async () => {
    const client = clientStub();

    await repo.insert(client as never, {
      serviceId: 's-1', workerId: 'w-1', contacted: false, eventDate: '2026-09-29', note: null, actorUid: 'staff:u-1',
    });

    const [, params] = client.query.mock.calls[0];
    expect(params[4]).toBeNull();
  });

  it('getWorkerContactRow: 1 query, SELECT em workers por id; devolve só id + nome cifrado (sem telefone, D447.3)', async () => {
    const client = clientStub([
      { id: 'w-1', first_name_encrypted: 'enc:Marcel', last_name_encrypted: 'enc:Araujo' },
    ]);

    const result = await repo.getWorkerContactRow(client as never, 'w-1');

    const [sql, params] = client.query.mock.calls[0];
    expect(String(sql)).toMatch(/FROM workers WHERE id = \$1/);
    expect(String(sql)).not.toMatch(/phone/i);
    expect(params).toEqual(['w-1']);
    expect(result).toEqual({
      id: 'w-1', firstNameEncrypted: 'enc:Marcel', lastNameEncrypted: 'enc:Araujo',
    });
  });

  it('getWorkerContactRow: worker inexistente → null (sem quebrar)', async () => {
    const client = clientStub([], 0);

    const result = await repo.getWorkerContactRow(client as never, 'w-ghost');

    expect(result).toBeNull();
  });

  it('nenhuma SQL deste arquivo nomeia contracted_service_rejections/worker_job_applications/encuadres — tabela própria', async () => {
    const client = clientStub();
    await repo.listForPair(client as never, 's-1', 'w-1');
    await repo.insert(client as never, { serviceId: 's-1', workerId: 'w-1', contacted: true, eventDate: '2026-09-29', note: null, actorUid: 'u-1' });
    await repo.getWorkerContactRow(client as never, 'w-1');

    const allSql = client.query.mock.calls.map(([sql]: [unknown]) => String(sql)).join('\n');
    expect(/contracted_service_rejections|worker_job_applications|\bencuadres\b/i.test(allSql)).toBe(false);
  });
});
