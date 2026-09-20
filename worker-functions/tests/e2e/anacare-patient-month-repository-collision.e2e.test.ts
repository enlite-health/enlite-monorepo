/**
 * TAREFA B (gate `revisao-pr`, fecho 17/09, BLOQUEIO 1) — teste de INTEGRAÇÃO contra o Postgres
 * REAL (`enlite-postgres`, o mesmo que os e2e usam), rodando o SQL de verdade de
 * `AnaCarePatientMonthRepository.upsertReplacingForRun`.
 *
 * MOVIDO para `tests/e2e/` (17/09, fecho do gate `revisao-pr`, achado do gate 2): morava em
 * `src/modules/anacare-hours/infrastructure/__tests__/` e casava o `testMatch` de `jest.config.js`
 * (`**\/__tests__/**\/*.test.ts`) — o CI (`npm test -- --coverage`) tentava rodar esta suíte SEM
 * Postgres e SEM `DATABASE_URL`, e `DatabaseConnection.getInstance()` (usado só transitivamente por
 * outros módulos do processo) quebrava a suíte inteira. Este arquivo nunca precisou do
 * `DatabaseConnection` — sempre usou `pg.Pool` direto — mas o `testMatch` não distingue isso.
 * `tests/e2e/` é o padrão da casa para teste que precisa de Postgres real (roda em
 * `backend-e2e.yml`, nunca no `npm test` do CI de unit). Continua provando exatamente as MESMAS
 * duas metades, sem `jest.mock`, contra o Postgres real — só o CAMINHO e a forma do import
 * mudaram (relativo → alias `@modules/...`, igual ao resto de `tests/e2e/`).
 *
 * Por quê este arquivo existe: `AnaCarePatientMonthRepository.test.ts` mocka `pg` inteiro e só
 * afirma FORMA (regex no texto do SQL, array de params) — sabotar o predicado
 * `fetched_at >= $3::timestamptz` (troca `>=` por `<=`/`<`, ou apagar a cláusula) NÃO faz nenhum
 * daqueles testes ficar vermelho, porque nenhum deles deixa o Postgres AVALIAR a cláusula. Os
 * testes de HTTP/runner (`AnaCareHoursSyncRunner.test.ts`, `anacareHoursSyncRoutes.test.ts`)
 * exercitam só o FAKE (`FakeAnaCarePatientMonthRepository`), uma segunda implementação do mesmo
 * detector, escrita à mão — autoteste de um lado só. Este arquivo é o ÚNICO que faz o Postgres
 * real decidir se a linha colide, provando as DUAS metades:
 *   - POSITIVO: paciente já gravado NESTA MESMA corrida (mesmo `runStartedAt`, duas "reservas"
 *     diferentes) ⇒ `AnaCarePatientMonthCollisionError`, `ROLLBACK`, nada do lote é gravado.
 *   - NEGATIVO (controle): corrida NOVA (carimbo estritamente posterior ao `fetched_at` já
 *     gravado) ⇒ NÃO detecta, grava normal (substituição legítima entre corridas).
 *
 * Não mocka `@shared/database/DatabaseConnection` — usa o Pool real (mesmo `DATABASE_URL` que
 * `tests/e2e/*.e2e.test.ts` já usam, `enlite-postgres` de pé em localhost:5432/enlite_e2e).
 * Migrations 441/442/443 têm de estar aplicadas nesse banco (`node scripts/run-migrations-docker.js`).
 *
 * `ana_care_patient_id`/`period_month` desta suíte usam um MÊS e um PREFIXO exclusivos
 * (`period_month = '2031-02-01'`, ids `INTEG-B-*`) para nunca colidir com dado de outro teste ou
 * de dev local — `afterAll` limpa as linhas que este arquivo escreveu (nunca `TRUNCATE`).
 */
import { Pool } from 'pg';
import { AnaCarePatientMonthRepository, AnaCarePatientMonthCollisionError } from '@modules/anacare-hours/infrastructure/AnaCarePatientMonthRepository';
import type { AnaCarePatientMonthAggregate } from '@modules/anacare-hours/domain/AnaCarePatientMonth';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const TEST_MONTH = '2031-02';
const SOURCE = 'anacare';

function aggregate(patientId: string, overrides: Partial<AnaCarePatientMonthAggregate> = {}): AnaCarePatientMonthAggregate {
  return {
    anaCarePatientId: patientId,
    patientFirstName: 'Integração',
    patientLastName: 'TarefaB',
    providersCount: 1,
    shiftsCount: 1,
    hoursActualSum: 4,
    hoursScheduledSumMissingActual: 0,
    originSinCheckin: 0,
    originWebAdmin: 0,
    originApp: 1,
    ...overrides,
  };
}

