/**
 * TAREFA C (gate `revisao-pr`, fecho 17/09, BLOQUEIO 2) — e2e que exercita o REPOSITÓRIO REAL
 * (`AnaCarePatientMonthRepository`, migrations 441/442) contra o Postgres real, via o RUNNER real
 * (`AnaCareHoursSyncRunner`).
 *
 * Achado do gate: `grep -rn "anacare_patient_month" tests/e2e/` voltava VAZIO — o e2e existente
 * (`anacare-hours-api.e2e.test.ts`) roda com `ANACARE_HOURS_SOURCE=fake`, e nesse ramo
 * `AnaCareSyncDependenciesFactory` injeta `FakeAnaCarePatientMonthRepository` (em memória) tanto
 * para o `AnaCareHoursController` (leitura) quanto para o `AnaCareHoursSyncController` (escrita) —
 * as migrations 441/442, o `upsertReplacingForRun`, o `SELECT FOR UPDATE`, o `ROLLBACK` e o INSERT
 * do par paciente×prestador NUNCA rodaram em teste algum.
 *
 * Fiação deste arquivo (NÃO mexe em `AnaCareSyncDependenciesFactory` nem em nenhum outro código de
 * produção): a factory acopla FONTE e REPOSITÓRIO pela MESMA env (`ANACARE_HOURS_SOURCE`), então
 * não há combinação "fonte fake + repositório real" através dela. Em vez de alterar esse
 * acoplamento (fora do escopo desta tarefa — mudaria o comportamento em produção), este teste
 * importa as classes concretas diretamente (`AnaCareHoursSyncRunner`, `AnaCarePatientMonthRepository`
 * — real, Postgres — e uma fonte 100% em memória escrita aqui mesmo, nunca a rede do Ana Care) e as
 * conecta à mão. Nenhum arquivo de produção foi tocado para isto ser possível.
 *
 * O que se prova, lendo direto do BANCO (nunca do retorno do runner):
 *   1. o agregado (`anacare_patient_month`) é gravado com os NÚMEROS certos (shiftsCount,
 *      providersCount, hoursActualSum) — não só "uma linha existe";
 *   2. o PAR paciente×prestador (`anacare_patient_month_provider`) é gravado — a regressão que já
 *      aconteceu uma vez neste mesmo diff (passo 1 trocou o método que gravava o par por um que não
 *      gravava, D362);
 *   3. a colisão cross-reserva (mesmo paciente, duas reservas, MESMA corrida) faz `ROLLBACK` e não
 *      deixa gravação parcial — nem o agregado da 2ª reserva, nem o par da 2ª reserva.
 */
import { Pool } from 'pg';
import { AnaCareHoursSyncRunner } from '@modules/anacare-hours/application/AnaCareHoursSyncRunner';
import { AnaCarePatientMonthRepository, AnaCarePatientMonthCollisionError } from '@modules/anacare-hours/infrastructure/AnaCarePatientMonthRepository';
import { AnaCareSyncRunRepository } from '@modules/anacare-hours/infrastructure/AnaCareSyncRunRepository';
import { FakeEnliteDirectory, FakeAnaCareDirectorySnapshotRepository } from '@modules/anacare-hours/infrastructure/FakeAnaCareSyncDependencies';
import type { AnaCareShiftsSource, ListShiftsParams } from '@modules/anacare-hours/domain/AnaCareShiftsSource';
import type { SourceShiftDTO } from '@modules/anacare-hours/domain/AnaCareShiftsSource';
import type { EnliteDirectorySnapshot, EnliteDirectorySource } from '@modules/anacare-hours/domain/AnaCareHoursSyncPorts';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const TEST_MONTH = '2031-04';
const SOURCE = 'anacare';

/**
 * Fonte 100% EM MEMÓRIA escrita para este teste — NUNCA a rede do Ana Care, NUNCA
 * `FakeAnaCareShiftsSource` (que gera 10 pacientes sintéticos aleatórios; aqui precisamos de
 * turnos EXATOS, com paciente/prestador/hora conhecidos, para verificar os NÚMEROS gravados).
 * Devolve 1 turno por `reservationId`, conforme o mapa passado no construtor.
 */
class FixedShiftsPerReservationSource implements AnaCareShiftsSource {
  constructor(private readonly shiftByReservation: Record<string, SourceShiftDTO>) {}

  async listShifts(params: ListShiftsParams): Promise<{ shifts: SourceShiftDTO[]; skipped: { noProvider: number; noPatient: number } }> {
    const reservationId = params.reservationId;
    const shift = reservationId ? this.shiftByReservation[reservationId] : undefined;
    if (!shift) return { shifts: [], skipped: { noProvider: 0, noPatient: 0 } };
    return { shifts: [shift], skipped: { noProvider: 0, noPatient: 0 } };
  }

  async getShift(): Promise<SourceShiftDTO | null> {
    return null;
  }

