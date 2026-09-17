/**
 * AnaCareShiftRepository — pool mockado na fronteira (`@shared/database/DatabaseConnection`),
 * mesmo molde de `ShiftHoursValidationRepository.test.ts`. Prova a FORMA do SQL (UNNEST em lote,
 * ON CONFLICT) e o round-trip campo-a-campo (grava DTO → lê de volta → idêntico, inclusive
 * `isFinalized` e `actualStart`/`actualEnd` nulos). O SQL rodando de verdade contra Postgres é
 * provado no e2e/psql manual (mesma convenção do módulo).
 */
const mockPoolQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ query: mockPoolQuery }) }),
  },
}));

import { AnaCareShiftRepository, AnaCareShiftMonthMismatchError } from '../AnaCareShiftRepository';
import type { SourceShiftDTO } from '../../domain/AnaCareShiftsSource';

const SHIFT_A: SourceShiftDTO = {
  sourceShiftId: 'FAKE-2026-09-0-0-0',
  anaCarePatientId: 'AC-PAT-0',
  anaCareNurseId: 'AC-NURSE-0',
  date: '2026-09-10',
  scheduledStart: '2026-09-10T08:00:00.000Z',
  scheduledEnd: '2026-09-10T12:00:00.000Z',
  actualStart: '2026-09-10T08:05:00.000Z',
  actualEnd: '2026-09-10T11:58:00.000Z',
  checkinSource: 'app',
  isFinalized: true,
};

const SHIFT_SEM_CHECKIN: SourceShiftDTO = {
  sourceShiftId: 'FAKE-2026-09-0-0-1',
  anaCarePatientId: 'AC-PAT-0',
  anaCareNurseId: 'AC-NURSE-0',
  date: '2026-09-11',
  scheduledStart: '2026-09-11T08:00:00.000Z',
  scheduledEnd: '2026-09-11T12:00:00.000Z',
  actualStart: null,
  actualEnd: null,
  checkinSource: null,
  isFinalized: false,
};

/** Linha SQL que o SELECT de `listByMonth`/round-trip devolveria para o DTO acima. */
function sqlRowFor(dto: SourceShiftDTO) {
  return {
    source_shift_id: dto.sourceShiftId,
    ana_care_patient_id: dto.anaCarePatientId,
    ana_care_nurse_id: dto.anaCareNurseId,
    planned_start: dto.scheduledStart,
    planned_end: dto.scheduledEnd,
    checkin_at: dto.actualStart,
    checkout_at: dto.actualEnd,
    checkin_source: dto.checkinSource,
    is_finalized: dto.isFinalized,
    shift_date: dto.date,
    // Sem coalesce para `null`: quando o DTO de teste não carrega o campo (`undefined`), a linha
    // simulada também fica `undefined` — do contrário o round-trip `toEqual` quebraria (Jest NÃO
    // trata `null` como igual a chave ausente/`undefined`, só ignora `undefined`).
    patient_first_name: dto.patientFirstName,
    patient_last_name: dto.patientLastName,
    nurse_first_name: dto.nurseFirstName,
    nurse_last_name: dto.nurseLastName,
  };
}

