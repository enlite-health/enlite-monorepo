/**
 * cli-guards — F1-CORREÇÃO D10. Ver ../cli-guards.ts para o porquê.
 */
import { parsePromoteFlag, extractReleaseFromApiBase, assertReleaseMatchesApiBase, InvalidCliUsageError } from '../cli-guards';

describe('parsePromoteFlag', () => {
  it('flag ausente devolve undefined (uso normal: crawl)', () => {
    expect(parsePromoteFlag(['--dry-run'])).toBeUndefined();
  });

  it('flag com valor devolve o valor', () => {
    expect(parsePromoteFlag(['--promote', '2026-01', '--by', 'gabriel'])).toBe('2026-01');
  });

  it('flag como ÚLTIMO arg (sem valor) lança — nunca cai em crawl silencioso (D10)', () => {
    expect(() => parsePromoteFlag(['--promote'])).toThrow(InvalidCliUsageError);
  });

  it('flag seguida de OUTRA flag (valor esquecido) também lança', () => {
    expect(() => parsePromoteFlag(['--promote', '--by', 'gabriel'])).toThrow(InvalidCliUsageError);
  });
});

describe('extractReleaseFromApiBase', () => {
  it('extrai o release do path padrão', () => {
    expect(extractReleaseFromApiBase('http://localhost:8085/icd/release/11/2026-01/mms')).toBe('2026-01');
  });

  it('devolve null quando o marcador não existe', () => {
    expect(extractReleaseFromApiBase('http://localhost:8085/rota-qualquer')).toBeNull();
  });

  it('devolve null quando o marcador existe mas o segmento de release está vazio (barra dupla)', () => {
    expect(extractReleaseFromApiBase('http://localhost:8085/icd/release/11//mms')).toBeNull();
  });
});

describe('assertReleaseMatchesApiBase — a defesa de entrada que fecha o caminho do D1', () => {
  it('não lança quando --release bate com o release da URL', () => {
    expect(() =>
      assertReleaseMatchesApiBase('2026-01', 'http://localhost:8085/icd/release/11/2026-01/mms'),
    ).not.toThrow();
  });

  it('lança quando --release diverge do release da URL — a reprodução exata do D1', () => {
    expect(() =>
      assertReleaseMatchesApiBase('2026-05', 'http://localhost:8085/icd/release/11/2026-01/mms'),
    ).toThrow(InvalidCliUsageError);
  });

  it('lança quando --api-base não tem o marcador esperado — sem validar, não assume que está certo', () => {
    expect(() => assertReleaseMatchesApiBase('2026-01', 'http://localhost:8085/rota-errada')).toThrow(
      InvalidCliUsageError,
    );
  });
});
