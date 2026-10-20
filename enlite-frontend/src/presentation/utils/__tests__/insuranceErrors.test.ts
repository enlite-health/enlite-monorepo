/**
 * insuranceErrors — a tradução do mapa de erros único do back (spec 058 §K) para a frase da tela.
 */
import { describe, it, expect } from 'vitest';
import type { TFunction } from 'i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import { insuranceErrorCode, insuranceErrorKeys, insuranceErrorText, NEEDS_CORRECTION, NEEDS_NEW_SERVICE } from '../insuranceErrors';

// `t` real sobre o es.json: chave que não existe devolve o defaultValue ('') — o mesmo contrato do i18next.
const t = ((key: string, opts?: { defaultValue?: string }) => {
  let cur: unknown = esJson;
  for (const part of key.split('.')) cur = (cur as Record<string, unknown> | undefined)?.[part];
  return typeof cur === 'string' ? cur : (opts?.defaultValue ?? key);
}) as unknown as TFunction;

const err = (status: number, code?: string, details?: Record<string, unknown>) => Object.assign(new Error('boom'), { status, code, details });

describe('insuranceErrors', () => {
  it('REQUIRES_NEW_SERVICE e USE_CORRECTION têm frase própria (a tela oferece o botão de saída)', () => {
    expect(insuranceErrorText(t, err(422, NEEDS_NEW_SERVICE))).toContain('servicio nuevo');
    expect(insuranceErrorText(t, err(422, NEEDS_CORRECTION))).toContain('corregí el vínculo');
  });

  it('RANGE_OVERLAP + details.constraint escolhe a frase da constraint (termo × vínculo); sem constraint cai na genérica do código', () => {
    expect(insuranceErrorText(t, err(409, 'RANGE_OVERLAP', { constraint: 'insurance_contract_terms_sem_sobreposicao' }))).toContain('término de valor');
    expect(insuranceErrorText(t, err(409, 'RANGE_OVERLAP', { constraint: 'contracted_service_contract_sem_sobreposicao' }))).toContain('otro vínculo');
    expect(insuranceErrorText(t, err(409, 'RANGE_OVERLAP'))).toContain('se superponen');
  });

  it('INVALID_<constraint> (23514) traduz pela constraint; constraint desconhecida cai no status, nunca no texto cru do back', () => {
    expect(insuranceErrorText(t, err(422, 'INVALID_insurance_providers_other_unclassified_chk'))).toContain('"Otra"');
    expect(insuranceErrorText(t, err(422, 'INVALID_alguma_coisa_nova'))).toBe(esJson.admin.insuranceErrors.byStatus['422']);
  });

  it('conflitos de nome/CUIT/código (409) têm uma frase cada — e não vazam o valor que colidiu', () => {
    for (const code of ['INSURANCE_PROVIDER_NAME_EXISTS', 'INSURANCE_PROVIDER_TAX_ID_EXISTS', 'INSURANCE_PROVIDER_CODE_EXISTS', 'INSURANCE_CONTRACT_NAME_EXISTS']) {
      const text = insuranceErrorText(t, err(409, code));
      expect(text).not.toBe(code);
      expect(text).not.toBe(esJson.admin.insuranceErrors.generic);
    }
  });

  it('sem code usa o status; sem status nem code usa a frase genérica; não-Error também não quebra', () => {
    expect(insuranceErrorText(t, err(403))).toBe(esJson.admin.insuranceErrors.byStatus['403']);
    expect(insuranceErrorText(t, new Error('x'))).toBe(esJson.admin.insuranceErrors.generic);
    expect(insuranceErrorText(t, 'oops')).toBe(esJson.admin.insuranceErrors.generic);
    expect(insuranceErrorText(t, null)).toBe(esJson.admin.insuranceErrors.generic);
  });

  it('a ordem de busca é da mais específica para a mais geral (travada)', () => {
    expect(insuranceErrorKeys(err(409, 'RANGE_OVERLAP', { constraint: 'x' }))).toEqual([
      'admin.insuranceErrors.rangeOverlap.x', 'admin.insuranceErrors.codes.RANGE_OVERLAP', 'admin.insuranceErrors.byStatus.409', 'admin.insuranceErrors.generic',
    ]);
    expect(insuranceErrorKeys(err(422, 'INVALID_y'))[0]).toBe('admin.insuranceErrors.constraints.y');
  });

  it('insuranceErrorCode só devolve string não vazia', () => {
    expect(insuranceErrorCode(err(422, 'USE_CORRECTION'))).toBe('USE_CORRECTION');
    expect(insuranceErrorCode(err(422, ''))).toBeNull();
    expect(insuranceErrorCode(undefined)).toBeNull();
  });
});
