/**
 * contractedServicePriceText — preço e imposto do serviço como a tela mostra (spec 058): só exibe; REDACTED é cadeado, não número.
 */
import { describe, it, expect } from 'vitest';
import type { TFunction } from 'i18next';
import esJson from '@infrastructure/i18n/locales/es.json';
import { contractedServicePriceText, contractedServiceTaxText, contractTermTexts } from '../contractedServicePriceText';

const t = ((key: string) => {
  let cur: unknown = esJson;
  for (const part of key.split('.')) cur = (cur as Record<string, unknown> | undefined)?.[part];
  return typeof cur === 'string' ? cur : key;
}) as unknown as TFunction;

describe('contractedServicePriceText', () => {
  it('OK: valor na moeda do contrato, por hora', () => {
    const ars = contractedServicePriceText(t, { state: 'OK', hourlyRate: 1500, currency: 'ARS' }, 'es-AR');
    expect(ars).toMatch(/1\.?500/);
    expect(ars).toContain('/ h');
    expect(contractedServicePriceText(t, { state: 'OK', hourlyRate: 80, currency: 'BRL' }, 'pt-BR')).toContain('R$');
  });

  it('REDACTED: cadeado e frase — nunca um número', () => {
    const text = contractedServicePriceText(t, { state: 'REDACTED' }, 'es');
    expect(text).toContain('🔒');
    expect(text).not.toMatch(/\d/);
  });

  it('NO_CONTRACT e NO_TERM dizem o que falta (não "—")', () => {
    expect(contractedServicePriceText(t, { state: 'NO_CONTRACT' }, 'es')).toBe('Sin contrato vinculado');
    expect(contractedServicePriceText(t, { state: 'NO_TERM' }, 'es')).toBe('Sin término vigente hoy');
  });
});

describe('contractedServiceTaxText', () => {
  it('0 = isento (frase), 21 = percentual, NO_TERM/NO_CONTRACT dizem o que falta', () => {
    expect(contractedServiceTaxText(t, { state: 'OK', taxRatePercent: 0 }, 'es')).toBe('Exento (0 %)');
    expect(contractedServiceTaxText(t, { state: 'OK', taxRatePercent: 21 }, 'es')).toBe('21 %');
    expect(contractedServiceTaxText(t, { state: 'OK', taxRatePercent: 10.5 }, 'pt-BR')).toBe('10,5 %');
    expect(contractedServiceTaxText(t, { state: 'NO_TERM' }, 'es')).toBe('Sin término vigente hoy');
    expect(contractedServiceTaxText(t, { state: 'NO_CONTRACT' }, 'es')).toBe('Sin contrato vinculado');
  });
});

describe('contractTermTexts (prévia da cascata)', () => {
  it('termo OK: preço e imposto; NO_TERM: a mesma frase nos dois; preço REDACTED sai com cadeado e o imposto continua', () => {
    const ok = { state: 'OK' as const, termId: 't', validFrom: '2026-09-01', validTo: null, taxRatePercent: 21, price: { state: 'OK' as const, hourlyRate: 1500, currency: 'ARS' as const } };
    expect(contractTermTexts(t, ok, 'es-AR').tax).toBe('21 %');
    expect(contractTermTexts(t, { state: 'NO_TERM' }, 'es')).toEqual({ price: 'Sin término vigente hoy', tax: 'Sin término vigente hoy' });
    const redacted = contractTermTexts(t, { ...ok, price: { state: 'REDACTED' } }, 'es');
    expect(redacted.price).toContain('🔒');
    expect(redacted.tax).toBe('21 %');
  });
});
