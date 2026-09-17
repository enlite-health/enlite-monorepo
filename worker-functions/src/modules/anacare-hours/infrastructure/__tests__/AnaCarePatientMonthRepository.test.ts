/**
 * AnaCarePatientMonthRepository — pool mockado na fronteira (`@shared/database/DatabaseConnection`),
 * mesmo molde de `AnaCareShiftRepository.test.ts`. Prova a FORMA do SQL (UNNEST em lote, ON
 * CONFLICT) e o round-trip campo-a-campo (upsert grava as 9 colunas → SELECT pedindo as mesmas
 * colunas → leitura devolve idêntico ao que entrou).
 */
const mockPoolQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ query: mockPoolQuery }) }),
  },
}));

import { AnaCarePatientMonthRepository } from '../AnaCarePatientMonthRepository';
import type { AnaCarePatientMonthAggregate, AnaCarePatientMonthProviderAggregate } from '../../domain/AnaCarePatientMonth';
import type { SourceShiftDTO } from '../../domain/AnaCareShiftsSource';

function shift(overrides: Partial<SourceShiftDTO> & Pick<SourceShiftDTO, 'sourceShiftId' | 'anaCarePatientId' | 'anaCareNurseId'>): SourceShiftDTO {
  return {
    date: '2026-09-10',
    scheduledStart: null,
    scheduledEnd: null,
    actualStart: null,
    actualEnd: null,
    checkinSource: null,
    isFinalized: false,
    ...overrides,
  };
}

const AGGREGATE_A: AnaCarePatientMonthAggregate = {
  anaCarePatientId: 'AC-PAT-0',
  patientFirstName: 'Ana',
  patientLastName: 'Paciente',
  providersCount: 2,
  shiftsCount: 5,
  hoursActualSum: 11.8,
  hoursScheduledSumMissingActual: 12,
  originSinCheckin: 1,
  originWebAdmin: 1,
  originApp: 3,
};

const AGGREGATE_SEM_NOME: AnaCarePatientMonthAggregate = {
  anaCarePatientId: 'AC-PAT-1',
  patientFirstName: undefined,
  patientLastName: undefined,
  providersCount: 1,
  shiftsCount: 1,
  hoursActualSum: 0,
  hoursScheduledSumMissingActual: 6,
  originSinCheckin: 1,
  originWebAdmin: 0,
  originApp: 0,
};

/** Linha SQL que o SELECT de `listByMonth`/round-trip devolveria para o agregado acima. */
function sqlRowFor(a: AnaCarePatientMonthAggregate) {
  return {
    ana_care_patient_id: a.anaCarePatientId,
    patient_first_name: a.patientFirstName ?? null,
    patient_last_name: a.patientLastName ?? null,
    providers_count: a.providersCount,
    shifts_count: a.shiftsCount,
    hours_actual_sum: String(a.hoursActualSum),
    hours_scheduled_sum_missing_actual: String(a.hoursScheduledSumMissingActual),
    origin_sin_checkin: a.originSinCheckin,
    origin_web_admin: a.originWebAdmin,
    origin_app: a.originApp,
  };
}

