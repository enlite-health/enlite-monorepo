/**
 * Os campos de CONTRATO do serviço contratado (spec 058) num serviço SEM vínculo — o que todo serviço de hoje devolve até a carga:
 * `payer.state = NO_CONTRACT` e preço/imposto sem contrato. Os fixtures de teste espalham isto no lugar dos campos legados
 * (valor-hora, tipo de contratação, condição de IVA), que saíram do fio.
 */
import type { PatientContractedServiceDetail } from '../../PatientContractedService';

export const CONTRACT_058_DEFAULTS = {
  asOf: '2026-10-19',
  payer: { state: 'NO_CONTRACT' },
  payerHistory: [],
  price: { state: 'NO_CONTRACT' },
  tax: { state: 'NO_CONTRACT' },
  coverageMatch: { state: 'NO_PAYER' },
} as const satisfies Pick<PatientContractedServiceDetail, 'asOf' | 'payer' | 'payerHistory' | 'price' | 'tax' | 'coverageMatch'>;

/** Serviço vinculado a um contrato (pagador conhecido, preço e imposto vigentes). */
export const LINKED_058 = {
  asOf: '2026-10-19',
  payer: {
    state: 'LINKED',
    isPrivate: false,
    validFrom: '2026-09-01',
    validTo: null,
    names: { providerCode: 'OSDE', providerName: 'OSDE', contractId: 'ct-1', contractName: 'Plan 210', payerKind: 'PREPAGA' },
  },
  payerHistory: [],
  price: { state: 'OK', hourlyRate: 1500, currency: 'ARS' },
  tax: { state: 'OK', taxRatePercent: 21 },
  coverageMatch: { state: 'MATCH' },
} as const satisfies Pick<PatientContractedServiceDetail, 'asOf' | 'payer' | 'payerHistory' | 'price' | 'tax' | 'coverageMatch'>;
