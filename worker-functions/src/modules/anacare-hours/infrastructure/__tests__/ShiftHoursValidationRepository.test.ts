/**
 * ShiftHoursValidationRepository — pool mockado na fronteira (`@shared/database/DatabaseConnection`),
 * mesmo molde de `TherapeuticCatalogRepository.test.ts`. Prova a FORMA do SQL e os dois caminhos de
 * negócio (validar/contestar já validado → `ShiftAlreadyValidatedError`); o SQL rodando de verdade
 * (trigger de imutabilidade, CHECKs) é provado no e2e/psql manual (fase 1, ver relatório da fase).
 */
const mockPoolQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: {
    getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ query: mockPoolQuery }) }),
  },
}));

import { ShiftHoursValidationRepository, ShiftAlreadyValidatedError } from '../ShiftHoursValidationRepository';

const VALIDATED_ROW = {
  source_shift_id: 'FAKE-2026-09-0-0-0',
  status: 'validado',
  approved_hours: '4.00',
  approved_checkin_at: '2026-09-10T08:00:00.000Z',
  approved_checkout_at: '2026-09-10T12:00:00.000Z',
  approved_checkin_source: 'app',
  validated_by: 'uid-1',
  validated_by_name: 'Fulana QA',
  validated_at: '2026-09-10T13:00:00.000Z',
  reason: null,
  note_encrypted: null,
};