describe('AnaCarePatientMonthRepository', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset();
  });

  describe('upsertMany', () => {
    it('nada a gravar: zero agregados não toca o pool', async () => {
      const repo = new AnaCarePatientMonthRepository();
      const result = await repo.upsertMany([], '2026-09');
      expect(result).toEqual({ written: 0 });
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    it('grava em LOTE via UNNEST — 1 query para N pacientes, nunca 1 por paciente', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      const repo = new AnaCarePatientMonthRepository();
      const result = await repo.upsertMany([AGGREGATE_A, AGGREGATE_SEM_NOME], '2026-09');

      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockPoolQuery.mock.calls[0];
      expect(sql).toMatch(/UNNEST/);
      expect(sql).toMatch(/ON CONFLICT \(source, ana_care_patient_id, period_month\) DO UPDATE/);
      expect(params[1]).toEqual(['AC-PAT-0', 'AC-PAT-1']);
      expect(result).toEqual({ written: 2 });
    });

    it('period_month gravado é sempre o 1º dia do mês pedido, para todo agregado do lote', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      const repo = new AnaCarePatientMonthRepository();
      await repo.upsertMany([AGGREGATE_A, AGGREGATE_SEM_NOME], '2026-09');

      const [, params] = mockPoolQuery.mock.calls[0];
      expect(params[2]).toEqual(['2026-09-01', '2026-09-01']);
    });

    it('nome ausente (undefined) grava NULL explícito, nunca `undefined` cru no array de params', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      const repo = new AnaCarePatientMonthRepository();
      await repo.upsertMany([AGGREGATE_SEM_NOME], '2026-09');

      const [, params] = mockPoolQuery.mock.calls[0];
      expect(params[3]).toEqual([null]); // firstNames
      expect(params[4]).toEqual([null]); // lastNames
    });
  });

  /**
   * Conserto 17/09 (D361 F6.1): `recomputeFromShifts` recomputa via `INSERT ... SELECT ... GROUP
   * BY` sobre `anacare_shift` (fonte da verdade cumulativa), nunca faz upsert de um agregado
   * pré-somado em memória — é isso que evita a 2ª reserva do mesmo paciente apagar a 1ª (prova de
   * comportamento está em `AnaCareHoursSyncRunner.test.ts`, describe "conserto 17/09"; aqui só a
   * FORMA do SQL).
   */
  describe('recomputeFromShifts', () => {
    it('nada a gravar: zero turnos não toca o pool', async () => {
      const repo = new AnaCarePatientMonthRepository();
      const result = await repo.recomputeFromShifts([], '2026-09');
      expect(result).toEqual({ written: 0 });
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    it('2 queries (agregado + par paciente×prestador), a 1ª via UNNEST dos ids/nomes, SELECT GROUP BY sobre anacare_shift, ON CONFLICT com COALESCE de nome', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // agregado
      mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // par paciente×prestador (migration 442)
      const repo = new AnaCarePatientMonthRepository();
      const shifts = [
        shift({ sourceShiftId: 's0', anaCarePatientId: 'AC-PAT-0', anaCareNurseId: 'N0', patientFirstName: 'Ana', patientLastName: 'Paciente' }),
        shift({ sourceShiftId: 's1', anaCarePatientId: 'AC-PAT-1', anaCareNurseId: 'N1' }),
      ];

      const result = await repo.recomputeFromShifts(shifts, '2026-09');

      expect(mockPoolQuery).toHaveBeenCalledTimes(2);
      const [sql, params] = mockPoolQuery.mock.calls[0];
      expect(sql).toMatch(/SELECT/);
      expect(sql).toMatch(/FROM anacare_shift/);
      expect(sql).toMatch(/GROUP BY s\.ana_care_patient_id/);
      expect(sql).toMatch(/ON CONFLICT \(source, ana_care_patient_id, period_month\) DO UPDATE/);
      expect(sql).toMatch(/patient_first_name\s*=\s*COALESCE\(EXCLUDED\.patient_first_name, anacare_patient_month\.patient_first_name\)/);
      expect(sql).toMatch(/patient_last_name\s*=\s*COALESCE\(EXCLUDED\.patient_last_name, anacare_patient_month\.patient_last_name\)/);
      // $1 = period_month, $2 = patientIds, $3 = firstNames, $4 = lastNames
      expect(params[0]).toBe('2026-09-01');
      expect(params[1]).toEqual(['AC-PAT-0', 'AC-PAT-1']);
      expect(params[2]).toEqual(['Ana', null]);
      expect(params[3]).toEqual(['Paciente', null]);
      expect(result).toEqual({ written: 2 });
    });

    it('WHERE filtra por source, period_month E ana_care_patient_id = ANY(lista) — nunca recomputa o mês inteiro', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      const repo = new AnaCarePatientMonthRepository();
      await repo.recomputeFromShifts([shift({ sourceShiftId: 's0', anaCarePatientId: 'AC-PAT-0', anaCareNurseId: 'N0' })], '2026-09');

      const [sql] = mockPoolQuery.mock.calls[0];
      expect(sql).toMatch(/WHERE s\.source = 'anacare' AND s\.period_month = \$1::date AND s\.ana_care_patient_id = ANY\(\$2::text\[\]\)/);
    });

    it('mesmo paciente em DOIS turnos do lote conta 1 vez em patientIds (dedup), não duplica o UNNEST', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      const repo = new AnaCarePatientMonthRepository();
      const shifts = [
        shift({ sourceShiftId: 's0', anaCarePatientId: 'AC-PAT-0', anaCareNurseId: 'N0' }),
        shift({ sourceShiftId: 's1', anaCarePatientId: 'AC-PAT-0', anaCareNurseId: 'N1' }),
      ];

      const result = await repo.recomputeFromShifts(shifts, '2026-09');

      const [, params] = mockPoolQuery.mock.calls[0];
      expect(params[1]).toEqual(['AC-PAT-0']);
      expect(result).toEqual({ written: 1 });
    });

    it('nome: primeiro turno do lote com nome NÃO-VAZIO vence, os demais do MESMO paciente não sobrescrevem', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      const repo = new AnaCarePatientMonthRepository();
      const shifts = [
        shift({ sourceShiftId: 's0', anaCarePatientId: 'AC-PAT-0', anaCareNurseId: 'N0', patientFirstName: '  ', patientLastName: null }),
        shift({ sourceShiftId: 's1', anaCarePatientId: 'AC-PAT-0', anaCareNurseId: 'N1', patientFirstName: 'Ana', patientLastName: 'Paciente' }),
        shift({ sourceShiftId: 's2', anaCarePatientId: 'AC-PAT-0', anaCareNurseId: 'N2', patientFirstName: 'Outro', patientLastName: 'Nome' }),
      ];

      await repo.recomputeFromShifts(shifts, '2026-09');

      const [, params] = mockPoolQuery.mock.calls[0];
      expect(params[2]).toEqual(['Ana']);
      expect(params[3]).toEqual(['Paciente']);
    });

    it('nenhum turno do lote tem nome ⇒ NULL explícito (nunca undefined cru) — COALESCE do ON CONFLICT preserva o nome já gravado', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      const repo = new AnaCarePatientMonthRepository();
      await repo.recomputeFromShifts([shift({ sourceShiftId: 's0', anaCarePatientId: 'AC-PAT-0', anaCareNurseId: 'N0' })], '2026-09');

      const [, params] = mockPoolQuery.mock.calls[0];
      expect(params[2]).toEqual([null]);
      expect(params[3]).toEqual([null]);
    });

    it('period_month gravado é o 1º dia do mês pedido', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      const repo = new AnaCarePatientMonthRepository();
      await repo.recomputeFromShifts([shift({ sourceShiftId: 's0', anaCarePatientId: 'AC-PAT-0', anaCareNurseId: 'N0' })], '2026-09');

      const [, params] = mockPoolQuery.mock.calls[0];
      expect(params[0]).toBe('2026-09-01');
    });

    /**
     * Adendo 17/09 (D361, migration 442) — a companheira paciente×prestador. `upsertProvidersFromShifts`
     * é privado; provado aqui pela 2ª query que `recomputeFromShifts` dispara.
     */
    describe('par paciente×prestador (migration 442)', () => {
      it('2ª query grava o par via UNNEST, ON CONFLICT com COALESCE de nome — só os pares do LOTE, nunca recomputa contra anacare_shift', async () => {
        mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // agregado
        mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // par
        const repo = new AnaCarePatientMonthRepository();
        const shifts = [
          shift({ sourceShiftId: 's0', anaCarePatientId: 'AC-PAT-0', anaCareNurseId: 'N0', nurseFirstName: 'Rocío', nurseLastName: 'García' }),
          shift({ sourceShiftId: 's1', anaCarePatientId: 'AC-PAT-0', anaCareNurseId: 'N1' }),
        ];

        await repo.recomputeFromShifts(shifts, '2026-09');

        const [sql, params] = mockPoolQuery.mock.calls[1];
        expect(sql).toMatch(/INSERT INTO anacare_patient_month_provider/);
        expect(sql).toMatch(/UNNEST/);
        expect(sql).not.toMatch(/FROM anacare_shift/);
        expect(sql).toMatch(/ON CONFLICT \(source, ana_care_patient_id, ana_care_nurse_id, period_month\) DO UPDATE/);
        expect(sql).toMatch(/nurse_first_name\s*=\s*COALESCE\(EXCLUDED\.nurse_first_name, anacare_patient_month_provider\.nurse_first_name\)/);
        expect(sql).toMatch(/nurse_last_name\s*=\s*COALESCE\(EXCLUDED\.nurse_last_name, anacare_patient_month_provider\.nurse_last_name\)/);
        // $1 period_month, $2 patientIds, $3 nurseIds, $4 firstNames, $5 lastNames
        expect(params[0]).toBe('2026-09-01');
        expect(params[1]).toEqual(['AC-PAT-0', 'AC-PAT-0']);
        expect(params[2]).toEqual(['N0', 'N1']);
        expect(params[3]).toEqual(['Rocío', null]);
        expect(params[4]).toEqual(['García', null]);
      });

      it('dois turnos do MESMO par (mesmo paciente+prestador): 1 só entrada no UNNEST, primeiro nome não-vazio vence', async () => {
        mockPoolQuery.mockResolvedValueOnce({ rows: [] });
        mockPoolQuery.mockResolvedValueOnce({ rows: [] });
        const repo = new AnaCarePatientMonthRepository();
        const shifts = [
          shift({ sourceShiftId: 's0', anaCarePatientId: 'AC-PAT-0', anaCareNurseId: 'N0', nurseFirstName: '  ', nurseLastName: null }),
          shift({ sourceShiftId: 's1', anaCarePatientId: 'AC-PAT-0', anaCareNurseId: 'N0', nurseFirstName: 'Rocío', nurseLastName: 'García' }),
          shift({ sourceShiftId: 's2', anaCarePatientId: 'AC-PAT-0', anaCareNurseId: 'N0', nurseFirstName: 'Outro', nurseLastName: 'Nome' }),
        ];

        await repo.recomputeFromShifts(shifts, '2026-09');

        const [, params] = mockPoolQuery.mock.calls[1];
        expect(params[1]).toEqual(['AC-PAT-0']);
        expect(params[2]).toEqual(['N0']);
        expect(params[3]).toEqual(['Rocío']);
        expect(params[4]).toEqual(['García']);
      });

      it('nenhum turno do lote tem nome de prestador ⇒ NULL explícito (COALESCE preserva o nome já gravado)', async () => {
        mockPoolQuery.mockResolvedValueOnce({ rows: [] });
        mockPoolQuery.mockResolvedValueOnce({ rows: [] });
        const repo = new AnaCarePatientMonthRepository();
        await repo.recomputeFromShifts([shift({ sourceShiftId: 's0', anaCarePatientId: 'AC-PAT-0', anaCareNurseId: 'N0' })], '2026-09');

        const [, params] = mockPoolQuery.mock.calls[1];
        expect(params[3]).toEqual([null]);
        expect(params[4]).toEqual([null]);
      });
    });
  });

  describe('listProvidersByMonth', () => {
    it('SELECT filtra por source e period_month, devolve os 4 campos mapeados', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [
          { ana_care_patient_id: 'AC-PAT-0', ana_care_nurse_id: 'N0', nurse_first_name: 'Rocío', nurse_last_name: 'García' },
          { ana_care_patient_id: 'AC-PAT-0', ana_care_nurse_id: 'N1', nurse_first_name: null, nurse_last_name: null },
        ],
      });
      const repo = new AnaCarePatientMonthRepository();
      const result = await repo.listProvidersByMonth('anacare', '2026-09');

      const [sql, params] = mockPoolQuery.mock.calls[0];
      expect(sql).toMatch(/FROM anacare_patient_month_provider/);
      expect(sql).toMatch(/WHERE source = \$1 AND period_month = \$2/);
      expect(params).toEqual(['anacare', '2026-09-01']);
      expect(result).toEqual([
        { anaCarePatientId: 'AC-PAT-0', anaCareNurseId: 'N0', nurseFirstName: 'Rocío', nurseLastName: 'García' },
        { anaCarePatientId: 'AC-PAT-0', anaCareNurseId: 'N1', nurseFirstName: undefined, nurseLastName: undefined },
      ] satisfies AnaCarePatientMonthProviderAggregate[]);
    });
  });

  describe('listByMonth — round-trip (campo a campo)', () => {
    it('devolve TODAS as 9 colunas agregadas idênticas ao que foi gravado (com nome)', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [sqlRowFor(AGGREGATE_A)] });
      const repo = new AnaCarePatientMonthRepository();
      const [result] = await repo.listByMonth('anacare', '2026-09');
      expect(result).toEqual(AGGREGATE_A);
    });

    it('devolve idêntico ao que foi gravado quando o nome está ausente (undefined, não string vazia)', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [sqlRowFor(AGGREGATE_SEM_NOME)] });
      const repo = new AnaCarePatientMonthRepository();
      const [result] = await repo.listByMonth('anacare', '2026-09');
      expect(result).toEqual(AGGREGATE_SEM_NOME);
      expect(result.patientFirstName).toBeUndefined();
      expect(result.patientLastName).toBeUndefined();
    });

    it('SELECT pede exatamente as colunas do agregado, filtrando por source e period_month', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      const repo = new AnaCarePatientMonthRepository();
      await repo.listByMonth('anacare', '2026-09');

      const [sql, params] = mockPoolQuery.mock.calls[0];
      expect(sql).toMatch(/providers_count/);
      expect(sql).toMatch(/shifts_count/);
      expect(sql).toMatch(/hours_actual_sum/);
      expect(sql).toMatch(/hours_scheduled_sum_missing_actual/);
      expect(sql).toMatch(/origin_sin_checkin/);
      expect(sql).toMatch(/origin_web_admin/);
      expect(sql).toMatch(/origin_app/);
      expect(sql).toMatch(/WHERE source = \$1 AND period_month = \$2/);
      expect(params).toEqual(['anacare', '2026-09-01']);
    });
  });

  describe('getSnapshotFreshness', () => {
    it('zero linhas ⇒ { shifts: 0, lastFetchedAt: null } — contagem zero é falha, nunca sucesso', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ count: '0', last_fetched_at: null }] });
      const repo = new AnaCarePatientMonthRepository();
      const freshness = await repo.getSnapshotFreshness('anacare', '2026-09');
      expect(freshness).toEqual({ shifts: 0, lastFetchedAt: null });
    });

    it('com linhas: devolve a contagem e o último fetched_at', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ count: '145', last_fetched_at: '2026-09-17T00:00:00.000Z' }] });
      const repo = new AnaCarePatientMonthRepository();
      const freshness = await repo.getSnapshotFreshness('anacare', '2026-09');
      expect(freshness).toEqual({ shifts: 145, lastFetchedAt: '2026-09-17T00:00:00.000Z' });
    });
  });
});