  async getRetratoStatus() {
    return { stale: false, circuitBreakerOpen: false };
  }
}

class FixedDirectory implements EnliteDirectorySource {
  constructor(private readonly reservationIds: string[]) {}
  async fetch(): Promise<EnliteDirectorySnapshot> {
    return {
      entries: this.reservationIds.map((reservationId) => ({ reservationId })),
      counts: { activo: this.reservationIds.length, terminado: 0, total: this.reservationIds.length },
      partial: false,
    };
  }
}

function shift(overrides: Partial<SourceShiftDTO> & Pick<SourceShiftDTO, 'sourceShiftId' | 'anaCarePatientId' | 'anaCareNurseId'>): SourceShiftDTO {
  return {
    date: `${TEST_MONTH}-10`,
    scheduledStart: `${TEST_MONTH}-10T08:00:00.000Z`,
    scheduledEnd: `${TEST_MONTH}-10T12:00:00.000Z`,
    actualStart: null,
    actualEnd: null,
    checkinSource: null,
    isFinalized: false,
    ...overrides,
  };
}

describe('AnaCareHoursSyncRunner + AnaCarePatientMonthRepository REAL (Postgres) — TAREFA C (gate revisao-pr)', () => {
  let pool: Pool;

  const PAT_OK = 'E2E-C-OK';
  const PAT_COLLIDE = 'E2E-C-COLLIDE';
  const NURSE_OK = 'E2E-C-NURSE-OK';
  const NURSE_A = 'E2E-C-NURSE-A';
  const NURSE_B = 'E2E-C-NURSE-B';

  async function limpar(): Promise<void> {
    await pool.query(`DELETE FROM anacare_patient_month_provider WHERE source = $1 AND ana_care_patient_id LIKE 'E2E-C-%'`, [SOURCE]);
    await pool.query(`DELETE FROM anacare_patient_month WHERE source = $1 AND ana_care_patient_id LIKE 'E2E-C-%'`, [SOURCE]);
    // Migration 443 (TAREFA A): o carimbo da corrida deste mês de teste também é limpo — cada `it`
    // usa `new AnaCareSyncRunRepository()` (real), que grava/lê `(source, period_month)` no MESMO
    // mês para os dois testes; sem limpar, o 2º `it` herdaria a linha do 1º (inofensivo aqui, já
    // que corrida sem cursor sempre faz UPSERT, mas mantém a suíte hermética).
    await pool.query(`DELETE FROM anacare_sync_run WHERE source = $1 AND period_month = $2::date`, [SOURCE, `${TEST_MONTH}-01`]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    const tablesExist = await pool.query<{ ok: boolean }>(
      `SELECT to_regclass('anacare_patient_month') IS NOT NULL AND to_regclass('anacare_patient_month_provider') IS NOT NULL AS ok`,
    );
    if (!tablesExist.rows[0]?.ok) {
      throw new Error('[TAREFA C] migrations 441/442 não aplicadas no banco de teste — rode scripts/run-migrations-docker.js antes.');
    }
    await limpar();
  }, 30000);

  afterAll(async () => {
    await limpar();
    await pool.end();
  });

  it('reserva SEM colisão: grava o agregado com os NÚMEROS certos e o par paciente×prestador — direto no Postgres real', async () => {
    // R1: paciente OK, 1 turno com check-in E checkout de 4h reais (08h→12h) — hoursActualSum=4,
    // shiftsCount=1, providersCount=1 (1 nurse distinto nesta reserva).
    const source = new FixedShiftsPerReservationSource({
      R1: shift({
        sourceShiftId: 'E2E-C-R1-S0',
        anaCarePatientId: PAT_OK,
        anaCareNurseId: NURSE_OK,
        actualStart: `${TEST_MONTH}-10T08:00:00.000Z`,
        actualEnd: `${TEST_MONTH}-10T12:00:00.000Z`,
        checkinSource: 'app',
        isFinalized: true,
        nurseFirstName: 'Rocío',
        nurseLastName: 'García',
      }),
    });
    const runner = new AnaCareHoursSyncRunner(
      source,
      undefined,
      undefined,
      () => TEST_MONTH,
      new FixedDirectory(['R1']),
      new FakeAnaCareDirectorySnapshotRepository(),
      { ANACARE_DIRECTORY_MIN_ABSOLUTE: '1' },
      new AnaCarePatientMonthRepository(), // REAL — Postgres, migrations 441/442
      new AnaCareSyncRunRepository(),
    );

    const outcome = await runner.run({ origin: 'manual', userId: 'e2e-tarefa-c' });
    expect(outcome.shiftsWritten).toBe(1);

    // Prova 1: o agregado tem os NÚMEROS certos — lido DIRETO do banco, nunca do outcome do runner.
    const aggRow = await pool.query(
      `SELECT shifts_count, providers_count, hours_actual_sum, hours_scheduled_sum_missing_actual
         FROM anacare_patient_month
        WHERE source = $1 AND ana_care_patient_id = $2 AND period_month = $3::date`,
      [SOURCE, PAT_OK, `${TEST_MONTH}-01`],
    );
    expect(aggRow.rows).toHaveLength(1);
    expect(Number(aggRow.rows[0].shifts_count)).toBe(1);
    expect(Number(aggRow.rows[0].providers_count)).toBe(1);
    expect(Number(aggRow.rows[0].hours_actual_sum)).toBe(4);
    expect(Number(aggRow.rows[0].hours_scheduled_sum_missing_actual)).toBe(0);

    // Prova 2 (regressão D362/passo 1): o PAR paciente×prestador foi gravado — não só o agregado.
    const pairRow = await pool.query(
      `SELECT ana_care_nurse_id, nurse_first_name, nurse_last_name
         FROM anacare_patient_month_provider
        WHERE source = $1 AND ana_care_patient_id = $2 AND period_month = $3::date`,
      [SOURCE, PAT_OK, `${TEST_MONTH}-01`],
    );
    expect(pairRow.rows).toHaveLength(1);
    expect(pairRow.rows[0]).toMatchObject({ ana_care_nurse_id: NURSE_OK, nurse_first_name: 'Rocío', nurse_last_name: 'García' });
  });

  it('DUAS reservas do MESMO paciente na MESMA corrida: colisão → ROLLBACK, nenhuma gravação parcial (nem agregado, nem par) da 2ª reserva', async () => {
    // R2A escreve PAT_COLLIDE com NURSE_A primeiro (ordem alfabética R2A < R2B no diretório).
    // R2B tenta escrever o MESMO paciente com NURSE_B, na MESMA corrida (mesmo runStartedAt,
    // computado uma vez por `runner.run()`) — o Postgres real acha a linha que R2A acabou de
    // gravar (`fetched_at >= runStartedAt`) e recusa ANTES de sobrescrever.
    const source = new FixedShiftsPerReservationSource({
      R2A: shift({
        sourceShiftId: 'E2E-C-R2A-S0',
        anaCarePatientId: PAT_COLLIDE,
        anaCareNurseId: NURSE_A,
        actualStart: `${TEST_MONTH}-10T08:00:00.000Z`,
        actualEnd: `${TEST_MONTH}-10T11:00:00.000Z`,
        checkinSource: 'app',
        isFinalized: true,
      }),
      R2B: shift({
        sourceShiftId: 'E2E-C-R2B-S0',
        anaCarePatientId: PAT_COLLIDE,
        anaCareNurseId: NURSE_B,
        actualStart: `${TEST_MONTH}-10T08:00:00.000Z`,
        actualEnd: `${TEST_MONTH}-10T20:00:00.000Z`, // 12h — bem diferente, para o teste NÃO poder confundir com R2A se vazasse
        checkinSource: 'app',
        isFinalized: true,
      }),
    });
    const runner = new AnaCareHoursSyncRunner(
      source,
      undefined,
      undefined,
      () => TEST_MONTH,
      new FixedDirectory(['R2A', 'R2B']),
      new FakeAnaCareDirectorySnapshotRepository(),
      { ANACARE_DIRECTORY_MIN_ABSOLUTE: '1' },
      new AnaCarePatientMonthRepository(), // REAL — Postgres
      new AnaCareSyncRunRepository(),
    );

    await expect(runner.run({ origin: 'manual', userId: 'e2e-tarefa-c' })).rejects.toBeInstanceOf(AnaCarePatientMonthCollisionError);

    // O agregado ficou com os valores de R2A (3h) — R2B NUNCA sobrescreveu, nem parcialmente.
    const aggRow = await pool.query(
      `SELECT hours_actual_sum FROM anacare_patient_month WHERE source = $1 AND ana_care_patient_id = $2 AND period_month = $3::date`,
      [SOURCE, PAT_COLLIDE, `${TEST_MONTH}-01`],
    );
    expect(aggRow.rows).toHaveLength(1);
    expect(Number(aggRow.rows[0].hours_actual_sum)).toBe(3); // nunca 12 (R2B) — R2B sofreu ROLLBACK inteiro

    // O par paciente×prestador tem SÓ o de R2A (NURSE_A) — o par de R2B (NURSE_B) nunca existiu,
    // provando que o ROLLBACK cobre a MESMA transação do agregado e do par (decisão de atomicidade
    // documentada em AnaCarePatientMonthRepository.upsertReplacingForRun).
    const pairRows = await pool.query(
      `SELECT ana_care_nurse_id FROM anacare_patient_month_provider WHERE source = $1 AND ana_care_patient_id = $2 AND period_month = $3::date`,
      [SOURCE, PAT_COLLIDE, `${TEST_MONTH}-01`],
    );
    expect(pairRows.rows.map((r) => r.ana_care_nurse_id)).toEqual([NURSE_A]);
  });
});
