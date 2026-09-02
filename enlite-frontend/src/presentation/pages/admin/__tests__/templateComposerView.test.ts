/**
 * A lógica do compositor (Tela 2).
 *
 * 🔒 O TESTE QUE MOTIVOU ESTE ARQUIVO. A primeira versão de `listaDeVerificacao`
 * mapeava regras que NÃO EXISTEM — `variavel_nao_suportada`, `conteudo_proibido`,
 * `clausula_de_baja`. Como o estado `ok` é derivado por AUSÊNCIA de problema,
 * todos os itens teriam ficado verdes para sempre: a lista inteira seria
 * decoração que nunca acende, e nenhuma asserção sobre "o item aparece" pegaria
 * isso — o item aparece, só nunca muda de cor.
 *
 * Por isso o primeiro bloco cruza o mapa com a lista real de regras do backend.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ProblemaDeRegra } from '@infrastructure/http/AdminTemplateDraftsApiService';
import {
  ES, PT, REGRAS_MAPEADAS, categoriaDoTipo, contagemDaLista,
  listaDeVerificacao, parDeSlugs, tipoDaCategoria,
} from '../templateComposerView';

const bloqueia = (regra: string, campo: ProblemaDeRegra['campo'] = 'body'): ProblemaDeRegra =>
  ({ campo, regra, gravidade: 'bloqueia' });
const avisa = (regra: string, campo: ProblemaDeRegra['campo'] = 'body'): ProblemaDeRegra =>
  ({ campo, regra, gravidade: 'aviso' });

describe('🔒 o mapa de regras contra a FONTE — o backend', () => {
  /**
   * Lê `templateDraftRules.ts` e extrai os nomes que `validarRascunho` emite.
   *
   * ⚠️ Ler o arquivo do outro pacote é feio e é DE PROPÓSITO. A alternativa era
   * escrever a lista à mão aqui, e uma lista à mão é exatamente o que já falhou:
   * ela confirma o que o autor acha, não o que o sistema faz. O caminho relativo
   * quebrar é um sinal legítimo — significa que a fonte mudou de lugar.
   */
  const regrasDoBackend = (): Set<string> => {
    const caminho = resolve(
      __dirname,
      '../../../../../../worker-functions/src/modules/notification/domain/templateDraftRules.ts',
    );
    const src = readFileSync(caminho, 'utf-8');
    const nomes = new Set<string>();
    /*
     * ⚠️ CAPTURA A CHAMADA INTEIRA, não só o segundo argumento literal. A
     * primeira versão deste extrator casava apenas `avisa('body', 'x')` e
     * PERDIA `avisa('body', precisaAR ? 'sem_clausula_de_baja' :
     * 'sem_caminho_de_saida')` — duas regras reais, emitidas por ternário.
     * O teste então acusou o mapa de inventar dois nomes que existiam. O
     * instrumento estava errado, não o autor; e essa é a ordem em que se
     * investiga.
     */
    for (const chamada of src.matchAll(/(?:bloqueia|avisa)\(([^)]*)\)/g)) {
      // O 1º literal é o CAMPO; os demais são nomes de regra.
      const literais = [...chamada[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
      for (const nome of literais.slice(1)) nomes.add(nome);
    }
    return nomes;
  };

  it('a fonte foi encontrada e tem regras — contagem zero é falha, não sucesso', () => {
    const reais = regrasDoBackend();
    expect(reais.size).toBeGreaterThan(10);
  });

  it('🔒 toda regra que a lista mapeia EXISTE no backend', () => {
    const reais = regrasDoBackend();
    const inventadas = REGRAS_MAPEADAS.filter((r) => !reais.has(r));
    expect(inventadas).toEqual([]);
  });

  /**
   * O outro lado: regra que o backend emite e que a lista não sabe desenhar.
   * Não é erro — a lista não precisa cobrir tudo (`category.invalida` e
   * `language.invalido` são impossíveis pela tela, que não deixa escolher valor
   * inválido). Mas precisa estar DECLARADO, senão uma regra nova entra em
   * produção sem lugar nenhum na tela e ninguém percebe.
   */
  it('as regras NÃO mapeadas são exatamente as que a tela não pode produzir', () => {
    const reais = [...regrasDoBackend()].sort();
    const naoMapeadas = reais.filter((r) => !REGRAS_MAPEADAS.includes(r));
    expect(naoMapeadas.sort()).toEqual(['invalida', 'invalido']);
  });
});

