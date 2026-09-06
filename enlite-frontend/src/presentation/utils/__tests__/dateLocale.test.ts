/**
 * dateLocale.test.ts — o mapa de idioma → locale.
 *
 * ⚠️ A asserção NÃO pode ser pela saída formatada: es-AR e pt-BR produzem o
 * MESMO texto no formato curto (dd/mm/aaaa). Um teste que só lesse a data
 * ficaria verde com o mapa invertido — instrumento morto. Por isso ele afirma
 * o valor devolvido pelo resolvedor.
 */
import { describe, it, expect } from 'vitest';
import { resolveDateLocale, SHORT_DATE_OPTIONS } from '../dateLocale';

describe('resolveDateLocale', () => {
  it("'es' vira es-AR", () => {
    expect(resolveDateLocale('es')).toBe('es-AR');
  });

  it("'pt-BR' vira pt-BR", () => {
    expect(resolveDateLocale('pt-BR')).toBe('pt-BR');
  });

  it.each(['en', 'es-MX', '', 'ES'])('idioma inesperado (%s) cai em pt-BR, sem lançar', (lang) => {
    expect(resolveDateLocale(lang)).toBe('pt-BR');
  });

  it('es-AR e pt-BR formatam IGUAL no formato curto — é por isso que o teste não lê a saída', () => {
    const d = new Date('2026-08-29T13:45:00Z');
    expect(d.toLocaleDateString('es-AR', SHORT_DATE_OPTIONS))
      .toBe(d.toLocaleDateString('pt-BR', SHORT_DATE_OPTIONS));
  });

  it('SHORT_DATE_OPTIONS produz dd/mm/aaaa', () => {
    const d = new Date('2026-08-29T13:45:00Z');
    expect(d.toLocaleDateString('pt-BR', SHORT_DATE_OPTIONS)).toBe('29/08/2026');
  });
});
