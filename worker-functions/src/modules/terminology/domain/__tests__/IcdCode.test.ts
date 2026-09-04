/**
 * IcdCode — Value Object (spec 016, "Contrato de arquitetura"). Resposta direta ao defeito
 * medido na F0 (relatorio.md §4): dentro do drawer, a ECT truncava `6A02.Z` para `02.Z` NA TELA
 * com o DOM correto por baixo. Um VO que valida formato e carrega o código INTEIRO torna esse
 * defeito estruturalmente impossível em qualquer lugar que passe a manipular `IcdCode` em vez
 * de `string` crua — não há como "cortar o prefixo" sem quebrar o tipo.
 *
 * 🔧 F1-CORREÇÃO D7 (03/09): a regex original ACEITAVA `02.Z` como código "sintaticamente
 * válido" — exatamente o valor truncado do defeito da F0, que este VO existe para impedir.
 * Verificado contra os 35.692 códigos reais do release 2026-01 (0 rejeitados) em
 * tests/e2e/icd-code-real-catalog.e2e.test.ts — aqui só a forma, sem precisar do banco.
 */
import { IcdCode, InvalidIcdCodeError } from '../IcdCode';

describe('IcdCode', () => {
  it('aceita código stem com ponto (6A02.Z) e carrega o INTEIRO, sem truncar', () => {
    const code = IcdCode.parse('6A02.Z');
    expect(code.value).toBe('6A02.Z');
    expect(code.toString()).toBe('6A02.Z');
  });

  it('aceita stem com sufixo de 2 alfanuméricos (8A60.5, QA0A.10)', () => {
    expect(IcdCode.parse('8A60.5').value).toBe('8A60.5');
    expect(IcdCode.parse('QA0A.10').value).toBe('QA0A.10');
  });

  it('aceita stem sem ponto, prefixo de 4 (1A00, SA0Z, GB7Z)', () => {
    expect(IcdCode.parse('1A00').value).toBe('1A00');
    expect(IcdCode.parse('SA0Z').value).toBe('SA0Z');
    expect(IcdCode.parse('GB7Z').value).toBe('GB7Z');
  });

  it('aceita código de capítulo curto (06, X, V)', () => {
    expect(IcdCode.parse('06').value).toBe('06');
    expect(IcdCode.parse('X').value).toBe('X');
    expect(IcdCode.parse('V').value).toBe('V');
  });

  it('aceita código de extensão sem ponto, 4 a 6 caracteres começando com X (XM6S30, XE1JQ)', () => {
    expect(IcdCode.parse('XM6S30').value).toBe('XM6S30');
    expect(IcdCode.parse('XE1JQ').value).toBe('XE1JQ');
  });

  it('rejeita string vazia', () => {
    expect(() => IcdCode.parse('')).toThrow(InvalidIcdCodeError);
  });

  it('D7 — REJEITA o código truncado que perdeu o prefixo do capítulo (o defeito medido na F0)', () => {
    // "02.Z" é exatamente o que a ECT mostrava na tela em vez de "6A02.Z". Antes da F1-correção
    // D7, o VO aceitava essa forma como "sintaticamente válida" — o que reabria a porta para o
    // MESMO defeito em qualquer código novo que nascesse já truncado (ex.: um parser upstream
    // que corte os 2 primeiros caracteres por engano). Rejeitar na entrada fecha essa porta.
    expect(() => IcdCode.parse('02.Z')).toThrow(InvalidIcdCodeError);
    expect(() => IcdCode.parse('A02.Z')).toThrow(InvalidIcdCodeError);
    expect(() => IcdCode.parse('2.Z')).toThrow(InvalidIcdCodeError);
  });

  it('o código correto (não truncado) nunca é confundido com a forma truncada', () => {
    const original = IcdCode.parse('6A02.Z');
    expect(original.value).not.toBe('02.Z');
    expect(original.value.length).toBe('6A02.Z'.length);
  });

  it('rejeita minúsculas (a OMS sempre entrega maiúsculo; normalizar esconderia dado divergente)', () => {
    expect(() => IcdCode.parse('6a02.z')).toThrow(InvalidIcdCodeError);
  });

  it('rejeita espaço interno e caracteres fora do alfabeto', () => {
    expect(() => IcdCode.parse('6A0 2.Z')).toThrow(InvalidIcdCodeError);
    expect(() => IcdCode.parse('6A02.Z!')).toThrow(InvalidIcdCodeError);
  });

  it('rejeita prefixo de stem com tamanho errado (3 ou 5 caracteres antes do ponto)', () => {
    expect(() => IcdCode.parse('6A0.Z')).toThrow(InvalidIcdCodeError);
    expect(() => IcdCode.parse('6A020.Z')).toThrow(InvalidIcdCodeError);
  });

  it('aceita espaço nas bordas (trim) sem alterar o valor guardado', () => {
    expect(IcdCode.parse('  6A02.Z  ').value).toBe('6A02.Z');
  });

  it('equals compara pelo valor completo', () => {
    const a = IcdCode.parse('6A02.Z');
    const b = IcdCode.parse('6A02.Z');
    const c = IcdCode.parse('6A02.Y');
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
  });

  it('InvalidIcdCodeError carrega o valor rejeitado na mensagem, para depuração', () => {
    try {
      IcdCode.parse('???');
      throw new Error('deveria ter lançado');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidIcdCodeError);
      expect((err as Error).message).toContain('???');
    }
  });

  it('D7 — parse(null)/parse(undefined) lança InvalidIcdCodeError, nunca TypeError', () => {
    // Antes da correção, `raw.trim()` num `null` vazava `TypeError: Cannot read properties of
    // null` — um tipo de erro diferente de todo o resto da validação, que quem chama não espera
    // capturar. Dado externo (JSON solto, linha de banco sem tipo) não obedece `string` do TS
    // em runtime; o VO tem que se defender igual para qualquer entrada inválida.
    expect(() => IcdCode.parse(null)).toThrow(InvalidIcdCodeError);
    expect(() => IcdCode.parse(undefined)).toThrow(InvalidIcdCodeError);
    expect(() => IcdCode.parse(null)).not.toThrow(TypeError);
  });
});
