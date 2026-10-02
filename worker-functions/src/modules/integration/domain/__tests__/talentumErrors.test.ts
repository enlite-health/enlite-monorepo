import { DEAD_PROJECT_MESSAGE, isDeadProjectError } from '../talentumErrors';

describe('talentumErrors', () => {
  it('404 do cliente (HTTP 404 no texto) é projeto morto', () => {
    expect(isDeadProjectError(new Error('[TalentumApiClient] GET /projects/x — HTTP 404: {}'))).toBe(true);
  });

  it('outros status e valores que não são Error não são projeto morto', () => {
    expect(isDeadProjectError(new Error('[TalentumApiClient] GET /projects/x — HTTP 403: {}'))).toBe(false);
    expect(isDeadProjectError(new Error('HTTP 500'))).toBe(false);
    expect(isDeadProjectError('HTTP 404')).toBe(false);
    expect(isDeadProjectError(undefined)).toBe(false);
  });

  it('a mensagem manda rodar a reconciliação', () => {
    expect(DEAD_PROJECT_MESSAGE).toContain('rode a reconciliação');
  });
});