describe('AnaCarePatientMonthRepository.upsertReplacingForRun — INTEGRAÇÃO contra o Postgres REAL (TAREFA B)', () => {
  let pool: Pool;
  let repo: AnaCarePatientMonthRepository;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const tablesExist = await pool.query<{ to_regclass: string | null }>(`SELECT to_regclass('anacare_patient_month') AS to_regclass`);
    if (!tablesExist.rows[0]?.to_regclass) {
      throw new Error(
        '[TAREFA B] tabela anacare_patient_month não existe no banco de teste — rode ' +
          '`DATABASE_URL=... node scripts/run-migrations-docker.js` antes desta suíte (migrations 441/442/443).',
      );
    }
    repo = new AnaCarePatientMonthRepository();
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM anacare_patient_month WHERE source = $1 AND period_month = $2 AND ana_care_patient_id LIKE 'INTEG-B-%'`, [
      SOURCE,
      `${TEST_MONTH}-01`,
    ]);
  });

  afterAll(async () => {
    await pool.end();
  });

  it('POSITIVO — paciente já gravado NESTA MESMA corrida (mesmo runStartedAt, duas reservas): AnaCarePatientMonthCollisionError, ROLLBACK, nada do lote gravado', async () => {
    const patientId = 'INTEG-B-COLIDE';
    // `runStartedAt` capturado ANTES de qualquer escrita — mesma semântica de
    // `AnaCareHoursSyncRunner.run`: o carimbo da CORRIDA nasce antes de processar qualquer reserva,
    // então toda escrita real (`fetched_at = NOW()` do banco) acontece DEPOIS dele.
    const runStartedAt = new Date();

    // Reserva 1 da corrida: grava o paciente pela 1ª vez — sem colisão possível (linha não existe).
    const first = await repo.upsertReplacingForRun([aggregate(patientId, { hoursActualSum: 2 })], TEST_MONTH, runStartedAt, []);
    expect(first).toEqual({ written: 1 });

    // Reserva 2 da MESMA corrida (mesmo runStartedAt): o Postgres real tem de achar a linha que a
    // reserva 1 acabou de gravar (`fetched_at >= runStartedAt` é VERDADEIRO — a escrita da reserva 1
    // aconteceu DEPOIS do carimbo da corrida) e recusar ANTES de sobrescrever.
    await expect(repo.upsertReplacingForRun([aggregate(patientId, { hoursActualSum: 99 })], TEST_MONTH, runStartedAt, [])).rejects.toBeInstanceOf(
      AnaCarePatientMonthCollisionError,
    );

    // Nada da reserva 2 foi gravado — a linha no banco continua EXATAMENTE como a reserva 1 deixou.
    const rows = await repo.listByMonth(SOURCE, TEST_MONTH);
    const row = rows.find((r) => r.anaCarePatientId === patientId);
    expect(row).toBeDefined();
    expect(row!.hoursActualSum).toBe(2); // nunca 99 — a reserva 2 não gravou nada, nem parcialmente
  });

  it('NEGATIVO (controle) — corrida NOVA (carimbo estritamente posterior ao fetched_at já gravado): NÃO detecta, grava normal', async () => {
    const patientId = 'INTEG-B-CORRIDA-NOVA';
    const runStartedAtCorridaAntiga = new Date();
    const first = await repo.upsertReplacingForRun([aggregate(patientId, { hoursActualSum: 3 })], TEST_MONTH, runStartedAtCorridaAntiga, []);
    expect(first).toEqual({ written: 1 });

    // Separação de relógio real: o carimbo da corrida NOVA precisa ficar estritamente DEPOIS do
    // `fetched_at` que a corrida antiga acabou de gravar — sem isso os dois caem no mesmo instante
    // e `>=` (correto, cauteloso) trataria como a MESMA corrida, mascarando o que este teste prova.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const runStartedAtCorridaNova = new Date();

    // Corrida NOVA, mesmo paciente: substituição LEGÍTIMA (não é a mesma corrida) — não deve
    // lançar, e o valor final é o da corrida nova.
    const second = await repo.upsertReplacingForRun([aggregate(patientId, { hoursActualSum: 7 })], TEST_MONTH, runStartedAtCorridaNova, []);
    expect(second).toEqual({ written: 1 });

    const rows = await repo.listByMonth(SOURCE, TEST_MONTH);
    const row = rows.find((r) => r.anaCarePatientId === patientId);
    expect(row).toBeDefined();
    expect(row!.hoursActualSum).toBe(7); // corrida nova substituiu a antiga — comportamento esperado, sem erro
  });
});
