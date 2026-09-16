/**
 * isTransientHttpStatus.test.ts — cobre a função pura de classificação de status HTTP
 * transiente e prova a NÃO-DUPLICAÇÃO entre `AnaCareSessionClient.ts` (classifica o
 * `Response.status` bruto do fetch) e `AnaCareRateLimiter.ts` (classifica
 * `AnaCareHttpError.status` no `defaultIsTransient`) — achado do gate `revisao-pr` na F2 de
 * `anacare-conferencia-de-horas`, mesmo padrão de prova de `backoff.test.ts` (achado 2): a
 * inspeção do texto-fonte é necessária porque os dois arquivos já calculavam a MESMA lista de
 * status antes da extração — um teste de comportamento isolado não pegaria a regressão de
 * duplicação voltar.
 */
import * as fs from 'fs';
import * as path from 'path';
import { isTransientHttpStatus } from '../isTransientHttpStatus';

describe('isTransientHttpStatus — classificação pura de status HTTP', () => {
  it('200 (sucesso) não é transiente', () => {
    expect(isTransientHttpStatus(200)).toBe(false);
  });

  it('404 (definitivo, não retryable) não é transiente', () => {
    expect(isTransientHttpStatus(404)).toBe(false);
  });

  it('403 (tratado por re-login, não pelo retry) não é transiente', () => {
    expect(isTransientHttpStatus(403)).toBe(false);
  });

  it('429 (rate limit) é transiente', () => {
    expect(isTransientHttpStatus(429)).toBe(true);
  });

  it('bordas da faixa 5xx (500 e 599) são transientes', () => {
    expect(isTransientHttpStatus(500)).toBe(true);
    expect(isTransientHttpStatus(599)).toBe(true);
  });

  it('503 (meio da faixa 5xx) é transiente', () => {
    expect(isTransientHttpStatus(503)).toBe(true);
  });

  it('600 e 428 (fora de toda faixa transiente) não são transientes', () => {
    expect(isTransientHttpStatus(600)).toBe(false);
    expect(isTransientHttpStatus(428)).toBe(false);
  });
});

describe('isTransientHttpStatus — módulo é a ÚNICA fonte da lista de status (sem duplicação)', () => {
  const sessionClientSrc = fs.readFileSync(
    path.join(__dirname, '../../../modules/integration/infrastructure/anacare/AnaCareSessionClient.ts'),
    'utf8',
  );
  const rateLimiterSrc = fs.readFileSync(
    path.join(__dirname, '../../../modules/integration/infrastructure/anacare/AnaCareRateLimiter.ts'),
    'utf8',
  );

  it('AnaCareSessionClient.ts importa a classificação do módulo compartilhado shared/http/isTransientHttpStatus', () => {
    expect(sessionClientSrc).toMatch(/from ['"].*shared\/http\/isTransientHttpStatus['"]/);
  });

  it('AnaCareRateLimiter.ts importa a classificação do módulo compartilhado shared/http/isTransientHttpStatus', () => {
    expect(rateLimiterSrc).toMatch(/from ['"].*shared\/http\/isTransientHttpStatus['"]/);
  });

  it('AnaCareSessionClient.ts não redeclara a faixa de status 429/5xx localmente', () => {
    expect(sessionClientSrc).not.toMatch(/status\s*===\s*429\s*\|\|\s*\(?\s*status\s*>=\s*500/);
  });

  it('AnaCareRateLimiter.ts não redeclara a faixa de status 429/5xx localmente', () => {
    expect(rateLimiterSrc).not.toMatch(/\.status\s*===\s*429\s*\|\|\s*\(?\s*\w+\.status\s*>=\s*500/);
  });
});
