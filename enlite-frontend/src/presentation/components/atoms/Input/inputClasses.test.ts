/**
 * ⚠️ OS SNAPSHOTS DESTE ARQUIVO FORAM REGRAVADOS EM 01/09/2026, e a razão está
 * aqui para não virar "aceita o que veio".
 *
 * `dense` entrou (o tamanho do desenho de plantillas) e, com ele, a COR, o PESO
 * e a LARGURA DA BORDA saíram do bloco base e viraram token por tamanho — sem
 * isso, um `text-primary`/`font-normal` por fora colidiria com o `text-[#737373]`
 * / `font-medium` do base, e quem vence duas utilitárias iguais depende da ordem
 * em que o Tailwind emite, não da ordem em que foram escritas.
 *
 * 🔒 Isso muda a ORDEM da string, não o conjunto. Verificado antes de regravar:
 * para `default` e `compact` o conjunto de classes é IDÊNTICO ao do HEAD —
 * `só_no_HEAD` e `só_agora` vazios nos dois. O teste abaixo trava essa
 * propriedade, que é a que de fato importa: snapshot de string sensível a ordem
 * aprova ou reprova por um motivo que não é visual.
 */
import { describe, it, expect } from 'vitest';
import {
  inputBaseClasses,
  inputWrapperClasses,
  textareaBaseClasses,
  INPUT_SIZE_CONFIG,
} from './inputClasses';

describe('🔒 os tamanhos que já existiam — conjunto de classes intocado', () => {
  /**
   * O conjunto, não a string. É o que resiste a uma reordenação e ainda pega
   * uma classe acrescentada ou removida por engano.
   */
  const conjunto = (s: string) => new Set(s.split(' ').filter(Boolean));

  it('default continua com exatamente as mesmas classes', () => {
    expect(conjunto(inputBaseClasses({ size: 'default' }))).toEqual(new Set([
      'w-full', 'bg-white', "font-['Lexend']", 'font-medium', 'text-[#737373]',
      'placeholder:text-[#737373]/60', 'focus:outline-none', 'transition-colors',
      'border-solid', 'h-[60px]', 'px-5', 'py-3', 'text-[20px]', 'leading-[1.3]',
      'rounded-[10px]', 'border-2', 'border-[#d9d9d9]', 'focus:border-[#180149]',
    ]));
  });

  it('compact continua com exatamente as mesmas classes', () => {
    expect(conjunto(inputBaseClasses({ size: 'compact' }))).toEqual(new Set([
      'w-full', 'bg-white', "font-['Lexend']", 'font-medium', 'text-[#737373]',
      'placeholder:text-[#737373]/60', 'focus:outline-none', 'transition-colors',
      'border-solid', 'h-12', 'px-4', 'py-2', 'text-sm', 'leading-[1.3]',
      'rounded-[10px]', 'border-[1.5px]', 'border-[#d9d9d9]', 'focus:border-[#180149]',
    ]));
  });

  it('dense é o do desenho: 35px, texto 13, peso 400, tinta escura', () => {
    const c = conjunto(inputBaseClasses({ size: 'dense' }));
    expect(c).toContain('h-[35px]');
    expect(c).toContain('text-[13px]');
    expect(c).toContain('font-normal');
    expect(c).toContain('text-primary');
    expect(c).toContain('border');
  });

  /** O textarea respira mais que o input de uma linha — 12px contra 9px. */
  it('dense dá padding próprio ao textarea', () => {
    expect(textareaBaseClasses({ size: 'dense' })).toContain('py-[12px]');
    expect(inputBaseClasses({ size: 'dense' })).toContain('py-[9px]');
  });
});

describe('INPUT_SIZE_CONFIG', () => {
  it('contém entrada default com valores corretos', () => {
    expect(INPUT_SIZE_CONFIG.default.height).toBe('h-[60px]');
    expect(INPUT_SIZE_CONFIG.default.padding).toBe('px-5 py-3');
    expect(INPUT_SIZE_CONFIG.default.fontSize).toBe('text-[20px]');
    expect(INPUT_SIZE_CONFIG.default.borderRadius).toBe('rounded-[10px]');
  });

  it('contém entrada compact com valores corretos', () => {
    expect(INPUT_SIZE_CONFIG.compact.height).toBe('h-12');
    expect(INPUT_SIZE_CONFIG.compact.padding).toBe('px-4 py-2');
    expect(INPUT_SIZE_CONFIG.compact.fontSize).toBe('text-sm');
    expect(INPUT_SIZE_CONFIG.compact.borderRadius).toBe('rounded-[10px]');
  });
});

