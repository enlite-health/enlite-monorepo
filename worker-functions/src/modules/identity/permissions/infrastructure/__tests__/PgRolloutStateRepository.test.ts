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
});
