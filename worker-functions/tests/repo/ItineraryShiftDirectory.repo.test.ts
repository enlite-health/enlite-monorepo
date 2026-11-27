/**
 * ItineraryShiftDirectory contra POSTGRES REAL: o SQL (escopo do worker + expansão) roda e uma ocorrência que NÃO existe no itinerário não é
 * resolvida (R1/R3 ficam de fora do alerta). A resolução de uma ocorrência semeada fica para o e2e (precisa de paciente/serviço/faixa/alocação).
 *   DATABASE_URL=postgresql://enlite_admin:enlite_password@127.0.0.1:5461/enlite_e2e npx jest --config jest.config.repo.js ItineraryShiftDirectory --maxWorkers=2
 */
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { ItineraryShiftDirectory } from '../../src/modules/case/infrastructure/ItineraryShiftDirectory';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@127.0.0.1:5461/enlite_e2e';

describe('ItineraryShiftDirectory (Postgres real)', () => {
  let pool: Pool;
  beforeAll(() => { pool = new Pool({ connectionString: DATABASE_URL }); });
  afterAll(() => pool.end());

  it('worker sem itinerário: o SQL executa e nenhuma ocorrência é resolvida', async () => {
    const out = await new ItineraryShiftDirectory(pool).resolve([{ occurrenceId: randomUUID(), workerId: randomUUID() }], { from: '2026-11-20', to: '2026-11-27' });
    expect(out.size).toBe(0);
  });

  it('sem candidatos: devolve vazio sem tocar o banco', async () => {
    expect((await new ItineraryShiftDirectory(pool).resolve([], { from: '2026-11-20', to: '2026-11-27' })).size).toBe(0);
  });
});
