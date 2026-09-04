/**
 * A diferença entre "não marcado" e "não sei" — e ela decide se o
 * worker-functions sobe. Ver o cabeçalho do repositório.
 */

import { PgRolloutStateRepository } from '../PgRolloutStateRepository';

jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  loggingAls: { getStore: () => undefined },
}));

function repoCom(resultado: unknown): PgRolloutStateRepository {
  const pool = {
    query: resultado instanceof Error ? jest.fn().mockRejectedValue(resultado) : jest.fn().mockResolvedValue(resultado),
  };
  return new PgRolloutStateRepository(pool as never);
}

/** Devolve o repo E o mock de `query`, pra inspecionar SQL/params do `set`. */
function repoEQuery(resultado: unknown = { rows: [] }): { repo: PgRolloutStateRepository; query: jest.Mock } {
  const query = resultado instanceof Error ? jest.fn().mockRejectedValue(resultado) : jest.fn().mockResolvedValue(resultado);
  return { repo: new PgRolloutStateRepository({ query } as never), query };
}

function erroPg(code: string): Error {
  return Object.assign(new Error(`falha ${code}`), { code });
}

describe('PgRolloutStateRepository', () => {
  it('marcador presente devolve o valor', async () => {
    await expect(repoCom({ rows: [{ value: '2026-08-17' }] }).get('k')).resolves.toBe('2026-08-17');
  });

  it('linha ausente é "não marcado"', async () => {
    await expect(repoCom({ rows: [] }).get('k')).resolves.toBeNull();
  });

  it('TABELA ausente (42P01) é "não marcado" — ambiente sem a migration 282', async () => {
    await expect(repoCom(erroPg('42P01')).get('k')).resolves.toBeNull();
  });

  // O caso que o gate pegou: engolir isto fazia "não sei" virar "não rodou", e
  // o gate de boot matava o processo por uma conexão ruim.
  it.each([
    ['conexão derrubada', erroPg('57P01')],
    ['statement timeout', erroPg('57014')],
    ['permissão negada', erroPg('42501')],
    ['erro sem code', new Error('socket hang up')],
  ])('%s RELANÇA — nunca vira "não marcado"', async (_nome, err) => {
    await expect(repoCom(err).get('k')).rejects.toThrow(err);
  });

  // ── `set` (F12 — escrita do marcador, só sucede como owner; ver docstring) ──
  describe('set', () => {
    it('faz upsert por key: INSERT com ON CONFLICT DO UPDATE, e os 3 params na ordem key/value/note', async () => {
      const { repo, query } = repoEQuery();
      await repo.set('permission_groups_migrated', 'done', 'iam-config-import cfg.json@abc123 2026-09-04T00:00:00.000Z');
      expect(query).toHaveBeenCalledTimes(1);
      const [sql, params] = query.mock.calls[0];
      expect(String(sql)).toContain('INSERT INTO iam.rollout_state');
      expect(String(sql)).toContain('ON CONFLICT (key) DO UPDATE');
      expect(params).toEqual(['permission_groups_migrated', 'done', 'iam-config-import cfg.json@abc123 2026-09-04T00:00:00.000Z']);
    });

    it('note omitida vira null (não undefined) — Pool.query não aceita undefined em params', async () => {
      const { repo, query } = repoEQuery();
      await repo.set('k', 'done');
      expect(query.mock.calls[0][1]).toEqual(['k', 'done', null]);
    });

    it('erro do pool (42501 do ator sem grant, ou 42P01 sem a 282) RELANÇA — set não tem "não sei" aceitável', async () => {
      const { repo } = repoEQuery(erroPg('42501'));
      await expect(repo.set('k', 'done')).rejects.toMatchObject({ code: '42501' });
    });
  });
});
