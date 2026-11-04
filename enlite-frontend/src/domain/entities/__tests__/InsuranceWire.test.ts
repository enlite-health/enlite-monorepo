/**
 * Os schemas do FIO da obra social/contrato (spec 058 Parte A) contra os corpos que a A1 entrega (rodada 4 do progresso).
 * `.strict()` em tudo: chave a mais ou a menos é drift de contrato.
 */
import { describe, it, expect } from 'vitest';
import { insuranceContractItemSchema, insuranceContractListSchema, contractTermViewSchema, termPriceSchema } from '../InsuranceContract';
import {
  insuranceProviderDetailSchema, insuranceProviderListSchema, insuranceProvidersForServiceSchema,
  insuranceProviderContactSchema, insuranceProviderPatientSchema, createdInsuranceProviderSchema,
} from '../InsuranceProviderDetail';

const termOk = { state: 'OK', termId: 't1', validFrom: '2026-09-01', validTo: null, taxRatePercent: 0, price: { state: 'OK', hourlyRate: 1500, currency: 'ARS' } };
const contract = { id: 'c1', name: 'Plan 210', country: 'AR', scopeDescription: null, asOf: '2026-10-19', currentTerm: termOk, futureTerms: [] };

describe('contrato e termo', () => {
  it('termo vigente OK, NO_TERM, e preço REDACTED (o imposto continua visível)', () => {
    expect(contractTermViewSchema.parse(termOk)).toEqual(termOk);
    expect(contractTermViewSchema.parse({ state: 'NO_TERM' })).toEqual({ state: 'NO_TERM' });
    const redacted = contractTermViewSchema.parse({ ...termOk, price: { state: 'REDACTED' } });
    expect(redacted).toMatchObject({ taxRatePercent: 0, price: { state: 'REDACTED' } });
  });

  it('imposto 0 (isento) é um número válido, não ausência; sem imposto no termo OK é recusado', () => {
    expect(contractTermViewSchema.safeParse({ ...termOk, taxRatePercent: 0 }).success).toBe(true);
    const { taxRatePercent: _t, ...semImposto } = termOk;
    expect(contractTermViewSchema.safeParse(semImposto).success).toBe(false);
  });

  it('preço: moeda só ARS/BRL; REDACTED não carrega valor', () => {
    expect(termPriceSchema.safeParse({ state: 'OK', hourlyRate: 10, currency: 'USD' }).success).toBe(false);
    expect(termPriceSchema.safeParse({ state: 'REDACTED', hourlyRate: 10 }).success).toBe(false);
  });

  it('item de contrato e lista; país fora de AR/BR e data não-ISO são recusados', () => {
    expect(insuranceContractItemSchema.parse(contract)).toEqual(contract);
    expect(insuranceContractListSchema.parse({ items: [contract] }).items).toHaveLength(1);
    expect(insuranceContractItemSchema.safeParse({ ...contract, country: 'UY' }).success).toBe(false);
    expect(insuranceContractItemSchema.safeParse({ ...contract, asOf: '19/10/2026' }).success).toBe(false);
  });
});

describe('obra social', () => {
  const detail = { code: 'OSDE', name: 'OSDE', payerKind: 'PREPAGA', active: true, legalName: null, taxId: null, address: null, managementChatId: null, sortOrder: 15 };

  it('lista, detalhe e criação; payerKind pode ser null (ainda não classificada) e só aceita os 3 tipos', () => {
    expect(insuranceProviderListSchema.parse({ items: [{ code: 'OSDE', name: 'OSDE', payerKind: null, active: true }] }).items[0].payerKind).toBeNull();
    expect(insuranceProviderDetailSchema.parse(detail)).toEqual(detail);
    expect(insuranceProviderDetailSchema.safeParse({ ...detail, payerKind: 'OUTRO' }).success).toBe(false);
    expect(createdInsuranceProviderSchema.parse({ code: 'N', name: 'N', active: true, sortOrder: 1 })).toBeTruthy();
  });

  it('cascata do serviço: só {code,name} + asOf — payerKind NÃO existe nela (recusado)', () => {
    expect(insuranceProvidersForServiceSchema.parse({ providers: [{ code: 'OSDE', name: 'OSDE' }], asOf: '2026-10-19' }).asOf).toBe('2026-10-19');
    expect(insuranceProvidersForServiceSchema.safeParse({ providers: [{ code: 'OSDE', name: 'OSDE', payerKind: 'PREPAGA' }], asOf: '2026-10-19' }).success).toBe(false);
  });

  it('contato: documento do vocabulário do worker; redigido chega com phone/email/number null', () => {
    const base = { id: 'k1', fullName: 'Ana', roleTitle: 'Auditora', phone: '11', email: null, document: { type: 'DNI', number: '123' }, retired: false, redacted: false };
    expect(insuranceProviderContactSchema.parse(base)).toEqual(base);
    expect(insuranceProviderContactSchema.parse({ ...base, phone: null, document: { type: 'CPF', number: null }, redacted: true }).redacted).toBe(true);
    expect(insuranceProviderContactSchema.parse({ ...base, document: null }).document).toBeNull();
    expect(insuranceProviderContactSchema.safeParse({ ...base, document: { type: 'RG', number: '1' } }).success).toBe(false);
  });

  it('§L paciente do vínculo vigente', () => {
    const item = { patientId: 'p1', caseNumber: null, contractedServiceId: 's1', contractName: 'Plan 210', validFrom: '2026-09-01', validTo: null, asOf: '2026-10-19' };
    expect(insuranceProviderPatientSchema.parse(item)).toEqual(item);
  });
});