describe('o tipo de mensagem vira categoria — sem a pessoa ver a palavra', () => {
  it('aviso do processo é transacional', () => {
    expect(categoriaDoTipo('aviso')).toBe('UTILITY');
  });

  it('difusão é campanha', () => {
    expect(categoriaDoTipo('difusion')).toBe('MARKETING');
  });

  it('a volta reabre um rascunho já salvo', () => {
    expect(tipoDaCategoria('MARKETING')).toBe('difusion');
  });

  /** UTILITY mapeia para dois tipos; a volta cai no primeiro, e isso é declarado. */
  it('UTILITY volta como "aviso" — a ambiguidade é conhecida, não silenciosa', () => {
    expect(tipoDaCategoria('UTILITY')).toBe('aviso');
  });

  it('categoria que não conhecemos não quebra: cai no padrão', () => {
    expect(tipoDaCategoria('AUTHENTICATION')).toBe('aviso');
  });
});

describe('o par de slugs', () => {
  it('um nome faz nascer os dois', () => {
    expect(parDeSlugs('bienvenida_contratacion')).toEqual({
      [ES]: 'ar_bienvenida_contratacion',
      [PT]: 'br_bienvenida_contratacion',
    });
  });

  it('normaliza espaço, acento e maiúscula', () => {
    expect(parDeSlugs('  Bienvenida Nueva  ')[ES]).toBe('ar_bienvenida_nueva');
  });

  /** Idempotente: salvar duas vezes não produz `ar_ar_convite`. */
  it('🔒 não duplica o prefixo quando o nome já o tem', () => {
    expect(parDeSlugs('ar_convite')[ES]).toBe('ar_convite');
  });

  it('nome vazio devolve vazio — a tela esconde o par em vez de mostrar "ar_"', () => {
    expect(parDeSlugs('   ')).toEqual({ [ES]: '', [PT]: '' });
  });
});

describe('a lista de verificação', () => {
  it('texto limpo fica todo verde', () => {
    const itens = listaDeVerificacao([], 'Hola {{worker_name}}, todo bien', false);
    expect(itens.every((i) => i.estado === 'ok')).toBe(true);
  });

  it('variável desconhecida acende o item das variáveis', () => {
    const itens = listaDeVerificacao([bloqueia('variavel_desconhecida')], 'x', false);
    expect(itens.find((i) => i.chave === 'variaveis')?.estado).toBe('impede');
  });

  it('placeholder no início acende o item das bordas', () => {
    const itens = listaDeVerificacao([bloqueia('placeholder_no_inicio')], 'x', false);
    expect(itens.find((i) => i.chave === 'bordas')?.estado).toBe('impede');
  });

  /**
   * 🔒 AMARELO NÃO É VERMELHO. A cláusula de baja é AVISO: grava e envia mesmo
   * assim. Pintá-la de vermelho faria a pessoa parar de distinguir "preciso
   * resolver" de "posso seguir".
   */
  it('a cláusula de baja ausente é AVISO, não bloqueio', () => {
    const itens = listaDeVerificacao([avisa('sem_clausula_de_baja')], 'x', false);
    expect(itens.find((i) => i.chave === 'clausulaBaja')?.estado).toBe('falta');
  });

  /** Um item que junta várias regras mostra a PIOR: o que importa é se impede. */
  it('bloqueio e aviso no mesmo item resultam em bloqueio', () => {
    const itens = listaDeVerificacao(
      [avisa('sem_clausula_de_baja'), bloqueia('clausula_de_baja_nao_reconhecida')], 'x', false,
    );
    expect(itens.find((i) => i.chave === 'clausulaBaja')?.estado).toBe('impede');
  });

  it('o idioma que falta entra como aviso e por último', () => {
    const itens = listaDeVerificacao([], 'x', true);
    expect(itens[itens.length - 1]).toMatchObject({ chave: 'outroIdioma', estado: 'falta' });
  });

  it('com os dois idiomas escritos, esse item nem existe', () => {
    const itens = listaDeVerificacao([], 'x', false);
    expect(itens.some((i) => i.chave === 'outroIdioma')).toBe(false);
  });

  it('o item do tamanho carrega os números para o texto', () => {
    const itens = listaDeVerificacao([], 'abc', false);
    expect(itens.find((i) => i.chave === 'tamanho')?.dados).toMatchObject({ n: 3, limite: 1024 });
  });

  it('a contagem conta só os verdes', () => {
    const itens = listaDeVerificacao([bloqueia('variavel_desconhecida')], 'x', true);
    const { ok, total } = contagemDaLista(itens);
    expect(total).toBe(7);
    expect(ok).toBe(5);
  });
});
