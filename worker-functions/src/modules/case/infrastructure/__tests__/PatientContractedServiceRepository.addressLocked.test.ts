/**
 * 058 REGRA-05: o PATCH do serviço recusa `addressId` DIFERENTE do atual com vaga viva ou alocação vigente (422 SERVICE_ADDRESS_LOCKED).
 * Molde: PatientContractedServiceRepository.refuseClear.test.ts (client mockado; SQL real = e2e).
 */
const mockConnect = jest.fn();
const mockPoolQuery = jest.fn();
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ connect: mockConnect, query: mockPoolQuery }) }) },
}));

import { ServiceAddressLockedError } from '../PatientContractedServiceRepository';
import { isHttpDomainError } from '../../interfaces/controllers/insuranceErrorResponse';

describe('ServiceAddressLockedError', () => {
  it.each(['LIVE_VACANCY', 'ALLOCATION'] as const)('ServiceAddressLockedError: httpStatus 422, code SERVICE_ADDRESS_LOCKED e details.reason (%s)', (reason) => {
    const err = new ServiceAddressLockedError(reason);

    expect(err.httpStatus).toBe(422);
    expect(err.code).toBe('SERVICE_ADDRESS_LOCKED');
    expect(err.details).toEqual({ reason });
    expect(isHttpDomainError(err)).toBe(true);
  });
});
