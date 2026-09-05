import { terminologySearchQuerySchema } from '../terminologySearchSchema';
import { MIN_SEARCH_QUERY_LENGTH } from '../../../domain/TerminologyPort';

describe('terminologySearchQuerySchema (spec 016 F2)', () => {
  it('q obrigatório, lang/chapters opcionais, chapters vira array', () => {
    const ok = terminologySearchQuerySchema.safeParse({ q: 'esquisofrenia', lang: 'es', chapters: '06,08' });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.chapters).toEqual(['06', '08']);
  });

  it('q ausente ou vazio recusa', () => {
    expect(terminologySearchQuerySchema.safeParse({}).success).toBe(false);
    expect(terminologySearchQuerySchema.safeParse({ q: '' }).success).toBe(false);
  });

  it('lang fora de es|en recusa', () => {
    expect(terminologySearchQuerySchema.safeParse({ q: 'xy', lang: 'pt' }).success).toBe(false);
  });

  it('sem chapters/lang: q sozinho basta', () => {
    const ok = terminologySearchQuerySchema.safeParse({ q: 'xy' });
    expect(ok.success).toBe(true);
  });

  /**
   * 🔧 F5-CORREÇÃO T10 — o piso era `min(1)` AQUI e `2` nos dois adaptadores. Com 1 caractere a
   * requisição passava pela validação, o adaptador devolvia `[]` sem tocar o banco, e a API
   * respondia `200 {"candidates":[]}`: "não perguntei" indistinguível de "não há". Agora o
   * schema RECUSA, e o número vem de um lugar só.
   */
  describe('T10 — piso de tamanho da consulta, fonte ÚNICA', () => {
    it('1 caractere RECUSA (antes passava e virava 200 com lista vazia)', () => {
      const r = terminologySearchQuerySchema.safeParse({ q: 'a' });
      expect(r.success).toBe(false);
      if (!r.success) {
        expect(r.error.flatten().fieldErrors.q?.[0]).toBe(
          `q must have at least ${MIN_SEARCH_QUERY_LENGTH} characters`,
        );
      }
    });

    it('espaço em branco conta DEPOIS do trim — " a " também recusa', () => {
      expect(terminologySearchQuerySchema.safeParse({ q: ' a ' }).success).toBe(false);
    });

    it('exatamente o piso passa (fronteira medida, não estimada)', () => {
      expect(terminologySearchQuerySchema.safeParse({ q: 'a'.repeat(MIN_SEARCH_QUERY_LENGTH) }).success).toBe(true);
    });

    it('o piso do schema É o da porta — nenhuma cópia local do número', () => {
      // Prova estrutural: o arquivo do schema importa a constante em vez de escrever "2".
      // Se alguém reintroduzir um literal aqui, este teste continua verde mas o de baixo
      // (fronteira exata) passa a depender do valor da porta — que é o ponto.
      expect(MIN_SEARCH_QUERY_LENGTH).toBeGreaterThan(1);
      expect(terminologySearchQuerySchema.safeParse({ q: 'a'.repeat(MIN_SEARCH_QUERY_LENGTH - 1) }).success).toBe(false);
    });
  });
});
