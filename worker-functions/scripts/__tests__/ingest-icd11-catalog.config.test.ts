/**
 * F1-CORREÇÃO D10 — `buildRuntimeConfig` é o ponto de integração onde as duas defesas de
 * `icd11-ingest/cli-guards.ts` entram no CLI de verdade. Puro (sem HTTP, sem `pg`) — nada disto
 * toca rede ou banco; a prova end-to-end com o container real está no relatório (§9/evidências).
 */
import { buildRuntimeConfig, HELP_TEXT } from '../ingest-icd11-catalog';
import { InvalidCliUsageError } from '../icd11-ingest/cli-guards';

const env = { ICD11_API_BASE: undefined, ICD11_RELEASE: undefined, USER: undefined } as unknown as NodeJS.ProcessEnv;

describe('buildRuntimeConfig', () => {
  it('sem argumentos: usa os defaults (crawl, release/api-base padrão coerentes entre si)', () => {
    const config = buildRuntimeConfig([], env);
    expect(config.promoteRelease).toBeUndefined();
    expect(config.dryRun).toBe(false);
    expect(config.release).toBe('2026-01');
    expect(config.apiBase).toBe('http://localhost:8085/icd/release/11/2026-01/mms');
    expect(config.concurrency).toBe(16);
  });

  it('--dry-run e --concurrency são lidos', () => {
    const config = buildRuntimeConfig(['--dry-run', '--concurrency', '4'], env);
    expect(config.dryRun).toBe(true);
    expect(config.concurrency).toBe(4);
  });

  it('D10 — --promote sem valor LANÇA, nunca cai silenciosamente no ramo de crawl', () => {
    expect(() => buildRuntimeConfig(['--promote'], env)).toThrow(InvalidCliUsageError);
  });

  it('--promote com valor não valida release×api-base (não crawla, nada para validar)', () => {
    const config = buildRuntimeConfig(['--promote', '2026-01', '--by', 'gabriel'], env);
    expect(config.promoteRelease).toBe('2026-01');
    expect(config.promotedBy).toBe('gabriel');
  });

  it('D10 — --release divergente do release embutido em --api-base LANÇA (a reprodução exata do D1)', () => {
    expect(() =>
      buildRuntimeConfig(['--release', '2026-05', '--api-base', 'http://localhost:8085/icd/release/11/2026-01/mms'], env),
    ).toThrow(InvalidCliUsageError);
  });

  it('--release coerente com --api-base não lança', () => {
    const config = buildRuntimeConfig(
      ['--release', '2026-05', '--api-base', 'http://localhost:8085/icd/release/11/2026-05/mms'],
      env,
    );
    expect(config.release).toBe('2026-05');
  });

  it('--by ausente cai para $USER, e na ausência de ambos para "desconhecido"', () => {
    const withUser = buildRuntimeConfig(['--promote', '2026-01'], { ...env, USER: 'ana' } as NodeJS.ProcessEnv);
    expect(withUser.promotedBy).toBe('ana');
    const semNada = buildRuntimeConfig(['--promote', '2026-01'], env);
    expect(semNada.promotedBy).toBe('desconhecido');
  });

  it('HELP_TEXT documenta as opções principais', () => {
    expect(HELP_TEXT).toMatch(/--promote/);
    expect(HELP_TEXT).toMatch(/--dry-run/);
  });
});
