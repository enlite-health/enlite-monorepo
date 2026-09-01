/**
 * A lógica pura da tela de rascunho.
 *
 * ⚠️ `slugPrevisto` é PRÉ-VISUALIZAÇÃO, não regra. A regra vive no backend
 * (`templateDraftRules.slugComPrefixo`). Estes testes travam que as duas
 * concordam nos casos que importam — se divergirem, isto fica vermelho antes de
 * alguém descobrir na tela que salvou com outro nome.
 */
import { describe, it, expect } from 'vitest';
import {
  LIMITE_CORPO,
  chaveDeProblema,
  previewDe,
  problemasPorCampo,
  quandoRelativo,
  restante,
  slugPrevisto,
  inicialDaURL,
} from '../templateDraftsView';

describe('slugPrevisto', () => {
  it('acrescenta o prefixo do idioma', () => {
    expect(slugPrevisto('bienvenida', 'es-AR')).toBe('ar_bienvenida');
    expect(slugPrevisto('boas vindas', 'pt-BR')).toBe('br_boas_vindas');
  });
  it('é idempotente — não vira ar_ar_x', () => {
    expect(slugPrevisto('ar_bienvenida', 'es-AR')).toBe('ar_bienvenida');
  });
  it('normaliza caixa e pontuação', () => {
    expect(slugPrevisto('  Bienvenida Nueva! ', 'es-AR')).toBe('ar_bienvenida_nueva');
  });
  it('vazio devolve vazio — a tela não mostra "ar_" sozinho', () => {
    expect(slugPrevisto('', 'es-AR')).toBe('');
    expect(slugPrevisto('   ', 'es-AR')).toBe('');
  });
  it('idioma desconhecido não inventa prefixo', () => {
    expect(slugPrevisto('x', 'en-US')).toBe('x');
  });
});

describe('previewDe', () => {
  it('troca a variável NOMEADA por um exemplo legível', () => {
    expect(previewDe('Hola {{worker_name}}, caso {{case_number}}'))
      .toBe('Hola [nombre], caso [nº de caso]');
  });
  it('usa o exemplo fornecido quando existe', () => {
    expect(previewDe('Hola {{worker_name}}', { worker_name: 'María' })).toBe('Hola María');
  });
  it('tolera espaço dentro das chaves', () => {
    expect(previewDe('Hola {{ worker_name }}')).toBe('Hola [nombre]');
  });
  it('🔒 token DESCONHECIDO fica CRU — a prévia não inventa valor para o que não será preenchido', () => {
    expect(previewDe('Hola {{nao_existe}}')).toBe('Hola {{nao_existe}}');
    expect(previewDe('Hola {{1}}')).toBe('Hola {{1}}');
  });
  it('texto sem variável passa intacto', () => {
    expect(previewDe('Hola a todos')).toBe('Hola a todos');
  });
});

describe('restante', () => {
  it('conta o que ainda cabe', () => {
    expect(restante('')).toBe(LIMITE_CORPO);
    expect(restante('abc')).toBe(LIMITE_CORPO - 3);
  });
  it('fica NEGATIVO quando passa — é assim que a tela mostra em vermelho', () => {
    expect(restante('a'.repeat(LIMITE_CORPO + 5))).toBe(-5);
  });
});

describe('chaveDeProblema', () => {
  it('prefixa por campo para que regras homônimas tenham textos diferentes', () => {
    expect(chaveDeProblema({ campo: 'name', regra: 'obrigatorio', gravidade: 'bloqueia' as const }))
      .toBe('admin.templateDrafts.regra.name.obrigatorio');
    expect(chaveDeProblema({ campo: 'body', regra: 'obrigatorio', gravidade: 'bloqueia' as const }))
      .toBe('admin.templateDrafts.regra.body.obrigatorio');
  });
});

describe('problemasPorCampo', () => {
  it('agrupa por campo preservando a ordem', () => {
    const r = problemasPorCampo([
      { campo: 'body', regra: 'muito_longo', gravidade: 'bloqueia' as const },
      { campo: 'name', regra: 'obrigatorio', gravidade: 'bloqueia' as const },
      { campo: 'body', regra: 'placeholder_no_fim', gravidade: 'bloqueia' as const },
    ]);
    expect(r.body.map((p) => p.regra)).toEqual(['muito_longo', 'placeholder_no_fim']);
    expect(r.name).toHaveLength(1);
  });
  it('lista vazia devolve objeto vazio', () => {
    expect(problemasPorCampo([])).toEqual({});
  });
});

describe('quandoRelativo', () => {
  const agora = new Date('2026-08-31T12:00:00Z');
  it('null quando não há data — a tela diz "nunca", não inventa', () => {
    expect(quandoRelativo(null, agora)).toBeNull();
  });
  it('minutos, horas e dias', () => {
    expect(quandoRelativo('2026-08-31T11:30:00Z', agora)).toEqual({ valor: 30, unidade: 'min' });
    expect(quandoRelativo('2026-08-31T09:00:00Z', agora)).toEqual({ valor: 3, unidade: 'h' });
    expect(quandoRelativo('2026-08-28T12:00:00Z', agora)).toEqual({ valor: 3, unidade: 'd' });
  });
  it('data no futuro não vira número negativo', () => {
    expect(quandoRelativo('2026-09-01T12:00:00Z', agora)).toEqual({ valor: 0, unidade: 'min' });
  });
  it('data ilegível devolve null em vez de NaN na tela', () => {
    expect(quandoRelativo('nao-e-data', agora)).toBeNull();
  });
});

describe('inicialDaURL — o "＋ Crear versión" do catálogo', () => {
  const VAZIO = { slug: '', name: '', body: '', category: 'UTILITY', language: 'es-AR' };
  const de = (qs: string) => inicialDaURL(new URLSearchParams(qs), VAZIO);

  it('🔒 o `base` vai para o SLUG — é o que faz o par nascer certo', () => {
    // O backend prefixa por idioma, então o mesmo `base` dos dois lados vira
    // `ar_x` e `br_x`. Chegar com o campo vazio faria a pessoa redigitar de
    // cabeça, e um caractere diferente cria uma mensagem órfã.
    expect(de('base=admission_confirmation&lang=pt-BR')).toMatchObject({
      slug: 'admission_confirmation', language: 'pt-BR',
    });
  });
  it('sem parâmetro nenhum, o formulário nasce vazio como sempre nasceu', () => {
    expect(de('')).toEqual(VAZIO);
  });
  it('🔒 idioma inválido é IGNORADO, não aceito — `?lang=xx` vem da barra de endereço', () => {
    // Um valor fora do conjunto no `select` deixaria o formulário num estado
    // que o backend recusa sem a tela saber dizer por quê.
    expect(de('base=x&lang=klingon').language).toBe('es-AR');
  });
  it('espaço em volta do base não vira parte do nome', () => {
    expect(de('base=%20%20x%20%20').slug).toBe('x');
  });
  it('só o idioma, sem base, não inventa slug', () => {
    expect(de('lang=pt-BR')).toMatchObject({ slug: '', language: 'pt-BR' });
  });
});
