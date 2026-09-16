import { isAnaCareHoursAllowedEmail } from '../anaCareHoursAllowlist';

describe('isAnaCareHoursAllowedEmail', () => {
  const env = (raw: string | undefined): NodeJS.ProcessEnv =>
    ({ ANACARE_HOURS_ALLOWED_EMAILS: raw } as unknown as NodeJS.ProcessEnv);

  const ALLOWLIST = 'marcel@enlite.health;gabriel.g.stein@gmail.com;sonez.elizabeth@enlite.health';

  it('email na lista, minúsculo, passa', () => {
    expect(isAnaCareHoursAllowedEmail('gabriel.g.stein@gmail.com', env(ALLOWLIST))).toBe(true);
  });

  it('normaliza maiúsculas e espaço nas pontas do email de entrada', () => {
    expect(isAnaCareHoursAllowedEmail('  Gabriel.G.Stein@Gmail.com  ', env(ALLOWLIST))).toBe(true);
  });

  it('email fora da lista falha (403)', () => {
    expect(isAnaCareHoursAllowedEmail('outro@enlite.health', env(ALLOWLIST))).toBe(false);
  });

  it('email null falha, mesmo com allowlist configurada', () => {
    expect(isAnaCareHoursAllowedEmail(null, env(ALLOWLIST))).toBe(false);
  });

  it('email undefined falha', () => {
    expect(isAnaCareHoursAllowedEmail(undefined, env(ALLOWLIST))).toBe(false);
  });

  it('email vazio falha', () => {
    expect(isAnaCareHoursAllowedEmail('', env(ALLOWLIST))).toBe(false);
  });

  it('env ausente = fail-closed, mesmo para os 3 emails legítimos', () => {
    expect(isAnaCareHoursAllowedEmail('marcel@enlite.health', env(undefined))).toBe(false);
  });

  it('env vazia = fail-closed', () => {
    expect(isAnaCareHoursAllowedEmail('marcel@enlite.health', env(''))).toBe(false);
  });

  it('espaço em volta de cada email da lista é tolerado (trim por item)', () => {
    expect(isAnaCareHoursAllowedEmail('marcel@enlite.health', env(' marcel@enlite.health ; gabriel.g.stein@gmail.com '))).toBe(true);
  });

  it('os 3 emails da decisão final passam', () => {
    expect(isAnaCareHoursAllowedEmail('marcel@enlite.health', env(ALLOWLIST))).toBe(true);
    expect(isAnaCareHoursAllowedEmail('gabriel.g.stein@gmail.com', env(ALLOWLIST))).toBe(true);
    expect(isAnaCareHoursAllowedEmail('sonez.elizabeth@enlite.health', env(ALLOWLIST))).toBe(true);
  });
});
