/**
 * cli-guards — F1-CORREÇÃO D10. Ver ../cli-guards.ts para o porquê.
 */
import { parsePromoteFlag, extractReleaseFromApiBase, assertReleaseMatchesApiBase, InvalidCliUsageError, parseConcurrencyFlag } from '../cli-guards';

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

/**
 * F1.6 — `--concurrency` (gate `revisao-pr`, BLOQUEADOR 4).
 *
 * `Number('abc')` é `NaN`; `NaN` workers fazia o crawl terminar com ZERO entidades e o script
 * imprimir `✅ Ingestão concluída` com exit 0. Contagem zero tratada como sucesso — o modo de
 * falha que o CLAUDE.md nomeia. Default só quando a flag está AUSENTE; valor ruim é ERRO.
 */
describe('parseConcurrencyFlag', () => {
  it('flag ausente → default 16 (uso normal)', () => {
    expect(parseConcurrencyFlag([])).toBe(16);
    expect(parseConcurrencyFlag(['--release', '2026-01'])).toBe(16);
  });

  it('respeita o default recebido quando a flag está ausente', () => {
    expect(parseConcurrencyFlag([], 8)).toBe(8);
  });

  it('valor inteiro válido passa', () => {
    expect(parseConcurrencyFlag(['--concurrency', '1'])).toBe(1);
    expect(parseConcurrencyFlag(['--concurrency', '32'])).toBe(32);
    expect(parseConcurrencyFlag(['--concurrency', '64'])).toBe(64);
  });

  it('NÃO-numérico é erro — era o NaN que zerava o crawl', () => {
    expect(() => parseConcurrencyFlag(['--concurrency', 'abc'])).toThrow(InvalidCliUsageError);
    expect(() => parseConcurrencyFlag(['--concurrency', 'abc'])).toThrow(/não é inteiro entre 1 e 64/);
  });

  it('zero e negativo são erro (0 workers = catálogo vazio anunciando sucesso)', () => {
    expect(() => parseConcurrencyFlag(['--concurrency', '0'])).toThrow(/não é inteiro entre 1 e 64/);
    expect(() => parseConcurrencyFlag(['--concurrency', '-5'])).toThrow(/não é inteiro entre 1 e 64/);
  });

  it('acima do teto é erro (não vira martelo contra o container da OMS)', () => {
    expect(() => parseConcurrencyFlag(['--concurrency', '999'])).toThrow(/não é inteiro entre 1 e 64/);
  });

  it('fracionário é erro', () => {
    expect(() => parseConcurrencyFlag(['--concurrency', '2.5'])).toThrow(/não é inteiro entre 1 e 64/);
  });

  it('flag sem valor é erro — nunca cai no default em silêncio', () => {
    expect(() => parseConcurrencyFlag(['--concurrency'])).toThrow(/exige um valor inteiro positivo/);
    expect(() => parseConcurrencyFlag(['--concurrency', '--release'])).toThrow(/exige um valor inteiro positivo/);
  });
});
