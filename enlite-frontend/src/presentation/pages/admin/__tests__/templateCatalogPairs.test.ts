/**
 * A listagem por MENSAGEM (spec 010 — a arquitetura de informação corrigida).
 *
 * O que estes testes protegem, em ordem de importância:
 *
 * 1. **O par vem do `baseName`, NUNCA de parsear o slug.** Produção usa três
 *    convenções e os únicos dois pares existentes usam a convenção OPOSTA à da
 *    tela nova. Um teste com dados reais trava qualquer volta ao regex.
 * 2. **Idioma `null` não vira espanhol.** "Não sei" e "espanhol" são coisas
 *    diferentes; confundi-las faz a tela afirmar o que ninguém mediu.
 * 3. **As aprovações são independentes** — o par não tem estado próprio.
 */
import { describe, it, expect } from 'vitest';
import type { TemplateCatalogRow } from '@infrastructure/http/AdminTemplateCatalogApiService';
import { agruparEmPares, faltaUmaVersao, idiomaQueFalta, versaoPrincipal, ES, PT } from '../templateCatalogPairs';

const linha = (o: Partial<TemplateCatalogRow> & { slug: string; baseName: string }): TemplateCatalogRow => ({
  name: o.slug, bodyTwilio: null, category: 'UTILITY', isActive: true, contentSid: 'HX1',
  metaStatus: 'APPROVED', metaReason: null, metaDetail: null, metaCheckedAt: null,
  eligible: true, ineligibleReason: null, placeholders: [], usedInStages: [],
  language: ES, ...o,
});

describe('agruparEmPares', () => {
  it('🔒 os DOIS pares reais de produção usam SUFIXO e mesmo assim pareiam', () => {
    // `admission_confirmation_es`/`_pt` — a convenção oposta à de prefixo que a
    // tela nova aplica. Só pareiam porque o `baseName` vem do banco.
    const pares = agruparEmPares([
      linha({ slug: 'admission_confirmation_es', baseName: 'admission_confirmation', language: ES }),
      linha({ slug: 'admission_confirmation_pt', baseName: 'admission_confirmation', language: PT }),
    ]);
    expect(pares).toHaveLength(1);
    expect(pares[0].es?.slug).toBe('admission_confirmation_es');
    expect(pares[0].pt?.slug).toBe('admission_confirmation_pt');
  });

  it('🔒 slugs que COMEÇAM igual mas são mensagens diferentes NÃO se juntam', () => {
    // `_v2` não é sufixo de idioma. Colapsar poria dois textos espanhóis na
    // mesma célula e o segundo sumiria da tela.
    const pares = agruparEmPares([
      linha({ slug: 'ar_vacancy_match_complete', baseName: 'vacancy_match_complete' }),
      linha({ slug: 'ar_vacancy_match_complete_v2', baseName: 'vacancy_match_complete_v2' }),
    ]);
    expect(pares).toHaveLength(2);
  });

  it('🔒 idioma NULL não vira espanhol — vai para coluna própria', () => {
    const pares = agruparEmPares([linha({ slug: 'x', baseName: 'x', language: null })]);
    expect(pares[0].es).toBeNull();
    expect(pares[0].pt).toBeNull();
    expect(pares[0].semIdioma.map((r) => r.slug)).toEqual(['x']);
  });

  it('linha sem baseName classificado vira grupo de UMA — não pareia, mas não pareia errado', () => {
    // O backend manda COALESCE(base_name, slug), então duas linhas não
    // classificadas chegam com baseNames distintos e não colapsam num só.
    const pares = agruparEmPares([
      linha({ slug: 'qualified_worker', baseName: 'qualified_worker' }),
      linha({ slug: 'complete_register_ofc', baseName: 'complete_register_ofc' }),
    ]);
    expect(pares).toHaveLength(2);
  });

  it('preserva a ordem de primeira aparição, não a alfabética', () => {
    const pares = agruparEmPares([
      linha({ slug: 'zzz', baseName: 'zzz' }),
      linha({ slug: 'aaa', baseName: 'aaa' }),
    ]);
    expect(pares.map((p) => p.baseName)).toEqual(['zzz', 'aaa']);
  });

  it('🔒 o par NÃO tem estado próprio: cada lado carrega a aprovação dele', () => {
    // Espanhol aprovado, português em revisão — o caso que o desenho mostra de
    // propósito. Um estado único deixaria a tela sem como representar isso.
    const pares = agruparEmPares([
      linha({ slug: 'ar_x', baseName: 'x', language: ES, metaStatus: 'APPROVED' }),
      linha({ slug: 'br_x', baseName: 'x', language: PT, metaStatus: 'PENDING' }),
    ]);
    expect(pares[0].es?.metaStatus).toBe('APPROVED');
    expect(pares[0].pt?.metaStatus).toBe('PENDING');
  });
});

