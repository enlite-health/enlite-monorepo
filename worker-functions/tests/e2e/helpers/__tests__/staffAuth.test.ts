/**
 * Unit do `staffAuth` — `axios` MOCKADO de propósito: sem isso o teste depende
 * de o emulador do Firebase estar de pé ou não na máquina que roda (na CI
 * nunca está; numa stack local `test:e2e:full` está), e o mesmo teste passaria
 * num ambiente e quebraria no outro — não é determinístico. Mockando a sonda
 * (`axios.get`) e as chamadas do emulador (`axios.post`), os DOIS ramos do
 * helper (mock e emulador) rodam sempre, em qualquer máquina.
 *
 * `emulatorUp` (staffAuth.ts:18) é cache MODULE-LEVEL: uma vez sondado, o
 * mesmo módulo não sonda de novo. Por isso cada teste usa `jest.isolateModules`
 * para pegar uma cópia NOVA do módulo (e do automock de `axios` dentro do
 * MESMO sandbox) — configurar o axios e importar `staffAuth` no mesmo
 * `isolateModules` garante que o helper enxerga o mock que este teste armou,
 * não o de um teste anterior.
 *
 * `country` é OPCIONAL nos dois ramos: sem ele, o claim/`customAttributes`
 * tem que sair IDÊNTICO ao que o helper gerava antes desta mudança — é o
 * teste que MORRE se o default silenciosamente virar outro valor ou se o
 * campo aparecer mesmo sem ser pedido.
 */
import type { StaffAuth } from '../staffAuth';

jest.mock('axios');

type StaffAuthFn = (
  uid: string,
  role: 'admin' | 'recruiter' | 'community_manager',
  country?: string,
) => Promise<StaffAuth>;

/** Sandbox novo com `axios.get` rejeitando — força o ramo MOCK (sem emulador). */
function carregarComEmuladorIndisponivel(): StaffAuthFn {
  let staffAuth!: StaffAuthFn;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const axios = require('axios');
    axios.get.mockRejectedValue(new Error('ECONNREFUSED (mockado — sem emulador)'));
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ({ staffAuth } = require('../staffAuth'));
  });
  return staffAuth;
}

/**
 * Sandbox novo com `axios.get` resolvendo — força o ramo EMULADOR. `captura`
 * recebe o `customAttributes` enviado ao `accounts:update`, para inspecionar
 * se `country` chegou ou não.
 */
function carregarComEmuladorDisponivel(captura: { customAttributes?: string }): StaffAuthFn {
  let staffAuth!: StaffAuthFn;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const axios = require('axios');
    axios.get.mockResolvedValue({ status: 200 });
    axios.post.mockImplementation((url: string, body?: unknown) => {
      if (url.includes('accounts:signUp')) {
        return Promise.resolve({ status: 200, data: { localId: 'local-fake-id' } });
      }
      if (url.includes('accounts:update')) {
        captura.customAttributes = (body as { customAttributes: string }).customAttributes;
        return Promise.resolve({ status: 200, data: {} });
      }
      if (url.includes('signInWithPassword')) {
        return Promise.resolve({ status: 200, data: { idToken: 'fake-id-token', localId: 'local-fake-id' } });
      }
      return Promise.reject(new Error(`URL inesperada no mock: ${url}`));
    });
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    ({ staffAuth } = require('../staffAuth'));
  });
  return staffAuth;
}

function decodeMockClaim(authorizationHeader: string): Record<string, unknown> {
  const token = authorizationHeader.replace('Bearer mock_', '');
  return JSON.parse(Buffer.from(token, 'base64').toString());
}

describe('staffAuth — ramo MOCK (sonda mockada, força emulador indisponível)', () => {
  it('sem country: claim idêntico ao comportamento anterior — só uid, email, role', async () => {
    const staffAuth = carregarComEmuladorIndisponivel();
    const auth = await staffAuth('u-sem-country', 'admin');
    expect(decodeMockClaim(auth.headers.Authorization)).toEqual({
      uid: 'u-sem-country',
      email: 'u-sem-country@e2e.local',
      role: 'admin',
    });
    expect(auth.uid).toBe('u-sem-country');
  });

  it('com country: claim carrega o valor pedido', async () => {
    const staffAuth = carregarComEmuladorIndisponivel();
    const auth = await staffAuth('u-com-country', 'recruiter', 'AR');
    expect(decodeMockClaim(auth.headers.Authorization)).toEqual({
      uid: 'u-com-country',
      email: 'u-com-country@e2e.local',
      role: 'recruiter',
      country: 'AR',
    });
  });
});

describe('staffAuth — ramo EMULADOR (sonda mockada, força emulador disponível)', () => {
  it('sem country: customAttributes NÃO leva o campo (idêntico ao comportamento anterior)', async () => {
    const captura: { customAttributes?: string } = {};
    const staffAuth = carregarComEmuladorDisponivel(captura);
    const auth = await staffAuth('u-emu-sem-country', 'admin');

    expect(JSON.parse(captura.customAttributes as string)).toEqual({ role: 'admin' });
    expect(auth.headers.Authorization).toBe('Bearer fake-id-token');
    expect(auth.uid).toBe('local-fake-id');
  });

  it('com country: customAttributes leva o valor pedido', async () => {
    const captura: { customAttributes?: string } = {};
    const staffAuth = carregarComEmuladorDisponivel(captura);
    await staffAuth('u-emu-com-country', 'recruiter', 'BR');

    expect(JSON.parse(captura.customAttributes as string)).toEqual({ role: 'recruiter', country: 'BR' });
  });
});
