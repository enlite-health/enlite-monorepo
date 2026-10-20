/**
 * insuranceErrorResponse — o mapa de erros único da 058 (spec §3.3 §K, plan §1.6). Cada código de banco/domínio vira UM status e UM código;
 * o inesperado volta `null` (o controller loga + 500). Nada do corpo da request entra na resposta.
 */
import { insuranceErrorBody, respondInsuranceError, P0001_CODES } from '../insuranceErrorResponse';
import { ConcurrencyConflictError } from '@shared/database/withSerializationRetry';
import { InsuranceProviderNameExistsError } from '../../../infrastructure/InsuranceProviderRepository';
import { SameStartUseCorrectionError } from '../../../domain/rangeWriteErrors';

const pg = (code: string, message: string, constraint?: string): Error =>
  Object.assign(new Error(message), { code, ...(constraint ? { constraint } : {}) });

describe('insuranceErrorBody', () => {
  it.each(P0001_CODES)('P0001 %s (a MESSAGE da exceção) -> 422 com o próprio código', (c) => {
    expect(insuranceErrorBody(pg('P0001', c))).toEqual({ status: 422, body: { success: false, error: c, code: c } });
  });

  it('P0001_CODES inclui os 4 códigos da Parte B (país, capacidade da faixa, quantidade abaixo da ocupação, quantidade não pode limpar)', () => {
    expect(P0001_CODES).toEqual(expect.arrayContaining(['UNKNOWN_COUNTRY', 'ITINERARY_SLOT_CAPACITY_EXCEEDED', 'PROVIDERS_NEEDED_BELOW_OCCUPANCY', 'PROVIDERS_NEEDED_CANNOT_CLEAR']));
    expect(insuranceErrorBody(pg('P0001', 'ITINERARY_SLOT_CAPACITY_EXCEEDED'))).toEqual({ status: 422, body: { success: false, error: 'ITINERARY_SLOT_CAPACITY_EXCEEDED', code: 'ITINERARY_SLOT_CAPACITY_EXCEEDED' } });
  });

  it('P0001 com mensagem DESCONHECIDA não é mapeado (vira 500 + alarme, nunca um 422 chutado)', () => {
    expect(insuranceErrorBody(pg('P0001', 'alguma outra exceção de plpgsql'))).toBeNull();
  });

  it('23514 -> 422 INVALID_<constraint>; de trigger (sem constraint) usa a message', () => {
    expect(insuranceErrorBody(pg('23514', 'x', 'insurance_providers_private_kind_chk'))?.body.code).toBe('INVALID_insurance_providers_private_kind_chk');
    expect(insuranceErrorBody(pg('23514', 'insurance_contract_term_imutavel'))?.body.code).toBe('INVALID_insurance_contract_term_imutavel');
    expect(insuranceErrorBody(pg('23514', 'x', 'insurance_contracts_country_check'))?.status).toBe(422);
  });

  it('23P01 (EXCLUDE) -> 409 RANGE_OVERLAP com o nome da constraint', () => {
    expect(insuranceErrorBody(pg('23P01', 'x', 'contracted_service_contract_sem_sobreposicao'))).toEqual({
      status: 409,
      body: { success: false, error: 'Range overlap', code: 'RANGE_OVERLAP', details: { constraint: 'contracted_service_contract_sem_sobreposicao' } },
    });
  });

  it('40P01/40001 esgotados (ConcurrencyConflictError) -> 409', () => {
    expect(insuranceErrorBody(new ConcurrencyConflictError('40P01', 3))).toEqual({
      status: 409, body: { success: false, error: 'Concurrent update conflict', code: 'CONCURRENCY_CONFLICT' },
    });
  });

  it('erros de domínio com httpStatus saem como são (409 de unicidade por constraint, 422 SAME_START)', () => {
    expect(insuranceErrorBody(new InsuranceProviderNameExistsError())).toMatchObject({ status: 409, body: { code: 'INSURANCE_PROVIDER_NAME_EXISTS' } });
    expect(insuranceErrorBody(new SameStartUseCorrectionError())).toMatchObject({ status: 422, body: { code: 'SAME_START_USE_CORRECTION' } });
  });

  it('22000 -> 422; 23505 CRU (não despachado pelo repositório) e erro comum NÃO são mapeados', () => {
    expect(insuranceErrorBody(pg('22000', 'x'))?.status).toBe(422);
    expect(insuranceErrorBody(pg('23505', 'x', 'alguma_unique'))).toBeNull();
    expect(insuranceErrorBody(new Error('boom'))).toBeNull();
    expect(insuranceErrorBody('string')).toBeNull();
    expect(insuranceErrorBody(null)).toBeNull();
  });

  it('respondInsuranceError responde e devolve true; para o inesperado devolve false e não responde', () => {
    const json = jest.fn();
    const res = { status: jest.fn().mockReturnValue({ json }) } as never;
    expect(respondInsuranceError(pg('P0001', 'COUNTRY_MISMATCH'), res)).toBe(true);
    expect(json).toHaveBeenCalledWith({ success: false, error: 'COUNTRY_MISMATCH', code: 'COUNTRY_MISMATCH' });
    const res2 = { status: jest.fn() } as never;
    expect(respondInsuranceError(new Error('boom'), res2)).toBe(false);
    expect((res2 as { status: jest.Mock }).status).not.toHaveBeenCalled();
  });
});