describe('faltaUmaVersao', () => {
  const so_es = linha({ slug: 'ar_a', baseName: 'a', language: ES });
  const so_pt = linha({ slug: 'br_b', baseName: 'b', language: PT });
  const par_es = linha({ slug: 'ar_c', baseName: 'c', language: ES });
  const par_pt = linha({ slug: 'br_c', baseName: 'c', language: PT });

  it('conta a que só tem espanhol e a que só tem português', () => {
    const faltam = faltaUmaVersao(agruparEmPares([so_es, so_pt, par_es, par_pt]));
    expect(faltam.map((p) => p.baseName).sort()).toEqual(['a', 'b']);
  });

  it('o par completo não conta', () => {
    expect(faltaUmaVersao(agruparEmPares([par_es, par_pt]))).toEqual([]);
  });

  it('🔒 sem idioma registrado NÃO conta como "falta versão" — falta classificar, é outro pedido', () => {
    const semIdioma = linha({ slug: 'z', baseName: 'z', language: null });
    expect(faltaUmaVersao(agruparEmPares([semIdioma]))).toEqual([]);
  });

  it('idiomaQueFalta nomeia o lado ausente, e null quando não falta', () => {
    const [a, b, c] = agruparEmPares([so_es, so_pt, par_es, par_pt]);
    expect(idiomaQueFalta(a)).toBe(PT);
    expect(idiomaQueFalta(b)).toBe(ES);
    expect(idiomaQueFalta(c)).toBeNull();
  });
});

describe('versaoPrincipal', () => {
  it('o espanhol lidera — é o idioma da operação hoje', () => {
    const p = agruparEmPares([
      linha({ slug: 'br_x', baseName: 'x', language: PT }),
      linha({ slug: 'ar_x', baseName: 'x', language: ES }),
    ]);
    expect(versaoPrincipal(p[0])?.slug).toBe('ar_x');
  });
  it('cai no português quando só ele existe', () => {
    const p = agruparEmPares([linha({ slug: 'br_x', baseName: 'x', language: PT })]);
    expect(versaoPrincipal(p[0])?.slug).toBe('br_x');
  });
  it('e na linha sem idioma quando é a única — mensagem não classificada ainda aparece', () => {
    const p = agruparEmPares([linha({ slug: 'x', baseName: 'x', language: null })]);
    expect(versaoPrincipal(p[0])?.slug).toBe('x');
  });
});

describe('🔒 nada é descartado — o modo de falha que escondeu PAUSED até 31/08', () => {
  it('idioma DESCONHECIDO não some da tela: cai na coluna de não classificados', () => {
    // `language` é VARCHAR(10) livre, e a conferência de 01/09 contra a Content
    // API achou 3 Contents com `es` puro em vez de `es_AR`. Sem este destino, a
    // linha não apareceria em coluna nenhuma e a mensagem sumiria inteira —
    // sem erro, sem aviso, sem ninguém saber.
    const pares = agruparEmPares([linha({ slug: 'x', baseName: 'x', language: 'es' })]);
    expect(pares).toHaveLength(1);
    expect(pares[0].semIdioma.map((r) => r.slug)).toEqual(['x']);
    expect(versaoPrincipal(pares[0]).slug).toBe('x');
  });

  it('o SEGUNDO template do mesmo idioma no mesmo baseName também aparece', () => {
    // A coluna comporta uma versão. A segunda não é escondida numa célula: vai
    // para os não classificados, onde a pessoa vê que há algo a corrigir no
    // `base_name` — em vez de a tela calar uma mensagem que existe.
    const pares = agruparEmPares([
      linha({ slug: 'ar_a', baseName: 'a', language: ES }),
      linha({ slug: 'ar_a_bis', baseName: 'a', language: ES }),
    ]);
    expect(pares[0].es?.slug).toBe('ar_a');
    expect(pares[0].semIdioma.map((r) => r.slug)).toEqual(['ar_a_bis']);
  });

  it('🔒 toda linha de entrada aparece em ALGUMA saída — invariante', () => {
    const entrada = [
      linha({ slug: 'a', baseName: 'p', language: ES }),
      linha({ slug: 'b', baseName: 'p', language: PT }),
      linha({ slug: 'c', baseName: 'p', language: null }),
      linha({ slug: 'd', baseName: 'p', language: 'klingon' }),
      linha({ slug: 'e', baseName: 'p', language: ES }),
    ];
    const saida = agruparEmPares(entrada).flatMap((p) => [p.es, p.pt, ...p.semIdioma].filter((r) => r !== null));
    expect(saida.map((r) => r!.slug).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });
});
