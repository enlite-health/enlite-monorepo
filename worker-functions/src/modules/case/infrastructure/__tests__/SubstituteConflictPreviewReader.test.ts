/**
 * SubstituteConflictPreviewReader — spec 069, FR-15. A função do banco roda num SAVEPOINT: se ela falhar, o rollback PARCIAL mantém
 * a transação viva e o erro vira `ConflictPreviewUnavailableError` (o caso de uso marca `unknown`, nunca `free`).
 */
import type { PoolClient } from 'pg';
import { ConflictPreviewUnavailableError, SubstituteConflictPreviewReader } from '../SubstituteConflictPreviewReader';

const IN = { workerId: 'w-1', slotId: 's-1', from: '2026-11-02', to: '2026-11-02' };

function clientWith(impl: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>) {
  const query = jest.fn(impl);
  return { query, client: { query } as unknown as PoolClient };
}

describe('SubstituteConflictPreviewReader', () => {
  const reader = new SubstituteConflictPreviewReader();

  it('chama itinerary_substitute_conflict_preview(pessoa, faixa, de, até, ausência ignorada) dentro de um SAVEPOINT e mapeia só horário/duração/mesmo endereço', async () => {
    const { query, client } = clientWith(async (sql) =>
      /itinerary_substitute_conflict_preview/.test(sql) ? { rows: [{ weekday: 1, start_time: '09:00', duration_minutes: 240, same_address: true }] } : { rows: [] },
    );

    const overlaps = await reader.preview(client, { ...IN, ignoreAbsenceId: 'ab-1' });

    expect(overlaps).toEqual([{ weekday: 1, startTime: '09:00', durationMinutes: 240, sameAddress: true }]);
    const sqls = query.mock.calls.map(([sql]) => String(sql));
    expect(sqls[0]).toBe('SAVEPOINT conflict_preview');
    expect(sqls[1]).toMatch(/FROM itinerary_substitute_conflict_preview\(\$1::uuid, \$2::uuid, \$3::date, \$4::date, \$5::uuid\)/);
    expect(query.mock.calls[1][1]).toEqual(['w-1', 's-1', '2026-11-02', '2026-11-02', 'ab-1']);
    expect(sqls[2]).toBe('RELEASE SAVEPOINT conflict_preview');
    // a SQL não devolve id de serviço/paciente alheio
    expect(/service_id|patient_id|address_id/.test(sqls[1])).toBe(false);
  });

  it('sem ausência a ignorar → $5 null; sem linhas → []', async () => {
    const { query, client } = clientWith(async () => ({ rows: [] }));
    await expect(reader.preview(client, { ...IN, to: null })).resolves.toEqual([]);
    expect(query.mock.calls[1][1]).toEqual(['w-1', 's-1', '2026-11-02', null, null]);
  });

  it('a função FALHA → ROLLBACK TO SAVEPOINT (a transação segue viva) e ConflictPreviewUnavailableError; nunca devolve []', async () => {
    const boom = new Error('permission denied for function');
    const { query, client } = clientWith(async (sql) => {
      if (/itinerary_substitute_conflict_preview/.test(sql)) throw boom;
      return { rows: [] };
    });

    const err = await reader.preview(client, IN).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictPreviewUnavailableError);
    expect((err as ConflictPreviewUnavailableError).cause).toBe(boom);
    const sqls = query.mock.calls.map(([sql]) => String(sql));
    expect(sqls).toContain('ROLLBACK TO SAVEPOINT conflict_preview');
    expect(sqls).not.toContain('RELEASE SAVEPOINT conflict_preview');
  });
});
