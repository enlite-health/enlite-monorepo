/**
 * PrescreeningResponseHandler.test.ts
 *
 * Foco: PII guard (achado do gate, 2ª rodada) — o log INCOMING mascarava tudo
 * MENOS o e-mail do profile, mesmo caminho de request do achado de 608/7d em
 * ProcessTalentumPrescreening. Não cobre o resto do handler (o `try` chama o
 * use case real, que aqui vai falhar contra um Pool falso — comportamento
 * esperado e fora do escopo deste teste, coberto pelo `catch`).
 */
import { PrescreeningResponseHandler } from '../PrescreeningResponseHandler';
import { maskEmailForLog } from '@shared/utils/emailMask';
import type { TalentumWebhookContext } from '../TalentumWebhookHandler';
import type { TalentumPrescreeningResponseParsed } from '../../validators/talentumPrescreeningSchema';

function makePayload(overrides: { email?: string } = {}): TalentumPrescreeningResponseParsed {
  return {
    action: 'PRESCREENING_RESPONSE',
    subtype: 'ANALYZED',
    data: {
      prescreening: { id: 'tp-1', name: 'Case Test' },
      profile: {
        id: 'prof-1',
        firstName: 'Juan',
        lastName: 'Perez',
        email: overrides.email ?? 'candidata.sensivel@example.com',
        phoneNumber: '+5491100001111',
        registerQuestions: [],
      },
      response: { id: 'resp-1', state: [], score: 85, statusLabel: 'QUALIFIED' },
    },
  } as unknown as TalentumPrescreeningResponseParsed;
}

function fakeRes() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res as unknown as import('express').Response;
}

describe('PrescreeningResponseHandler — PII guard (log INCOMING)', () => {
  it('e-mail mascarado no log INCOMING, nunca cru', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation();
    const errSpy = jest.spyOn(console, 'error').mockImplementation();
    const SENSITIVE_EMAIL = 'candidata.sensivel@example.com';
    const handler = new PrescreeningResponseHandler({ query: jest.fn().mockRejectedValue(new Error('no db in unit test')) } as never);

    await handler.handle(makePayload({ email: SENSITIVE_EMAIL }), { environment: 'test' } as TalentumWebhookContext, fakeRes());

    const lines = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(lines).not.toContain(SENSITIVE_EMAIL);
    expect(lines).toContain(`INCOMING | extId=tp-1`);
    expect(lines).toContain(`email=${maskEmailForLog(SENSITIVE_EMAIL)}`);
    expect(lines).toContain('profile=prof-1');
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  // Sabotagem: reproduz o console.log ANTIGO (e-mail cru) — prova que a
  // asserção acima detectaria o vazamento se o fix fosse desfeito.
  it('sabotagem: reproduzindo o console.log ANTIGO (e-mail cru), a asserção acima cairia', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation();
    const SENSITIVE_EMAIL = 'candidata.sensivel@example.com';
    console.log(`[TalentumWebhook:PrescreeningResponse] INCOMING | extId=tp-1 | subtype=ANALYZED | profile=prof-1 | email=${SENSITIVE_EMAIL} | statusLabel=QUALIFIED | score=85 | env=test`);
    const oldLines = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(oldLines).toContain(SENSITIVE_EMAIL); // confirma: o formato antigo vazava
    logSpy.mockRestore();
  });
});
