/**
 * backoff.test.ts — cobre `computeBackoffDelayMs` (achado 2 da F2 de anacare-conferencia-de-horas:
 * as constantes de backoff exponencial+jitter estavam duplicadas literalmente entre
 * `gemini-fetch.ts` e `AnaCareRateLimiter.ts`).
 *
 * O segundo describe é a prova de NÃO-DUPLICAÇÃO em si: lê o texto-fonte dos dois arquivos e
 * exige que ambos importem do módulo compartilhado, e que nenhum dos dois volte a declarar as
 * constantes localmente. Puramente estrutural — porque o defeito (duplicação) não muda o valor
 * numérico calculado (os dois arquivos já calculavam a MESMA fórmula), então um teste de
 * comportamento não pegaria a regressão; só a inspeção da fonte prova que a extração aconteceu.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  computeBackoffDelayMs,
  BACKOFF_BASE_DELAY_MS,
  BACKOFF_FACTOR,
  BACKOFF_MAX_DELAY_MS,
  BACKOFF_JITTER_RATIO,
} from '../backoff';

describe('computeBackoffDelayMs — fórmula exponencial+jitter', () => {
  it('sem jitter (random=0.5 -> jitter 0), cresce exponencialmente com o fator configurado', () => {
    const fixedRandom = () => 0.5; // (0.5*2 - 1) = 0 => jitter zero
    expect(computeBackoffDelayMs(0, { random: fixedRandom })).toBe(BACKOFF_BASE_DELAY_MS);
    expect(computeBackoffDelayMs(1, { random: fixedRandom })).toBe(
      Math.round(BACKOFF_BASE_DELAY_MS * BACKOFF_FACTOR),
    );
  });

  it('satura em maxDelayMs mesmo com attempt grande', () => {
    const fixedRandom = () => 0.5;
    const delay = computeBackoffDelayMs(20, { random: fixedRandom });
    expect(delay).toBe(BACKOFF_MAX_DELAY_MS);
  });

  it('jitter respeita o raio configurado (±JITTER_RATIO do valor capado)', () => {
    const capped = BACKOFF_BASE_DELAY_MS; // attempt=0, sem estouro do teto
    const maxJitter = capped * BACKOFF_JITTER_RATIO;

    const highRandom = () => 1; // jitter máximo positivo
    const lowRandom = () => 0; // jitter máximo negativo

    expect(computeBackoffDelayMs(0, { random: highRandom })).toBe(Math.round(capped + maxJitter));
    expect(computeBackoffDelayMs(0, { random: lowRandom })).toBe(Math.round(capped - maxJitter));
  });

  it('aceita override de baseDelayMs/factor/maxDelayMs/jitterRatio por chamador', () => {
    const fixedRandom = () => 0.5;
    const delay = computeBackoffDelayMs(0, {
      baseDelayMs: 100,
      factor: 3,
      maxDelayMs: 5000,
      jitterRatio: 0,
      random: fixedRandom,
    });
    expect(delay).toBe(100);
  });
});

describe('backoff — módulo é a ÚNICA fonte da constante (achado 2, sem duplicação)', () => {
  const rateLimiterSrc = fs.readFileSync(
    path.join(__dirname, '../../../modules/integration/infrastructure/anacare/AnaCareRateLimiter.ts'),
    'utf8',
  );
  const geminiFetchSrc = fs.readFileSync(
    path.join(__dirname, '../../../modules/integration/infrastructure/gemini-fetch.ts'),
    'utf8',
  );

  it('AnaCareRateLimiter.ts importa a fórmula do módulo compartilhado shared/http/backoff', () => {
    expect(rateLimiterSrc).toMatch(/from ['"].*shared\/http\/backoff['"]/);
  });

  it('gemini-fetch.ts importa a fórmula do módulo compartilhado shared/http/backoff', () => {
    expect(geminiFetchSrc).toMatch(/from ['"].*shared\/http\/backoff['"]/);
  });

  it('AnaCareRateLimiter.ts não redeclara as constantes numéricas do backoff', () => {
    expect(rateLimiterSrc).not.toMatch(/const\s+BASE_DELAY_MS\s*=\s*700/);
    expect(rateLimiterSrc).not.toMatch(/const\s+BACKOFF_FACTOR\s*=\s*2\.5/);
    expect(rateLimiterSrc).not.toMatch(/const\s+MAX_DELAY_MS\s*=\s*8000/);
    expect(rateLimiterSrc).not.toMatch(/const\s+JITTER_RATIO\s*=\s*0\.25/);
  });

  it('gemini-fetch.ts não redeclara as constantes numéricas do backoff', () => {
    expect(geminiFetchSrc).not.toMatch(/const\s+BASE_DELAY_MS\s*=\s*700/);
    expect(geminiFetchSrc).not.toMatch(/const\s+BACKOFF_FACTOR\s*=\s*2\.5/);
    expect(geminiFetchSrc).not.toMatch(/const\s+MAX_DELAY_MS\s*=\s*8000/);
    expect(geminiFetchSrc).not.toMatch(/const\s+JITTER_RATIO\s*=\s*0\.25/);
  });
});
