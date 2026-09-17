/**
 * AnaCarePatientMonthRepository — pool mockado na fronteira (`@shared/database/DatabaseConnection`).
 * Prova a FORMA do SQL (UNNEST em lote, ON CONFLICT) e o round-trip campo-a-campo (upsert grava as
 * 9 colunas → SELECT pedindo as mesmas colunas → leitura devolve idêntico ao que entrou).
 */
const mockPoolQuery = jest.fn();
/**
 * `upsertReplacingForRun` (conserto 17/09, passo 1) usa `pool.connect()` — client dedicado pra
 * transação (BEGIN/SELECT FOR UPDATE/ROLLBACK ou COMMIT), nunca `pool.query()` direto (mesmo molde
 * de `IcdCatalogTerminology.test.ts`, D6). `mockClientQuery` default cobre BEGIN/COMMIT/ROLLBACK
 * (não carregam linhas); o SELECT FOR UPDATE e o INSERT são dirigidos por fila
 * (`mockClientQuery.mockResolvedValueOnce`) em cada teste.
 */
const mockClientQuery = jest.fn();
const mockRelease = jest.fn();
const mockConnect = jest.fn().mockResolvedValue({ query: mockClientQuery, release: mockRelease });
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ query: mockPoolQuery, connect: mockConnect }) }),
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
    mockClientQuery.mockReset();
    mockConnect.mockClear();
    mockRelease.mockClear();
    // Default: BEGIN/COMMIT/ROLLBACK não carregam linhas — testes de `upsertReplacingForRun`
    // sobrescrevem com `mockResolvedValueOnce` na ORDEM em que o método dispara as queries.
    mockClientQuery.mockResolvedValue({ rows: [] });
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

  /**
   * Tarefa 2 (brief 17/09, passo 2): `upsertReplacingForRun` (BEGIN / SELECT ... FOR UPDATE /
   * ON CONFLICT / ROLLBACK) não tinha teste próprio — a peça mais arriscada do passo 1. `pool.connect()`
   * é mockado à parte de `pool.query()` (mesmo molde de `IcdCatalogTerminology.test.ts`, D6): o
   * método usa um CLIENT dedicado pra transação, nunca `pool.query()` direto.
   */
  describe('upsertReplacingForRun', () => {
    it('nada a gravar: zero agregados não toca o pool nem abre transação', async () => {
      const repo = new AnaCarePatientMonthRepository();
      const result = await repo.upsertReplacingForRun([], '2026-09', new Date('2026-09-17T10:00:00.000Z'), []);
      expect(result).toEqual({ written: 0 });
      expect(mockConnect).not.toHaveBeenCalled();
    });

    it('caminho feliz: BEGIN → SELECT FOR UPDATE (sem colisão) → INSERT/UPSERT → COMMIT, libera o client', async () => {
      mockClientQuery
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // SELECT ... FOR UPDATE — nenhuma linha colidindo
        .mockResolvedValueOnce({ rows: [], rowCount: 2 }) // INSERT ... ON CONFLICT
        .mockResolvedValueOnce({ rows: [] }); // COMMIT

      const repo = new AnaCarePatientMonthRepository();
      const runStartedAt = new Date('2026-09-17T10:00:00.000Z');
      // shifts=[] aqui: este teste prova o caminho do AGREGADO isolado — o par paciente×prestador
      // (quando shifts não é vazio) é provado à parte, describe abaixo.
      const result = await repo.upsertReplacingForRun([AGGREGATE_A, AGGREGATE_SEM_NOME], '2026-09', runStartedAt, []);

      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockClientQuery.mock.calls[0][0]).toMatch(/^BEGIN/);
      expect(mockClientQuery.mock.calls[1][0]).toMatch(/SELECT ana_care_patient_id[\s\S]*FOR UPDATE/);
      // runStartedAt é o 3º parâmetro do SELECT FOR UPDATE, como ISO — é ele que fia o detector
      // de colisão cross-invocação pela camada HTTP (tarefa 1).
      expect(mockClientQuery.mock.calls[1][1]).toEqual(['2026-09-01', ['AC-PAT-0', 'AC-PAT-1'], runStartedAt.toISOString()]);
      expect(mockClientQuery.mock.calls[2][0]).toMatch(/INSERT INTO anacare_patient_month/);
      // shifts=[] ⇒ nenhuma query extra do par — COMMIT é a 4ª chamada, não a 5ª.
      expect(mockClientQuery.mock.calls[3][0]).toMatch(/^COMMIT/);
      expect(mockClientQuery).toHaveBeenCalledTimes(4);
      expect(mockRelease).toHaveBeenCalledTimes(1);
      // Contagem zero é falha, nunca sucesso — `written` é o `rowCount` REAL do INSERT, não o
      // tamanho do array de entrada (que também é 2 aqui, então o teste de baixo prova a diferença).
      expect(result).toEqual({ written: 2 });
    });

    it('COALESCE de nome no ON CONFLICT: rodada SEM nome não apaga um nome já gravado', async () => {
      mockClientQuery
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // SELECT FOR UPDATE — sem colisão
        .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT
        .mockResolvedValueOnce({ rows: [] }); // COMMIT

      const repo = new AnaCarePatientMonthRepository();
      await repo.upsertReplacingForRun([AGGREGATE_SEM_NOME], '2026-09', new Date('2026-09-17T10:00:00.000Z'), []);

      const insertSql = mockClientQuery.mock.calls[2][0] as string;
      expect(insertSql).toMatch(/patient_first_name\s*=\s*COALESCE\(EXCLUDED\.patient_first_name, anacare_patient_month\.patient_first_name\)/);
      expect(insertSql).toMatch(/patient_last_name\s*=\s*COALESCE\(EXCLUDED\.patient_last_name, anacare_patient_month\.patient_last_name\)/);
      const insertParams = mockClientQuery.mock.calls[2][1] as unknown[];
      expect(insertParams[3]).toEqual([null]); // firstNames — AGGREGATE_SEM_NOME não tem nome, NULL explícito
      expect(insertParams[4]).toEqual([null]); // lastNames
    });

    it('colisão: paciente do lote já gravado NESTA MESMA corrida (fetched_at >= runStartedAt) → ROLLBACK, lança, NADA do lote é gravado (nem o par)', async () => {
      mockClientQuery
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [{ ana_care_patient_id: 'AC-PAT-0' }] }) // SELECT FOR UPDATE — COLIDE
        .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

      const repo = new AnaCarePatientMonthRepository();
      const runStartedAt = new Date('2026-09-17T10:00:00.000Z');

      await expect(
        repo.upsertReplacingForRun(
          [AGGREGATE_A, AGGREGATE_SEM_NOME],
          '2026-09',
          runStartedAt,
          [shift({ sourceShiftId: 's0', anaCarePatientId: 'AC-PAT-0', anaCareNurseId: 'N0' })],
        ),
      ).rejects.toThrow(/AC-PAT-0.*já foram gravados NESTA MESMA corrida/s);

      // ROLLBACK dispara DUAS vezes (o explícito do ramo de colisão + o do catch-all que blinda
      // qualquer erro do bloco try) — nenhuma delas é INSERT: o INSERT NUNCA disparou (nada do
      // lote gravado, nem o paciente que não colidia, nem o par paciente×prestador — a colisão
      // acontece ANTES de qualquer chance de gravar o par).
      expect(mockClientQuery).toHaveBeenCalledTimes(4);
      expect(mockClientQuery.mock.calls[2][0]).toMatch(/^ROLLBACK/);
      expect(mockClientQuery.mock.calls[3][0]).toMatch(/^ROLLBACK/);
      expect(mockClientQuery.mock.calls.some(([sql]) => /^INSERT/.test(sql as string))).toBe(false);
      expect(mockRelease).toHaveBeenCalledTimes(1); // client sempre liberado, mesmo no erro
    });

    it('rowCount real ≠ tamanho do array de entrada: written reflete o INSERT, não o `aggregates.length` (contagem zero é falha, nunca sucesso)', async () => {
      mockClientQuery
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // SELECT FOR UPDATE — sem colisão
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // INSERT — driver afirma 0 linhas afetadas
        .mockResolvedValueOnce({ rows: [] }); // COMMIT

      const repo = new AnaCarePatientMonthRepository();
      const result = await repo.upsertReplacingForRun([AGGREGATE_A, AGGREGATE_SEM_NOME], '2026-09', new Date('2026-09-17T10:00:00.000Z'), []);

      // 2 agregados de ENTRADA, mas rowCount=0 do driver — written tem que ser 0, nunca 2.
      expect(result).toEqual({ written: 0 });
    });

    it('erro fora da checagem de colisão (ex.: INSERT falha) também faz ROLLBACK e libera o client', async () => {
      mockClientQuery
        .mockResolvedValueOnce({ rows: [] }) // BEGIN
        .mockResolvedValueOnce({ rows: [] }) // SELECT FOR UPDATE — sem colisão
        .mockRejectedValueOnce(new Error('conexão caiu')) // INSERT explode
        .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

      const repo = new AnaCarePatientMonthRepository();
      await expect(repo.upsertReplacingForRun([AGGREGATE_A], '2026-09', new Date('2026-09-17T10:00:00.000Z'), [])).rejects.toThrow('conexão caiu');

      expect(mockClientQuery.mock.calls[3][0]).toMatch(/^ROLLBACK/);
      expect(mockRelease).toHaveBeenCalledTimes(1);
    });

    /**
     * Passo 3 (17/09, conserto da REGRESSÃO): `upsertReplacingForRun` (caminho de produção, via
     * `AnaCareHoursSyncRunner`) volta a gravar o par paciente×prestador — o passo 1 tinha trocado
     * `recomputeFromShifts` (que gravava o par) por este método (que não gravava), e o `grep`
     * medido no passo 2 provou zero escritor de produção em `anacare_patient_month_provider`.
     */
    describe('par paciente×prestador (migration 442) — regressão do passo 1', () => {
      it('shifts não-vazio: grava o par NA MESMA transação, entre o INSERT do agregado e o COMMIT', async () => {
        mockClientQuery
          .mockResolvedValueOnce({ rows: [] }) // BEGIN
          .mockResolvedValueOnce({ rows: [] }) // SELECT FOR UPDATE — sem colisão
          .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT agregado
          .mockResolvedValueOnce({ rows: [] }) // INSERT par paciente×prestador
          .mockResolvedValueOnce({ rows: [] }); // COMMIT

        const repo = new AnaCarePatientMonthRepository();
        const shifts = [
          shift({ sourceShiftId: 's0', anaCarePatientId: 'AC-PAT-0', anaCareNurseId: 'N0', nurseFirstName: 'Rocío', nurseLastName: 'García' }),
        ];
        const result = await repo.upsertReplacingForRun([AGGREGATE_A], '2026-09', new Date('2026-09-17T10:00:00.000Z'), shifts);

        expect(mockConnect).toHaveBeenCalledTimes(1); // 1 SÓ client — mesma transação, não uma separada
        expect(mockClientQuery.mock.calls[2][0]).toMatch(/INSERT INTO anacare_patient_month\b/);
        const [providerSql, providerParams] = mockClientQuery.mock.calls[3];
        expect(providerSql).toMatch(/INSERT INTO anacare_patient_month_provider/);
        expect(providerSql).toMatch(/ON CONFLICT \(source, ana_care_patient_id, ana_care_nurse_id, period_month\) DO UPDATE/);
        expect(providerSql).toMatch(/nurse_first_name\s*=\s*COALESCE\(EXCLUDED\.nurse_first_name, anacare_patient_month_provider\.nurse_first_name\)/);
        expect(providerParams).toEqual(['2026-09-01', ['AC-PAT-0'], ['N0'], ['Rocío'], ['García']]);
        expect(mockClientQuery.mock.calls[4][0]).toMatch(/^COMMIT/);
        expect(result).toEqual({ written: 1 });
      });

      it('shifts=[] (vazio): NÃO abre a query do par — só BEGIN/SELECT/INSERT/COMMIT, mesma contagem de antes da regressão', async () => {
        mockClientQuery
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [], rowCount: 1 })
          .mockResolvedValueOnce({ rows: [] });

        const repo = new AnaCarePatientMonthRepository();
        await repo.upsertReplacingForRun([AGGREGATE_A], '2026-09', new Date('2026-09-17T10:00:00.000Z'), []);

        expect(mockClientQuery).toHaveBeenCalledTimes(4);
        expect(mockClientQuery.mock.calls.some(([sql]) => /anacare_patient_month_provider/.test(sql as string))).toBe(false);
      });

      it('dois turnos do MESMO par (mesmo paciente+prestador): 1 só entrada no UNNEST, primeiro nome não-vazio vence', async () => {
        mockClientQuery
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [], rowCount: 1 })
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [] });

        const repo = new AnaCarePatientMonthRepository();
        const shifts = [
          shift({ sourceShiftId: 's0', anaCarePatientId: 'AC-PAT-0', anaCareNurseId: 'N0', nurseFirstName: '  ', nurseLastName: null }),
          shift({ sourceShiftId: 's1', anaCarePatientId: 'AC-PAT-0', anaCareNurseId: 'N0', nurseFirstName: 'Rocío', nurseLastName: 'García' }),
        ];
        await repo.upsertReplacingForRun([AGGREGATE_A], '2026-09', new Date('2026-09-17T10:00:00.000Z'), shifts);

        const [, providerParams] = mockClientQuery.mock.calls[3];
        expect(providerParams).toEqual(['2026-09-01', ['AC-PAT-0'], ['N0'], ['Rocío'], ['García']]);
      });

      it('erro no INSERT do par (ex.: conexão cai) também faz ROLLBACK e libera o client — mesma blindagem do agregado', async () => {
        mockClientQuery
          .mockResolvedValueOnce({ rows: [] }) // BEGIN
          .mockResolvedValueOnce({ rows: [] }) // SELECT FOR UPDATE
          .mockResolvedValueOnce({ rows: [], rowCount: 1 }) // INSERT agregado — sucesso
          .mockRejectedValueOnce(new Error('conexão caiu')) // INSERT do par explode
          .mockResolvedValueOnce({ rows: [] }); // ROLLBACK

        const repo = new AnaCarePatientMonthRepository();
        const shifts = [shift({ sourceShiftId: 's0', anaCarePatientId: 'AC-PAT-0', anaCareNurseId: 'N0' })];

        await expect(
          repo.upsertReplacingForRun([AGGREGATE_A], '2026-09', new Date('2026-09-17T10:00:00.000Z'), shifts),
        ).rejects.toThrow('conexão caiu');

        // Decisão de atomicidade (ver cabeçalho de `upsertReplacingForRun`): o par entra na MESMA
        // transação do agregado — se ele falhar, o agregado desta reserva TAMBÉM sofre ROLLBACK,
        // nunca fica um COMMIT parcial (agregado gravado, par não).
        expect(mockClientQuery.mock.calls[4][0]).toMatch(/^ROLLBACK/);
        expect(mockClientQuery.mock.calls.some(([sql]) => /^COMMIT/.test(sql as string))).toBe(false);
        expect(mockRelease).toHaveBeenCalledTimes(1);
      });
    });
  });
});
