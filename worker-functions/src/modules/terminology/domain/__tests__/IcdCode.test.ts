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

  /**
   * 🔧 F5-CORREÇÃO T7 (QA-caça, 05/09/2026) — INVERSÃO DELIBERADA DE UM TESTE VERDE.
   *
   * A versão anterior deste teste se chamava "InvalidIcdCodeError carrega o valor rejeitado na
   * mensagem, para depuração" e asseverava `expect(message).toContain('???')`. Ou seja: o
   * vazamento estava FIXADO por um teste verde cujo nome declarava o comportamento errado como
   * desejado — e o arquivo está no piso de 100% de cobertura. Cobertura cheia sobre a asserção
   * errada é o modo de falha que o CLAUDE.md chama de "contrato é TETO, não chão".
   *
   * O código CID-11 identifica um conceito clínico. `reportError` loga `err.message` (e o
   * `stack`, que embute a message) JUNTO do `patientId`. "Para depuração" não é justificativa
   * para pôr identidade clínica no log: o que a depuração precisa — ausente x forma inválida, e
   * o tamanho — continua na mensagem e não identifica ninguém.
   */
  it('T7 — InvalidIcdCodeError NÃO carrega o valor rejeitado na mensagem (nem no stack)', () => {
    try {
      IcdCode.parse('6A02.Z-SEGREDO');
      throw new Error('deveria ter lançado');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidIcdCodeError);
      const e = err as Error;
      expect(e.message).not.toContain('6A02');
      expect(e.message).not.toContain('SEGREDO');
      expect(e.stack ?? '').not.toContain('SEGREDO');
      // O que SOBRA é diagnóstico sem identidade: forma inválida + tamanho.
      expect(e.message).toBe('Código CID-11 inválido: forma não reconhecida (14 caracteres)');
    }
  });

  it('T7 — parse(null)/parse(undefined) diz "ausente" (a causa), sem tentar medir comprimento', () => {
    for (const raw of [null, undefined]) {
      try {
        IcdCode.parse(raw);
        throw new Error('deveria ter lançado');
      } catch (err) {
        expect((err as Error).message).toBe('Código CID-11 inválido: ausente');
      }
    }
  });

  describe('F1.5-CORREÇÃO C1 (D261) — cluster pós-coordenado como string opaca', () => {
    // D164/D190 avisaram nominalmente: "o que se guarda num campo código pode ser XX/YY&ZZ".
    // A regra dura era violada em silêncio — `/` e `&` não entravam no alfabeto aceito.
    it('aceita extensão via `/` (KA00.0/XS2R)', () => {
      expect(IcdCode.parse('KA00.0/XS2R').value).toBe('KA00.0/XS2R');
    });

    it('aceita cluster via `&` (6A02.Z&XS5W)', () => {
      expect(IcdCode.parse('6A02.Z&XS5W').value).toBe('6A02.Z&XS5W');
    });

    it('continua REJEITANDO o código truncado, mesmo dentro da forma de cluster', () => {
      expect(() => IcdCode.parse('02.Z')).toThrow(InvalidIcdCodeError);
      expect(() => IcdCode.parse('A02.Z')).toThrow(InvalidIcdCodeError);
      expect(() => IcdCode.parse('2.Z')).toThrow(InvalidIcdCodeError);
      // truncado como MEMBRO de um cluster também é rejeitado — a válvula não abre uma
      // segunda porta para o mesmo defeito.
      expect(() => IcdCode.parse('02.Z/XS2R')).toThrow(InvalidIcdCodeError);
      expect(() => IcdCode.parse('6A02.Z&02.Z')).toThrow(InvalidIcdCodeError);
    });

    it('`.stem` expõe o código base, sem a extensão/cluster', () => {
      expect(IcdCode.parse('KA00.0/XS2R').stem).toBe('KA00.0');
      expect(IcdCode.parse('6A02.Z&XS5W').stem).toBe('6A02.Z');
    });

    it('`.stem` de um código simples (sem cluster) é o próprio valor', () => {
      expect(IcdCode.parse('6A02.Z').stem).toBe('6A02.Z');
      expect(IcdCode.parse('06').stem).toBe('06');
    });
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
