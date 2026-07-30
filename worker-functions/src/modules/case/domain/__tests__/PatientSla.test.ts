import {
  derivePatientSla,
  PATIENT_SLA_THRESHOLDS_HOURS,
} from '../PatientSla';

const NOW = new Date('2026-07-29T12:00:00Z');

function hoursAgo(h: number): Date {
  return new Date(NOW.getTime() - h * 3_600_000);
}

describe('derivePatientSla', () => {
  describe('thresholds por status', () => {
    it('SOLICITANTE tem teto 24h', () => {
      expect(PATIENT_SLA_THRESHOLDS_HOURS.SOLICITANTE).toBe(24);
    });
    it('ADMISSION tem teto 48h', () => {
      expect(PATIENT_SLA_THRESHOLDS_HOURS.ADMISSION).toBe(48);
    });
    it('PENDING_ADMISSION tem teto 72h', () => {
      expect(PATIENT_SLA_THRESHOLDS_HOURS.PENDING_ADMISSION).toBe(72);
    });
    it.each(['ACTIVE', 'SUSPENDED', 'DISCONTINUED', 'DISCHARGED'])(
      '%s não tem SLA (null)',
      (status) => {
        expect(PATIENT_SLA_THRESHOLDS_HOURS[status]).toBeNull();
      },
    );
  });

  describe('hoursInStage (floor)', () => {
    it('calcula horas inteiras desde stageEnteredAt', () => {
      const sla = derivePatientSla('SOLICITANTE', hoursAgo(5), NOW);
      expect(sla.hoursInStage).toBe(5);
    });
    it('faz floor de horas fracionadas', () => {
      const sla = derivePatientSla('SOLICITANTE', new Date(NOW.getTime() - 90 * 60 * 1000), NOW);
      expect(sla.hoursInStage).toBe(1); // 1.5h → 1
    });
    it('nunca negativo se stageEnteredAt no futuro (clock skew)', () => {
      const sla = derivePatientSla('SOLICITANTE', hoursAgo(-3), NOW);
      expect(sla.hoursInStage).toBe(0);
    });
    it('devolve ISO em stageEnteredAt', () => {
      const at = hoursAgo(5);
      const sla = derivePatientSla('SOLICITANTE', at, NOW);
      expect(sla.stageEnteredAt).toBe(at.toISOString());
    });
  });

  describe('slaBreached', () => {
    it('false quando dentro do teto (SOLICITANTE, 23h < 24)', () => {
      const sla = derivePatientSla('SOLICITANTE', hoursAgo(23), NOW);
      expect(sla.slaBreached).toBe(false);
      expect(sla.slaThresholdHours).toBe(24);
    });
    it('false exatamente no teto (24h, > é estrito)', () => {
      const sla = derivePatientSla('SOLICITANTE', hoursAgo(24), NOW);
      expect(sla.slaBreached).toBe(false);
    });
    it('true acima do teto (SOLICITANTE, 25h > 24)', () => {
      const sla = derivePatientSla('SOLICITANTE', hoursAgo(25), NOW);
      expect(sla.slaBreached).toBe(true);
    });
    it('true para ADMISSION 50h > 48', () => {
      const sla = derivePatientSla('ADMISSION', hoursAgo(50), NOW);
      expect(sla.slaBreached).toBe(true);
      expect(sla.slaThresholdHours).toBe(48);
    });
    it('nunca breach em estágio sem SLA, mesmo com muitas horas', () => {
      const sla = derivePatientSla('ACTIVE', hoursAgo(1000), NOW);
      expect(sla.slaThresholdHours).toBeNull();
      expect(sla.slaBreached).toBe(false);
      expect(sla.hoursInStage).toBe(1000); // informativo, sem cobrança
    });
  });

  describe('bordas', () => {
    it('stageEnteredAt null → tudo null e sem breach', () => {
      const sla = derivePatientSla('SOLICITANTE', null, NOW);
      expect(sla).toEqual({
        stageEnteredAt: null,
        hoursInStage: null,
        slaThresholdHours: 24,
        slaBreached: false,
      });
    });
    it('status null (ClickUp não reconhecido) → threshold null, sem breach', () => {
      const sla = derivePatientSla(null, hoursAgo(500), NOW);
      expect(sla.slaThresholdHours).toBeNull();
      expect(sla.slaBreached).toBe(false);
    });
    it('status desconhecido → threshold null', () => {
      const sla = derivePatientSla('WHATEVER', hoursAgo(10), NOW);
      expect(sla.slaThresholdHours).toBeNull();
      expect(sla.slaBreached).toBe(false);
    });
  });
});
