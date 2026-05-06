import { describe, it, expect } from 'vitest';
import {
  inputBaseClasses,
  inputWrapperClasses,
  textareaBaseClasses,
  INPUT_SIZE_CONFIG,
} from './inputClasses';

describe('INPUT_SIZE_CONFIG', () => {
  it('contém entrada default com valores corretos', () => {
    expect(INPUT_SIZE_CONFIG.default.height).toBe('h-[60px]');
    expect(INPUT_SIZE_CONFIG.default.padding).toBe('px-5 py-3');
    expect(INPUT_SIZE_CONFIG.default.fontSize).toBe('text-[20px]');
    expect(INPUT_SIZE_CONFIG.default.borderRadius).toBe('rounded-[10px]');
  });

  it('contém entrada compact com valores corretos', () => {
    expect(INPUT_SIZE_CONFIG.compact.height).toBe('h-[42px]');
    expect(INPUT_SIZE_CONFIG.compact.padding).toBe('px-3 py-2');
    expect(INPUT_SIZE_CONFIG.compact.fontSize).toBe('text-sm');
    expect(INPUT_SIZE_CONFIG.compact.borderRadius).toBe('rounded-lg');
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

  it('inclui h-[42px] para size compact', () => {
    const cls = inputBaseClasses({ size: 'compact' });
    expect(cls).toContain('h-[42px]');
  });

  it('omite height quando omitHeight=true', () => {
    const cls = inputBaseClasses({ omitHeight: true });
    expect(cls).not.toContain('h-[60px]');
    expect(cls).not.toContain('h-[42px]');
  });

  it('usa border-2 para size default', () => {
    const cls = inputBaseClasses({ size: 'default' });
    expect(cls).toContain('border-2');
  });

  it('usa border (simples) para size compact', () => {
    const cls = inputBaseClasses({ size: 'compact' });
    expect(cls).toContain(' border ');
    expect(cls).not.toContain('border-2');
  });
});

describe('textareaBaseClasses', () => {
  it('NAO inclui nenhuma classe de height', () => {
    const cls = textareaBaseClasses();
    expect(cls).not.toContain('h-[60px]');
    expect(cls).not.toContain('h-[42px]');
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