describe('AnaCareShiftRepository', () => {
  beforeEach(() => {
    mockPoolQuery.mockReset();
  });

  describe('upsertMany', () => {
    it('nada a gravar: zero turnos não toca o pool', async () => {
      const repo = new AnaCareShiftRepository();
      const result = await repo.upsertMany([], '2026-09');
      expect(result).toEqual({ written: 0 });
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    it('grava em LOTE via UNNEST — 1 query para N turnos, nunca 1 por turno', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      const repo = new AnaCareShiftRepository();
      const result = await repo.upsertMany([SHIFT_A, SHIFT_SEM_CHECKIN], '2026-09');

      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockPoolQuery.mock.calls[0];
      expect(sql).toMatch(/UNNEST/);
      expect(sql).toMatch(/ON CONFLICT \(source, source_shift_id\) DO UPDATE/);
      expect(params[0]).toBe('anacare');
      expect(params[1]).toEqual(['FAKE-2026-09-0-0-0', 'FAKE-2026-09-0-0-1']);
      expect(result).toEqual({ written: 2 });
    });

    it('period_month gravado é sempre o 1º dia do mês pedido, para todo turno do lote', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      const repo = new AnaCareShiftRepository();
      await repo.upsertMany([SHIFT_A, SHIFT_SEM_CHECKIN], '2026-09');

      const [, params] = mockPoolQuery.mock.calls[0];
      const periodMonthDates = params[4];
      expect(periodMonthDates).toEqual(['2026-09-01', '2026-09-01']);
    });

    /**
     * Item 2 (revisão de PR): `shift_date` grava `source.date` DIRETO — nunca mais derivado de
     * `planned_start` na leitura. Este teste MORRE se alguém voltar a depender de `planned_start`
     * para o dia: um turno com `scheduledStart` vazio (equivalente a `planned_start IS NULL` no
     * banco) ainda tem de gravar o dia certo, porque `shiftDates` vem só de `s.date`.
     */
    it('grava shift_date direto de source.date — mesmo com scheduledStart vazio (planned_start NULL)', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      const repo = new AnaCareShiftRepository();
      const semPlannedStart: SourceShiftDTO = { ...SHIFT_SEM_CHECKIN, scheduledStart: '', date: '2026-09-11' };
      await repo.upsertMany([SHIFT_A, semPlannedStart], '2026-09');

      const [sql, params] = mockPoolQuery.mock.calls[0];
      expect(sql).toMatch(/shift_date/);
      expect(sql).not.toMatch(/to_char/);
      const plannedStarts = params[5];
      const shiftDates = params[11];
      expect(plannedStarts[1]).toBeNull(); // planned_start NULL no 2º turno
      expect(shiftDates).toEqual(['2026-09-10', '2026-09-11']); // shift_date não depende disso
    });

    /**
     * Item 5 (conserto de raiz 17/09): `checkout_source`/`checkin_delay` existem na tabela desde
     * a migration 437 e eram gravados NULOS por falta de campo no DTO — este teste MORRE se a
     * coluna voltar a ficar de fora do INSERT.
     */
    it('checkoutSource e checkinDelay chegam ao INSERT — não mais NULL por omissão do DTO', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      const repo = new AnaCareShiftRepository();
      const comCheckout: SourceShiftDTO = { ...SHIFT_A, checkoutSource: 'app', checkinDelay: 12 };
      await repo.upsertMany([comCheckout], '2026-09');

      const [sql, params] = mockPoolQuery.mock.calls[0];
      expect(sql).toMatch(/checkout_source/);
      expect(sql).toMatch(/checkin_delay/);
      const checkoutSources = params[12];
      const checkinDelays = params[13];
      expect(checkoutSources).toEqual(['app']);
      expect(checkinDelays).toEqual([12]);
    });

    it('checkoutSource/checkinDelay ausentes no DTO gravam NULL explícito (round-trip de leitura, nunca `undefined`)', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      const repo = new AnaCareShiftRepository();
      await repo.upsertMany([SHIFT_A], '2026-09'); // SHIFT_A não carrega checkoutSource/checkinDelay

      const [, params] = mockPoolQuery.mock.calls[0];
      expect(params[12]).toEqual([null]);
      expect(params[13]).toEqual([null]);
    });

    /**
     * Item 1 (17/09, migration 440): nome e sobrenome do paciente/prestador chegam ao INSERT — as
     * quatro colunas novas, nunca de fora do lote (`UNNEST`/`ON CONFLICT` continuam cobrindo elas).
     */
    it('patientFirstName/patientLastName/nurseFirstName/nurseLastName chegam ao INSERT (migration 440)', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      const repo = new AnaCareShiftRepository();
      const comNomes: SourceShiftDTO = {
        ...SHIFT_A,
        patientFirstName: 'Lucía',
        patientLastName: 'Fernández QA',
        nurseFirstName: 'Carla',
        nurseLastName: 'Suárez QA',
      };
      await repo.upsertMany([comNomes], '2026-09');

      const [sql, params] = mockPoolQuery.mock.calls[0];
      expect(sql).toMatch(/patient_first_name/);
      expect(sql).toMatch(/patient_last_name/);
      expect(sql).toMatch(/nurse_first_name/);
      expect(sql).toMatch(/nurse_last_name/);
      expect(params[14]).toEqual(['Lucía']);
      expect(params[15]).toEqual(['Fernández QA']);
      expect(params[16]).toEqual(['Carla']);
      expect(params[17]).toEqual(['Suárez QA']);
    });

    it('nome ausente no DTO grava NULL explícito nas 4 colunas — turno sem nome existe (item 1)', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      const repo = new AnaCareShiftRepository();
      await repo.upsertMany([SHIFT_A], '2026-09'); // SHIFT_A não carrega nenhum dos 4 campos de nome

      const [, params] = mockPoolQuery.mock.calls[0];
      expect(params[14]).toEqual([null]);
      expect(params[15]).toEqual([null]);
      expect(params[16]).toEqual([null]);
      expect(params[17]).toEqual([null]);
    });

    /**
     * Item 4 (conserto de raiz 17/09): `sourceMonth` (afirmação da fonte, `raw.month`) divergindo
     * do mês pedido tem de FALHAR ALTO — nunca gravar calado num mês errado. Este teste MORRE se
     * `upsertMany` voltar a confiar cegamente no `periodMonth` do chamador.
     */
    it('sourceMonth divergindo do periodMonth pedido: lança AnaCareShiftMonthMismatchError e NÃO grava nada do lote', async () => {
      const repo = new AnaCareShiftRepository();
      const turnoDeOutroMes: SourceShiftDTO = { ...SHIFT_A, sourceMonth: '2026-08' };

      await expect(repo.upsertMany([turnoDeOutroMes], '2026-09')).rejects.toThrow(AnaCareShiftMonthMismatchError);
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    it('sourceMonth ausente (DTO sem afirmação da fonte): não valida, grava normalmente', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      const repo = new AnaCareShiftRepository();
      await expect(repo.upsertMany([SHIFT_A], '2026-09')).resolves.toEqual({ written: 1 });
    });

    it('sourceMonth igual ao periodMonth pedido: grava sem lançar', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      const repo = new AnaCareShiftRepository();
      const turnoMesmoMes: SourceShiftDTO = { ...SHIFT_A, sourceMonth: '2026-09' };
      await expect(repo.upsertMany([turnoMesmoMes], '2026-09')).resolves.toEqual({ written: 1 });
    });
  });

  describe('listByMonth — round-trip (campo a campo)', () => {
    it('turno COM check-in: mapeia de volta idêntico ao DTO gravado', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [sqlRowFor(SHIFT_A)] });
      const repo = new AnaCareShiftRepository();
      const [dto] = await repo.listByMonth('2026-09');
      expect(dto).toEqual(SHIFT_A);
    });

    // O round-trip morre se `isFinalized`/`actualStart`/`actualEnd` virarem outra coisa (ex.:
    // `undefined` em vez de `null`, ou um booleano derivado errado) — turno sem check-in é o
    // caso que mais fica sujeito a isso (checkin_source NULL, actual* NULL, is_finalized false).
    it('turno SEM check-in: actualStart/actualEnd/checkinSource nulos, isFinalized=false — idêntico ao DTO gravado', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [sqlRowFor(SHIFT_SEM_CHECKIN)] });
      const repo = new AnaCareShiftRepository();
      const [dto] = await repo.listByMonth('2026-09');
      expect(dto).toEqual(SHIFT_SEM_CHECKIN);
      expect(dto.actualStart).toBeNull();
      expect(dto.actualEnd).toBeNull();
      expect(dto.checkinSource).toBeNull();
      expect(dto.isFinalized).toBe(false);
    });

    /**
     * Item 1 (17/09): round-trip fiel dos quatro nomes — nome que entra no upsert é nome que sai
     * em `listByMonth`, inclusive o caso de nome AUSENTE (turno sem nome na fonte, `null` no banco).
     */
    it('round-trip dos 4 campos de nome — presentes', async () => {
      const comNomes: SourceShiftDTO = {
        ...SHIFT_A,
        patientFirstName: 'Lucía',
        patientLastName: 'Fernández QA',
        nurseFirstName: 'Carla',
        nurseLastName: 'Suárez QA',
      };
      mockPoolQuery.mockResolvedValueOnce({ rows: [sqlRowFor(comNomes)] });
      const repo = new AnaCareShiftRepository();
      const [dto] = await repo.listByMonth('2026-09');
      expect(dto.patientFirstName).toBe('Lucía');
      expect(dto.patientLastName).toBe('Fernández QA');
      expect(dto.nurseFirstName).toBe('Carla');
      expect(dto.nurseLastName).toBe('Suárez QA');
    });

    it('round-trip dos 4 campos de nome — ausentes (null no banco, turno sem nome na fonte)', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ ...sqlRowFor(SHIFT_A), patient_first_name: null, patient_last_name: null, nurse_first_name: null, nurse_last_name: null }],
      });
      const repo = new AnaCareShiftRepository();
      const [dto] = await repo.listByMonth('2026-09');
      expect(dto.patientFirstName).toBeNull();
      expect(dto.patientLastName).toBeNull();
      expect(dto.nurseFirstName).toBeNull();
      expect(dto.nurseLastName).toBeNull();
    });

    it('filtra por paciente quando `patientId` é passado — SQL ganha AND extra', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      const repo = new AnaCareShiftRepository();
      await repo.listByMonth('2026-09', 'AC-PAT-0');

      const [sql, params] = mockPoolQuery.mock.calls[0];
      expect(sql).toMatch(/ana_care_patient_id = \$3/);
      expect(params).toEqual(['anacare', '2026-09-01', 'AC-PAT-0']);
    });

    /**
     * Item 7 (revisão de PR): `planned_start`/`planned_end` NULL no banco (retrato sem o previsto
     * gravado) tem de virar `null` explícito no DTO — nunca `''`. Este teste MORRE se `toDTO`
     * voltar a fazer `r.planned_start ?? ''`.
     */
    it('planned_start/planned_end NULL no banco: scheduledStart/scheduledEnd chegam null no DTO, nunca string vazia', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [{ ...sqlRowFor(SHIFT_SEM_CHECKIN), planned_start: null, planned_end: null }],
      });
      const repo = new AnaCareShiftRepository();
      const [dto] = await repo.listByMonth('2026-09');
      expect(dto.scheduledStart).toBeNull();
      expect(dto.scheduledEnd).toBeNull();
    });

    /**
     * Item 2 (revisão de PR): o SQL não deriva mais o dia com `to_char(COALESCE(planned_start,
     * period_month), ...)` (dependia do TimeZone de sessão e virava o 1º do mês com
     * `planned_start` nulo) — lê `shift_date` gravado direto. Um turno às 21:00 em
     * `America/Argentina/Buenos_Aires` (UTC-3, portanto `scheduledStart`/`planned_start` em
     * `2026-09-1{0,1}...`) tem seu `shift_date` já fixado no dia local pela fonte — a leitura
     * devolve o MESMO dia independentemente de qual TimeZone a sessão do Postgres estiver usando,
     * porque não há mais conversão nenhuma na query.
     */
    it('não deriva mais o dia na leitura — lê shift_date gravado, turno das 21h em Buenos Aires', async () => {
      const turnoNoturno: SourceShiftDTO = {
        sourceShiftId: 'FAKE-2026-09-0-0-2',
        anaCarePatientId: 'AC-PAT-0',
        anaCareNurseId: 'AC-NURSE-0',
        // 21h em America/Argentina/Buenos_Aires (UTC-3) em 10/09 = 2026-09-11T00:00:00Z — o dia
        // que a FONTE afirma para esse turno é 10/09, não 11/09.
        date: '2026-09-10',
        scheduledStart: '2026-09-11T00:00:00.000Z',
        scheduledEnd: '2026-09-11T04:00:00.000Z',
        actualStart: null,
        actualEnd: null,
        checkinSource: null,
        isFinalized: false,
      };
      mockPoolQuery.mockResolvedValueOnce({ rows: [sqlRowFor(turnoNoturno)] });
      const repo = new AnaCareShiftRepository();
      const [dto] = await repo.listByMonth('2026-09');
      const [calledSql] = mockPoolQuery.mock.calls[0];

      expect(calledSql).not.toMatch(/to_char/);
      expect(calledSql).not.toMatch(/COALESCE\(planned_start/);
      expect(calledSql).toMatch(/shift_date::text/);
      expect(dto.date).toBe('2026-09-10');
    });

    it('SELECT de listByMonth pede as 4 colunas de nome (migration 440)', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      const repo = new AnaCareShiftRepository();
      await repo.listByMonth('2026-09');
      const [calledSql] = mockPoolQuery.mock.calls[0];
      expect(calledSql).toMatch(/patient_first_name/);
      expect(calledSql).toMatch(/patient_last_name/);
      expect(calledSql).toMatch(/nurse_first_name/);
      expect(calledSql).toMatch(/nurse_last_name/);
    });
  });

  describe('getSnapshotFreshness', () => {
    it('zero linhas ⇒ { shifts: 0, lastFetchedAt: null } — contagem zero é falha, nunca sucesso', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ count: '0', last_fetched_at: null }] });
      const repo = new AnaCareShiftRepository();
      const freshness = await repo.getSnapshotFreshness('2026-09');
      expect(freshness).toEqual({ shifts: 0, lastFetchedAt: null });
    });

    it('com linhas: devolve a contagem e o último fetched_at', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ count: '42', last_fetched_at: '2026-09-15T00:00:00.000Z' }] });
      const repo = new AnaCareShiftRepository();
      const freshness = await repo.getSnapshotFreshness('2026-09');
      expect(freshness).toEqual({ shifts: 42, lastFetchedAt: '2026-09-15T00:00:00.000Z' });
    });
  });

  describe('getLastDirectoryCount / setLastDirectoryCount', () => {
    it('sem linha ainda: devolve null (primeira execução)', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      const repo = new AnaCareShiftRepository();
      expect(await repo.getLastDirectoryCount()).toBeNull();
    });

    it('devolve a contagem persistida', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ last_total_count: 283 }] });
      const repo = new AnaCareShiftRepository();
      expect(await repo.getLastDirectoryCount()).toBe(283);
    });

    it('setLastDirectoryCount grava via upsert de linha única (id=1)', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      const repo = new AnaCareShiftRepository();
      await repo.setLastDirectoryCount(283);

      const [sql, params] = mockPoolQuery.mock.calls[0];
      expect(sql).toMatch(/ON CONFLICT \(id\) DO UPDATE/);
      expect(params).toEqual([283]);
    });
  });
});
