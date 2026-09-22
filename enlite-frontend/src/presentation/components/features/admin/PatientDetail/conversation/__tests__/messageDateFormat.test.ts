import { describe, it, expect } from 'vitest';
import { formatMessageDateTime } from '../messageDateFormat';

// `new Date(iso)` usa o TZ local do processo (mesma decisão já existente no antigo `formatTime`
// de `ThreadView.tsx` — nunca convertemos para America/Argentina/Buenos_Aires explicitamente).
// Para o teste bater sempre, fixamos um horário sem cruzar meia-noite em nenhum TZ plausível de CI.
const ISO = '2026-09-17T18:13:00.000Z';

describe('formatMessageDateTime', () => {
  it('ES: "<dia> de <mês abrev.>. <connector> <hora 12h com a.m./p.m.>"', () => {
    const out = formatMessageDateTime(ISO, 'es', 'a las');
    expect(out).toMatch(/^\d{1,2} de sep\. a las \d{1,2}:\d{2} [ap]\. ?m\.$/);
  });

  it('PT: "<dia> de <mês abrev.>. <connector> <hora 24h>"', () => {
    const out = formatMessageDateTime(ISO, 'pt-BR', 'às')
    expect(out).toMatch(/^\d{1,2} de set\. às \d{1,2}:\d{2}$/);
  });

  it('mês vem de tabela própria (determinístico), não do Intl do runtime', () => {
    expect(formatMessageDateTime('2026-01-15T12:00:00.000Z', 'es', 'a las')).toContain('de ene.');
    expect(formatMessageDateTime('2026-12-15T12:00:00.000Z', 'pt-BR', 'às')).toContain('de dez.');
  });

  it('idioma desconhecido cai no molde ES (fallback seguro, nunca quebra)', () => {
    expect(() => formatMessageDateTime(ISO, 'fr', 'a las')).not.toThrow();
  });
});
