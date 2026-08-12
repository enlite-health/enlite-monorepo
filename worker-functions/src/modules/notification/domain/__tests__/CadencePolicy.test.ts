import { CadencePolicy } from '../CadencePolicy';

describe('CadencePolicy', () => {
  describe('maxSends', () => {
    it('é gaps.length + 1', () => {
      expect(new CadencePolicy([]).maxSends).toBe(1);
      expect(new CadencePolicy([3]).maxSends).toBe(2);
      expect(new CadencePolicy([3, 7]).maxSends).toBe(3);
    });
  });

  describe('validação', () => {
    it('rejeita gaps não-inteiros ou negativos', () => {
      expect(() => new CadencePolicy([3, -1])).toThrow();
      expect(() => new CadencePolicy([3.5])).toThrow();
    });

    it('não muta o array recebido', () => {
      const gaps = [3, 7];
      const policy = new CadencePolicy(gaps);
      gaps.push(99);
      expect(policy.maxSends).toBe(3);
    });
  });

  describe('toSqlEligibility', () => {
    const policy = new CadencePolicy([3, 7]);
    const sql = policy.toSqlEligibility('COALESCE(ss.total_sent, 0)', 'ss.last_sent_at');

    it('libera o primeiro envio quando total = 0', () => {
      expect(sql).toContain('COALESCE(ss.total_sent, 0) = 0');
    });

    it('exige gap de 3 dias para o 2º envio e 7 dias para o 3º', () => {
      expect(sql).toContain(
        "COALESCE(ss.total_sent, 0) = 1 AND ss.last_sent_at < NOW() - INTERVAL '3 days'",
      );
      expect(sql).toContain(
        "COALESCE(ss.total_sent, 0) = 2 AND ss.last_sent_at < NOW() - INTERVAL '7 days'",
      );
    });

    it('aplica o cap (cap = maxSends)', () => {
      expect(sql).toContain('COALESCE(ss.total_sent, 0) < 3');
    });

    it('não permite envio em dias consecutivos (não há INTERVAL 1 day para resends)', () => {
      expect(sql).not.toContain("INTERVAL '1 days'");
    });
  });
});
