jest.mock('@shared/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { logger } from '@shared/logging';
import { ProvisionCountryClaimUseCase } from '../ProvisionCountryClaimUseCase';
import type { ICountryClaimPort } from '../../ports/ICountryClaimPort';

const WORKER = { accountType: null, roles: [] };

function port(impl?: ICountryClaimPort['ensureCountry']): ICountryClaimPort & { ensureCountry: jest.Mock } {
  return { ensureCountry: jest.fn(impl ?? (async () => 'provisioned' as const)) };
}

describe('ProvisionCountryClaimUseCase — claim country no init (D731)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('T-F0b-42 prestador sem claim: grava o país da FICHA e loga country_claim_provisioned', async () => {
    const claims = port();
    expect(await new ProvisionCountryClaimUseCase(claims).execute({ uid: 'u1', principal: WORKER, country: 'BR' })).toBe('provisioned');
    expect(claims.ensureCountry).toHaveBeenCalledWith('u1', 'BR');
    expect(logger.info).toHaveBeenCalledWith({ uid: 'u1', country: 'BR' }, 'country_claim_provisioned');
  });

  it('T-F0b-42 staff (account_type ou papel de staff) nunca ganha o claim por aqui (lex C3)', async () => {
    const claims = port();
    const uc = new ProvisionCountryClaimUseCase(claims);
    expect(await uc.execute({ uid: 'u2', principal: { accountType: 'staff' }, country: 'AR' })).toBe('skipped_staff');
    expect(await uc.execute({ uid: 'u3', principal: { roles: ['admin'] }, country: 'AR' })).toBe('skipped_staff');
    expect(claims.ensureCountry).not.toHaveBeenCalled();
  });

  it.each([null, undefined, 'XX'])('T-F0b-42 ficha com country %p: não grava e loga country_claim_skipped no_country (D733)', async (country) => {
    const claims = port();
    expect(await new ProvisionCountryClaimUseCase(claims).execute({ uid: 'u4', principal: WORKER, country })).toBe('skipped_no_country');
    expect(claims.ensureCountry).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith({ uid: 'u4', reason: 'no_country' }, 'country_claim_skipped');
  });

  it('T-F0b-42 Firebase falhando não derruba o init: devolve failed e loga só o nome do erro', async () => {
    const claims = port(async () => { throw new TypeError('detalhe que nao sai no log'); });
    expect(await new ProvisionCountryClaimUseCase(claims).execute({ uid: 'u5', principal: WORKER, country: 'AR' })).toBe('failed');
    expect(logger.error).toHaveBeenCalledWith({ uid: 'u5', error: 'TypeError' }, 'country_claim_failed');
  });

  it('T-F0b-42 Firebase pendurado: o orçamento solta o init', async () => {
    const claims = port(() => new Promise(() => undefined));
    expect(await new ProvisionCountryClaimUseCase(claims, 20).execute({ uid: 'u6', principal: WORKER, country: 'AR' })).toBe('failed');
  });
});