describe('inputBaseClasses', () => {
  it('snapshot — default idle', () => {
    expect(inputBaseClasses()).toMatchSnapshot();
  });

  it('snapshot — default error', () => {
    expect(inputBaseClasses({ error: true })).toMatchSnapshot();
  });

  it('snapshot — default disabled', () => {
    expect(inputBaseClasses({ disabled: true })).toMatchSnapshot();
  });

  it('snapshot — compact idle', () => {
    expect(inputBaseClasses({ size: 'compact' })).toMatchSnapshot();
  });

  it('snapshot — compact error', () => {
    expect(inputBaseClasses({ size: 'compact', error: true })).toMatchSnapshot();
  });

  it('snapshot — compact disabled', () => {
    expect(inputBaseClasses({ size: 'compact', disabled: true })).toMatchSnapshot();
  });

  it('snapshot — default error + disabled', () => {
    expect(inputBaseClasses({ error: true, disabled: true })).toMatchSnapshot();
  });

  it('inclui border-red-500 quando error=true', () => {
    const cls = inputBaseClasses({ error: true });
    expect(cls).toContain('border-red-500');
    expect(cls).not.toContain('border-[#d9d9d9]');
  });

  it('inclui border-[#d9d9d9] quando sem error', () => {
    const cls = inputBaseClasses();
    expect(cls).toContain('border-[#d9d9d9]');
    expect(cls).not.toContain('border-red-500');
  });

  it('inclui focus:border-[#180149] quando sem error', () => {
    const cls = inputBaseClasses();
    expect(cls).toContain('focus:border-[#180149]');
  });

  it('NAO inclui focus:border quando com error', () => {
    const cls = inputBaseClasses({ error: true });
    expect(cls).not.toContain('focus:border-[#180149]');
  });

  it('inclui fundo cinza e cursor-not-allowed quando disabled', () => {
    const cls = inputBaseClasses({ disabled: true });
    expect(cls).toContain('bg-[#f3f4f6]');
    expect(cls).toContain('cursor-not-allowed');
  });

  it('NAO inclui classes de disabled quando disabled=false', () => {
    const cls = inputBaseClasses({ disabled: false });
    expect(cls).not.toContain('cursor-not-allowed');
  });

  it('inclui h-[60px] para size default', () => {
    const cls = inputBaseClasses({ size: 'default' });
    expect(cls).toContain('h-[60px]');
  });

  it('inclui h-12 para size compact', () => {
    const cls = inputBaseClasses({ size: 'compact' });
    expect(cls).toContain('h-12');
  });

  it('omite height quando omitHeight=true', () => {
    const cls = inputBaseClasses({ omitHeight: true });
    expect(cls).not.toContain('h-[60px]');
    expect(cls).not.toContain('h-12');
  });

  it('usa border-2 para size default', () => {
    const cls = inputBaseClasses({ size: 'default' });
    expect(cls).toContain('border-2');
  });

  it('usa border-[1.5px] para size compact', () => {
    const cls = inputBaseClasses({ size: 'compact' });
    expect(cls).toContain('border-[1.5px]');
    expect(cls).not.toContain('border-2');
  });
});

describe('textareaBaseClasses', () => {
  it('NAO inclui nenhuma classe de height', () => {
    const cls = textareaBaseClasses();
    expect(cls).not.toContain('h-[60px]');
    expect(cls).not.toContain('h-12');
  });

  it('inclui border-red-500 quando error=true', () => {
    const cls = textareaBaseClasses({ error: true });
    expect(cls).toContain('border-red-500');
  });

  it('snapshot — textarea idle', () => {
    expect(textareaBaseClasses()).toMatchSnapshot();
  });
});

describe('inputWrapperClasses', () => {
  it('inclui height do size', () => {
    const cls = inputWrapperClasses({ size: 'default' });
    expect(cls).toContain('h-[60px]');
  });

  it('inclui focus-within:border-[#180149] quando sem error', () => {
    const cls = inputWrapperClasses();
    expect(cls).toContain('focus-within:border-[#180149]');
  });

  it('NAO inclui focus-within quando com error', () => {
    const cls = inputWrapperClasses({ error: true });
    expect(cls).not.toContain('focus-within:border-[#180149]');
  });

  it('inclui border-red-500 quando error=true', () => {
    const cls = inputWrapperClasses({ error: true });
    expect(cls).toContain('border-red-500');
  });

  it('snapshot — wrapper default idle', () => {
    expect(inputWrapperClasses()).toMatchSnapshot();
  });
});
