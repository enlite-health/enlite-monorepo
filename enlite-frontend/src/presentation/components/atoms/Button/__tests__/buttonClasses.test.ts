/**
 * Os tokens visuais do botão.
 *
 * 🔒 POR QUE TRAVAR ISTO. 618 chamadas com `size=` dependem de `sm`/`md`/`lg`,
 * espalhadas por 99 arquivos. Quando `compact` foi acrescentado, o peso da fonte
 * teve de sair do bloco base e virar token por tamanho — e uma troca de peso
 * silenciosa em `md` mudaria a aparência de dezenas de telas sem nenhum teste
 * ficando vermelho. Este arquivo é o controle contra isso.
 *
 * ⚠️ Ele afirma CLASSE, não pixel. Não substitui olhar a tela: garante que os
 * três tamanhos canônicos não mudaram enquanto o quarto era acrescentado.
 */
import { describe, it, expect } from 'vitest';
import { buttonClasses } from '../buttonClasses';

describe('os tamanhos canônicos do Figma — intocados', () => {
  it('sm continua 32px, texto 14, peso 600', () => {
    const c = buttonClasses({ size: 'sm' });
    expect(c).toContain('h-8');
    expect(c).toContain('px-4');
    expect(c).toContain('text-sm');
    expect(c).toContain('font-semibold');
  });

  it('md continua 40px, texto 16, peso 600', () => {
    const c = buttonClasses({ size: 'md' });
    expect(c).toContain('h-10');
    expect(c).toContain('px-6');
    expect(c).toContain('text-base');
    expect(c).toContain('font-semibold');
  });

  it('lg continua 48px, texto 16, peso 600', () => {
    const c = buttonClasses({ size: 'lg' });
    expect(c).toContain('h-12');
    expect(c).toContain('px-8');
    expect(c).toContain('text-base');
    expect(c).toContain('font-semibold');
  });

  it('o padrão continua sendo md — nenhuma chamada sem `size` muda', () => {
    expect(buttonClasses()).toBe(buttonClasses({ size: 'md' }));
  });
});

describe('compact — a variação do desenho de plantillas', () => {
  /** O `.s-btn` da maquete: `padding: 8px 18px; font-size: 13px; font-weight: 500`. */
  it('é 38px, padding 8×18, texto 13, peso 500 — os números medidos do desenho', () => {
    const c = buttonClasses({ size: 'compact' });
    expect(c).toContain('h-[38px]');
    expect(c).toContain('px-[18px]');
    expect(c).toContain('py-2');
    expect(c).toContain('text-[13px]');
    expect(c).toContain('font-medium');
  });

  /**
   * 🔒 UM PESO SÓ POR CLASSE. Enquanto `font-semibold` vivia no bloco base, um
   * `font-medium` acrescentado por fora colidia com ele: duas utilitárias de
   * `font-weight` na mesma string, e quem vence depende da ordem em que o
   * Tailwind as emite — não da ordem em que foram escritas. O bug seria
   * invisível no código e visível só na tela.
   */
  it('🔒 não carrega DOIS pesos de fonte na mesma classe', () => {
    for (const size of ['compact', 'sm', 'md', 'lg'] as const) {
      const pesos = buttonClasses({ size }).match(/font-(medium|semibold|bold|normal)/g) ?? [];
      expect(pesos, `${size} trouxe ${pesos.join(' + ')}`).toHaveLength(1);
    }
  });

  /**
   * 🔒 A ALTURA VEIO DA MEDIÇÃO, não do olho. O `pixel-loop` mediu o `.s-btn` da
   * maquete em 38px (8+8 de padding + 19,5 de entrelinha + 2×1 de borda). A
   * primeira versão deste tamanho tinha 34px, escolhidos por cálculo meu — e o
   * medidor acusou os 4px.
   */
  it('a altura é a medida do `.s-btn` da maquete: 38px', () => {
    expect(buttonClasses({ size: 'compact' })).toContain('h-[38px]');
  });

  /**
   * 🔒 O CONTRÁRIO DO QUE EU TINHA FEITO. A maquete pinta o outline de branco e
   * eu mudei o atom — o que trocaria o fundo de todo botão outline do app. Um
   * teste de outra tela pegou. O escopo aprovado era "fiel à imagem NESTAS
   * telas", não "trocar o sistema por causa delas".
   */
  it('🔒 outline segue TRANSPARENTE — a maquete não redefine o atom', () => {
    expect(buttonClasses({ variant: 'outline' })).toContain('bg-transparent');
  });
});

describe('xs e quiet — a barra de ações do cabeçalho (06/09)', () => {
  /**
   * 🔒 Entraram no design system sem asserção nenhuma e o gate pegou. A métrica de 100% deste
   * arquivo NÃO prova nada: `SIZE` e `VARIANT` são literais de módulo, sempre "executados" —
   * cobertura alta com zero verificação é o caso de "contrato é TETO, não chão".
   */
  it('xs é o degrau ABAIXO do sm: 28px, 13px, peso 500', () => {
    const xs = buttonClasses({ size: 'xs' });
    expect(xs).toContain('h-7');
    expect(xs).toContain('text-[13px]');
    expect(xs).toContain('font-medium');
    // e continua menor que o sm, que é 32px/14px/600 — se alguém inverter, quebra
    expect(buttonClasses({ size: 'sm' })).toContain('h-8');
  });

  it('quiet tem moldura de 1px em cinza — NÃO os 2px de índigo do outline', () => {
    const quiet = buttonClasses({ variant: 'quiet' });
    expect(quiet).toContain('border-gray-600');
    expect(quiet).toContain('text-primary');
    expect(quiet).not.toContain('border-2');
  });

  /**
   * 🔒 A razão de `quiet` existir em vez de afinar a `outline`: ela está em 99 arquivos, e o
   * comentário do próprio atom registra uma tentativa anterior de mexer que quebrou outra tela.
   */
  it('🔒 outline NÃO foi afinada para acomodar a barra', () => {
    expect(buttonClasses({ variant: 'outline' })).toContain('border-2');
  });
});

describe('variante e largura', () => {
  it('fullWidth ocupa a linha', () => {
    expect(buttonClasses({ fullWidth: true })).toContain('w-full');
    expect(buttonClasses({ fullWidth: false })).not.toContain('w-full');
  });
});