describe('ShiftHoursValidationRepository', () => {
  let repo: ShiftHoursValidationRepository;

  beforeEach(() => {
    mockPoolQuery.mockReset();
    repo = new ShiftHoursValidationRepository();
  });

  describe('getByShiftIds', () => {
    it('devolve mapa vazio sem query quando a lista é vazia', async () => {
      const result = await repo.getByShiftIds([]);
      expect(result.size).toBe(0);
      expect(mockPoolQuery).not.toHaveBeenCalled();
    });

    it('mapeia snake_case → camelCase e number() em approved_hours', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [VALIDATED_ROW] });
      const result = await repo.getByShiftIds(['FAKE-2026-09-0-0-0']);
      expect(result.get('FAKE-2026-09-0-0-0')).toEqual({
        sourceShiftId: 'FAKE-2026-09-0-0-0',
        status: 'validado',
        approvedHours: 4,
        approvedCheckinAt: '2026-09-10T08:00:00.000Z',
        approvedCheckoutAt: '2026-09-10T12:00:00.000Z',
        approvedCheckinSource: 'app',
        validatedBy: 'uid-1',
        validatedByName: 'Fulana QA',
        validatedAt: '2026-09-10T13:00:00.000Z',
        reason: null,
        noteEncrypted: null,
      });
    });

    it('approved_hours null (turno pendente/contestado) NUNCA vira 0 por Number(null)', async () => {
      const pendenteRow = { ...VALIDATED_ROW, status: 'pendente' as const, approved_hours: null };
      mockPoolQuery.mockResolvedValueOnce({ rows: [pendenteRow] });
      const result = await repo.getByShiftIds(['FAKE-2026-09-0-0-0']);
      expect(result.get('FAKE-2026-09-0-0-0')?.approvedHours).toBeNull();
    });
  });

  describe('getOne', () => {
    it('devolve null quando não há linha', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      expect(await repo.getOne('inexistente')).toBeNull();
    });
  });

  describe('validate', () => {
    it('recusa com ShiftAlreadyValidatedError quando já validado', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [VALIDATED_ROW] }); // getOne
      await expect(
        repo.validate({
          sourceShiftId: 'FAKE-2026-09-0-0-0',
          anaCarePatientId: 'AC-PAT-0',
          anaCareNurseId: 'AC-NURSE-0-0',
          periodMonth: '2026-09-01',
          approvedHours: 4,
          approvedCheckinAt: null,
          approvedCheckoutAt: null,
          approvedCheckinSource: null,
          validatedBy: 'uid-2',
        }),
      ).rejects.toBeInstanceOf(ShiftAlreadyValidatedError);
      expect(mockPoolQuery).toHaveBeenCalledTimes(1); // só o getOne, sem INSERT
    });

    it('grava o INSERT ... ON CONFLICT quando não está validado ainda', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // getOne (pendente)
      mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // INSERT
      await repo.validate({
        sourceShiftId: 'FAKE-2026-09-0-0-0',
        anaCarePatientId: 'AC-PAT-0',
        anaCareNurseId: 'AC-NURSE-0-0',
        periodMonth: '2026-09-01',
        approvedHours: 4,
        approvedCheckinAt: '2026-09-10T08:00:00.000Z',
        approvedCheckoutAt: '2026-09-10T12:00:00.000Z',
        approvedCheckinSource: 'app',
        validatedBy: 'uid-2',
      });
      expect(mockPoolQuery).toHaveBeenCalledTimes(2);
      const [sql, params] = mockPoolQuery.mock.calls[1];
      expect(sql).toMatch(/INSERT INTO shift_hours_validation/);
      expect(sql).toMatch(/ON CONFLICT \(source, source_shift_id\) DO UPDATE/);
      expect(params).toEqual([
        'anacare',
        'FAKE-2026-09-0-0-0',
        'AC-PAT-0',
        'AC-NURSE-0-0',
        '2026-09-01',
        4,
        '2026-09-10T08:00:00.000Z',
        '2026-09-10T12:00:00.000Z',
        'app',
        'uid-2',
      ]);
    });
  });

  /**
   * F6.2 (D361, Adendo 17/09): a contagem por paciente que alimenta `validated`/`contested` da
   * LISTA — GROUP BY sobre `shift_hours_validation`, 1 query para o mês inteiro.
   */
  describe('getStatusCountsByMonth', () => {
    it('SELECT com GROUP BY (paciente, status), filtrado por source e period_month', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] });
      const result = await repo.getStatusCountsByMonth('2026-09-01');

      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
      const [sql, params] = mockPoolQuery.mock.calls[0];
      expect(sql).toMatch(/FROM shift_hours_validation/);
      expect(sql).toMatch(/GROUP BY 1, 2/);
      expect(sql).toMatch(/WHERE source = \$1 AND period_month = \$2/);
      expect(params).toEqual(['anacare', '2026-09-01']);
      expect(result.size).toBe(0);
    });

    it('agrupa validado/contestado por paciente no MESMO Map (a 2ª linha do paciente não sobrescreve a 1ª)', async () => {
      mockPoolQuery.mockResolvedValueOnce({
        rows: [
          { ana_care_patient_id: 'AC-PAT-0', status: 'validado', count: '3' },
          { ana_care_patient_id: 'AC-PAT-0', status: 'contestado', count: '1' },
          { ana_care_patient_id: 'AC-PAT-1', status: 'validado', count: '5' },
        ],
      });
      const result = await repo.getStatusCountsByMonth('2026-09-01');

      expect(result.get('AC-PAT-0')).toEqual({ validated: 3, contested: 1 });
      expect(result.get('AC-PAT-1')).toEqual({ validated: 5, contested: 0 });
    });

    it('status "pendente" não entra em validated nem contested (paciente some do resultado se só tiver pendente)', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ ana_care_patient_id: 'AC-PAT-2', status: 'pendente', count: '4' }] });
      const result = await repo.getStatusCountsByMonth('2026-09-01');

      expect(result.get('AC-PAT-2')).toEqual({ validated: 0, contested: 0 });
    });

    it('count vem como string do driver e é convertido para number', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [{ ana_care_patient_id: 'AC-PAT-0', status: 'validado', count: '10' }] });
      const result = await repo.getStatusCountsByMonth('2026-09-01');

      expect(result.get('AC-PAT-0')?.validated).toBe(10);
      expect(typeof result.get('AC-PAT-0')?.validated).toBe('number');
    });
  });

  describe('contest', () => {
    it('recusa com ShiftAlreadyValidatedError quando já validado', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [VALIDATED_ROW] }); // getOne
      await expect(
        repo.contest({
          sourceShiftId: 'FAKE-2026-09-0-0-0',
          anaCarePatientId: 'AC-PAT-0',
          anaCareNurseId: 'AC-NURSE-0-0',
          periodMonth: '2026-09-01',
          reason: 'otro',
          noteEncrypted: null,
        }),
      ).rejects.toBeInstanceOf(ShiftAlreadyValidatedError);
      expect(mockPoolQuery).toHaveBeenCalledTimes(1);
    });

    it('grava o INSERT ... ON CONFLICT quando não está validado ainda', async () => {
      mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // getOne
      mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // INSERT
      await repo.contest({
        sourceShiftId: 'FAKE-2026-09-0-0-0',
        anaCarePatientId: 'AC-PAT-0',
        anaCareNurseId: 'AC-NURSE-0-0',
        periodMonth: '2026-09-01',
        reason: 'no_asistio',
        noteEncrypted: 'Y2lmcmE=',
      });
      expect(mockPoolQuery).toHaveBeenCalledTimes(2);
      const [sql, params] = mockPoolQuery.mock.calls[1];
      expect(sql).toMatch(/INSERT INTO shift_hours_validation/);
      expect(params).toEqual(['anacare', 'FAKE-2026-09-0-0-0', 'AC-PAT-0', 'AC-NURSE-0-0', '2026-09-01', 'no_asistio', 'Y2lmcmE=']);
    });
  });
});
