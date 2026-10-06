import { describe, it, expect } from 'vitest';
import { formatMessageDateTime } from '../messageDateFormat';

// Hora e dia em -03 (America/Argentina/Buenos_Aires), 24h, em QUALQUER fuso do host.
const ISO = '2026-09-17T18:13:00.000Z';

describe('formatMessageDateTime', () => {
  it('ES: "<dia> de <mês abrev.>. <connector> <hora 24h>" em -03', () => {
    expect(formatMessageDateTime(ISO, 'es', 'a las')).toBe('17 de sep. a las 15:13');
  });

  it('cruza a meia-noite no dia de -03 (02:30Z do dia 18 = 23:30 do dia 17)', () => {
    expect(formatMessageDateTime('2026-09-18T02:30:00.000Z', 'es', 'a las')).toBe('17 de sep. a las 23:30');
  });

  it('data inválida volta como veio', () => {
    expect(formatMessageDateTime('lixo', 'es', 'a las')).toBe('lixo');
  });

  it('PT: "<dia> de <mês abrev.>. <connector> <hora 24h>"', () => {
    const out = formatMessageDateTime(ISO, 'pt-BR', 'às')
    expect(out).toBe('17 de set. às 15:13');
  });

  it('mês vem de tabela própria (determinístico), não do Intl do runtime', () => {
    expect(formatMessageDateTime('2026-01-15T12:00:00.000Z', 'es', 'a las')).toContain('de ene.');
    expect(formatMessageDateTime('2026-12-15T12:00:00.000Z', 'pt-BR', 'às')).toContain('de dez.');
  });

  it('idioma desconhecido cai no molde ES (fallback seguro, nunca quebra)', () => {
    expect(() => formatMessageDateTime(ISO, 'fr', 'a las')).not.toThrow();
  });
});
