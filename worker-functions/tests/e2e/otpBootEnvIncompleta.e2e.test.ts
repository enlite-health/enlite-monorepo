/**
 * E11 (B5): boot com env do OTP incompleta sai com erro que cita só os NOMES das envs. Sem Supertest nem banco: o objeto é o processo.
 * `createOtpChallengePort()` roda num processo filho (como o `index.ts` o chama na importação) com env mínima.
 */
import { spawnSync } from 'child_process';
import { join } from 'path';

const CWD = join(__dirname, '../..');
const VALORES = { sid: 'HX_marcado_e11', conta: 'AC_marcado_e11', token: 'tok_marcado_e11' };
const PEPPER_CURTO = 'pepper-marcado-curto-e11-xxxxxx'; // 31 caracteres
const MARCADOS = [VALORES.sid, VALORES.conta, VALORES.token, PEPPER_CURTO];

function boot(extra: Record<string, string>) {
  return spawnSync(
    process.execPath,
    ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register', '-e', "require('./src/bootstrap/createOtpChallengePort').createOtpChallengePort()"],
    {
      cwd: CWD,
      encoding: 'utf8',
      timeout: 50000,
      env: {
        PATH: process.env.PATH ?? '',
        TWILIO_AUTH_TEMPLATE_CONTENT_SID: VALORES.sid,
        TWILIO_ACCOUNT_SID: VALORES.conta,
        TWILIO_AUTH_TOKEN: VALORES.token,
        TWILIO_WHATSAPP_NUMBER: '+5491100000000',
        ...extra,
      },
    },
  );
}

describe('E11: boot com env do OTP incompleta', () => {
  it.each([
    ['(a) sem OTP_HMAC_PEPPER', {}],
    ['(b) OTP_HMAC_PEPPER de 31 caracteres', { OTP_HMAC_PEPPER: PEPPER_CURTO }],
  ])('%s: status != 0, stderr cita o NOME da env e nenhum valor marcado', (_nome, extra) => {
    const r = boot(extra);
    console.info('E11', _nome, JSON.stringify({ status: r.status, stderrCitaNome: (r.stderr ?? '').includes('OTP_HMAC_PEPPER') }));
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('OTP_HMAC_PEPPER');
    for (const marcado of MARCADOS) {
      expect(r.stderr).not.toContain(marcado);
      expect(r.stdout).not.toContain(marcado);
    }
  });
});
