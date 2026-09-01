/**
 * As regras determinísticas do rascunho (spec 010, F2 passo 2.2).
 *
 * O que estes testes protegem, em ordem de importância:
 *
 * 1. `validarRascunho` devolve TODOS os problemas, não o primeiro — corrigir de
 *    um em um custa um round-trip por erro.
 * 2. `slugComPrefixo` é idempotente: salvar duas vezes não produz `ar_ar_x`.
 * 3. Passar nas regras NÃO é promessa de aprovação da Meta — por isso cada
 *    regra testada é uma recusa DOCUMENTADA dela, e não palpite nosso.
 */
import {
  CATEGORIAS,
  IDIOMAS,
  LIMITE_CORPO,
  PREFIXO_POR_IDIOMA,
  placeholdersDe,
  slugComPrefixo,
  validarRascunho,
} from '../templateDraftRules';

const ok = {
  slug: 'ar_bienvenida',
  name: 'Bienvenida',
  body: 'Hola {{1}}, te esperamos el {{2}} en la entrevista.',
  category: 'UTILITY',
  language: 'es-AR',
};

const regras = (e: Partial<typeof ok>) => validarRascunho({ ...ok, ...e }).map((p) => p.regra);
const campos = (e: Partial<typeof ok>) => validarRascunho({ ...ok, ...e }).map((p) => p.campo);

describe('constantes', () => {
  it('as categorias e idiomas são os que a Meta e a operação aceitam', () => {
    expect(CATEGORIAS).toEqual(['MARKETING', 'UTILITY', 'AUTHENTICATION']);
    expect(IDIOMAS).toEqual(['es-AR', 'pt-BR']);
    expect(LIMITE_CORPO).toBe(1024);
    expect(PREFIXO_POR_IDIOMA).toEqual({ 'es-AR': 'ar_', 'pt-BR': 'br_' });
  });
});

describe('placeholdersDe', () => {
  it('devolve os números na ordem em que aparecem', () => {
    expect(placeholdersDe('a {{1}} b {{2}} c')).toEqual([1, 2]);
  });
  it('tolera espaço dentro das chaves', () => {
    expect(placeholdersDe('a {{ 1 }} b')).toEqual([1]);
  });
  it('texto sem placeholder devolve lista vazia, e vazio aqui é resposta e não falha', () => {
    expect(placeholdersDe('sem nenhum')).toEqual([]);
  });
  it('repetido aparece as duas vezes — quem deduplica é quem valida', () => {
    expect(placeholdersDe('{{1}} x {{1}}')).toEqual([1, 1]);
  });
});

describe('slugComPrefixo', () => {
  it('acrescenta o prefixo do idioma', () => {
    expect(slugComPrefixo('bienvenida', 'es-AR')).toBe('ar_bienvenida');
    expect(slugComPrefixo('boas_vindas', 'pt-BR')).toBe('br_boas_vindas');
  });
  it('é IDEMPOTENTE — salvar duas vezes não vira ar_ar_x', () => {
    expect(slugComPrefixo('ar_bienvenida', 'es-AR')).toBe('ar_bienvenida');
    expect(slugComPrefixo(slugComPrefixo('x', 'pt-BR'), 'pt-BR')).toBe('br_x');
  });
  it('normaliza caixa, espaço e pontuação para o formato que a Meta aceita', () => {
    expect(slugComPrefixo('  Bienvenida  Nueva! ', 'es-AR')).toBe('ar_bienvenida_nueva');
  });
  it('colapsa underscore repetido e apara as bordas', () => {
    expect(slugComPrefixo('__a---b__', 'es-AR')).toBe('ar_a_b');
  });
});

describe('validarRascunho — o caminho limpo', () => {
  it('rascunho válido não devolve problema nenhum', () => {
    expect(validarRascunho(ok)).toEqual([]);
  });
  it('texto sem placeholder é válido — nem toda mensagem tem variável', () => {
    expect(validarRascunho({ ...ok, body: 'Hola, te esperamos.' })).toEqual([]);
  });
  it('exatamente no limite passa; o limite é teto, não parede um antes', () => {
    expect(validarRascunho({ ...ok, body: 'a'.repeat(LIMITE_CORPO) })).toEqual([]);
  });
});

describe('validarRascunho — identidade', () => {
  it('nome vazio reprova', () => {
    expect(regras({ name: '   ' })).toContain('obrigatorio');
    expect(campos({ name: '   ' })).toContain('name');
  });
  it('slug vazio reprova', () => {
    expect(campos({ slug: '' })).toContain('slug');
  });
  it('slug com maiúscula ou hífen reprova — a Meta só aceita [a-z0-9_]', () => {
    expect(regras({ slug: 'ar_Bienvenida' })).toContain('formato');
    expect(regras({ slug: 'ar-bienvenida' })).toContain('formato');
  });
  it('categoria fora das três reprova', () => {
    expect(regras({ category: 'PROMO' })).toContain('invalida');
  });
  it('idioma fora dos dois reprova', () => {
    expect(regras({ language: 'en-US' })).toContain('invalido');
  });
});

describe('validarRascunho — corpo', () => {
  it('corpo vazio reprova e ENCERRA — sem texto não há o que dizer das demais regras', () => {
    const p = validarRascunho({ ...ok, body: '   ' });
    expect(p).toEqual([{ campo: 'body', regra: 'obrigatorio' }]);
  });
  it('passar do limite reprova', () => {
    expect(regras({ body: 'a'.repeat(LIMITE_CORPO + 1) })).toContain('muito_longo');
  });
  it('numeração com buraco reprova — a Meta exige 1,2,3 sem pular', () => {
    expect(regras({ body: 'a {{1}} b {{3}} c' })).toContain('placeholder_numeracao');
  });
  it('numeração que não começa em 1 reprova', () => {
    expect(regras({ body: 'a {{2}} b {{3}} c' })).toContain('placeholder_numeracao');
  });
  it('repetir o mesmo número é aceito — deduplica antes de exigir sequência', () => {
    expect(regras({ body: 'a {{1}} b {{1}} c' })).not.toContain('placeholder_numeracao');
  });
  it('começar com placeholder reprova — a Meta não avalia sem texto em volta', () => {
    expect(regras({ body: '{{1}} bienvenida a bordo' })).toContain('placeholder_no_inicio');
  });
  it('terminar com placeholder reprova', () => {
    expect(regras({ body: 'te esperamos el {{1}}' })).toContain('placeholder_no_fim');
  });
  it('dois placeholders colados reprovam', () => {
    expect(regras({ body: 'hola {{1}}{{2}} vamos' })).toContain('placeholders_adjacentes');
  });
  it('colados com espaço no meio também reprovam', () => {
    expect(regras({ body: 'hola {{1}} {{2}} vamos' })).toContain('placeholders_adjacentes');
  });
  it('devolve TODOS os problemas de uma vez, não só o primeiro', () => {
    const p = validarRascunho({ slug: 'X!', name: '', body: '{{2}}', category: 'NOPE', language: 'de' });
    expect(p.length).toBeGreaterThanOrEqual(5);
    expect(new Set(p.map((x) => x.campo))).toEqual(new Set(['slug', 'name', 'body', 'category', 'language']));
  });
});
