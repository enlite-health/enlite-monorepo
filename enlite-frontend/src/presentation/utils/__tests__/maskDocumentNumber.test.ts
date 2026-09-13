import { describe, it, expect } from 'vitest';
import { maskDocumentNumber } from '../maskDocumentNumber';

describe('maskDocumentNumber (spec 018 PR-3, lex #3(b), FR-210)', () => {
  it('mascara tudo menos os últimos 3 caracteres alfanuméricos', () => {
    expect(maskDocumentNumber('12345678')).toBe('•••••678');
  });

  it('preserva separadores, mascarando só alfanuméricos', () => {
    expect(maskDocumentNumber('30.111.222')).toBe('••.•••.222');
  });

  it('documento com 3 ou menos caracteres fica todo visível (nada a mascarar)', () => {
    expect(maskDocumentNumber('123')).toBe('123');
    expect(maskDocumentNumber('1')).toBe('1');
  });

  it('null/undefined/vazio → null (nunca lança, nunca mostra "null" na tela)', () => {
    expect(maskDocumentNumber(null)).toBeNull();
    expect(maskDocumentNumber(undefined)).toBeNull();
    expect(maskDocumentNumber('')).toBeNull();
    expect(maskDocumentNumber('...')).toBeNull(); // só separador, 0 alfanumérico
  });

  it('nunca contém a substring completa do documento original quando > 3 chars', () => {
    const raw = 'AB1234567';
    const out = maskDocumentNumber(raw)!;
    expect(out).not.toBe(raw);
    expect(out.endsWith('567')).toBe(true);
    expect(out).not.toContain('AB1');
  });
});
