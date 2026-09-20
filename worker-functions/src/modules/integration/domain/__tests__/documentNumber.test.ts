/**
 * documentNumber.test.ts — cobre cada caso de rejeição citado no JSDoc de `documentNumber.ts`
 * (correção do dedupe do Axonico, F2, 18/09/2026), mais os casos válidos e a normalização.
 */

import { normalizeAndValidateDocumentNumber } from '../documentNumber';

describe('normalizeAndValidateDocumentNumber', () => {
  describe('ausente', () => {
    it('null → ausente', () => {
      expect(normalizeAndValidateDocumentNumber(null)).toEqual({ valid: false, reason: 'ausente' });
    });

    it('undefined → ausente', () => {
      expect(normalizeAndValidateDocumentNumber(undefined)).toEqual({ valid: false, reason: 'ausente' });
    });

    it("string vazia '' → ausente", () => {
      expect(normalizeAndValidateDocumentNumber('')).toEqual({ valid: false, reason: 'ausente' });
    });

    it("só espaço '   ' → ausente (normaliza para vazio)", () => {
      expect(normalizeAndValidateDocumentNumber('   ')).toEqual({ valid: false, reason: 'ausente' });
    });
  });

  describe('inválido', () => {
    it("string literal 'null' → invalido (não é o NULL do SQL — 19 pacientes medidos em produção)", () => {
      expect(normalizeAndValidateDocumentNumber('null')).toEqual({ valid: false, reason: 'invalido' });
    });

    it("string literal 'undefined' → invalido", () => {
      expect(normalizeAndValidateDocumentNumber('undefined')).toEqual({ valid: false, reason: 'invalido' });
    });

    it("'NULL' maiúsculo → invalido (case-insensitive)", () => {
      expect(normalizeAndValidateDocumentNumber('NULL')).toEqual({ valid: false, reason: 'invalido' });
    });

    it('não-numérico (letras) → invalido', () => {
      expect(normalizeAndValidateDocumentNumber('abc12345')).toEqual({ valid: false, reason: 'invalido' });
    });

    it('6 dígitos (curto demais) → invalido', () => {
      expect(normalizeAndValidateDocumentNumber('123456')).toEqual({ valid: false, reason: 'invalido' });
    });

    it('9 dígitos (longo demais) → invalido', () => {
      expect(normalizeAndValidateDocumentNumber('123456789')).toEqual({ valid: false, reason: 'invalido' });
    });

    it('com caractere não-numérico misturado (30111a22) → invalido', () => {
      expect(normalizeAndValidateDocumentNumber('30111a22')).toEqual({ valid: false, reason: 'invalido' });
    });

    it('valor não-string (number, via any) → invalido, nunca lança', () => {
      expect(normalizeAndValidateDocumentNumber(30111222 as unknown as string)).toEqual({
        valid: false,
        reason: 'invalido',
      });
    });
  });

  describe('válido', () => {
    it('7 dígitos → válido, normalized igual ao input', () => {
      expect(normalizeAndValidateDocumentNumber('3011122')).toEqual({ valid: true, normalized: '3011122' });
    });

    it('8 dígitos → válido, normalized igual ao input', () => {
      expect(normalizeAndValidateDocumentNumber('30111222')).toEqual({ valid: true, normalized: '30111222' });
    });

    it('com pontos (30.111.222) → válido, normalizado sem pontos', () => {
      expect(normalizeAndValidateDocumentNumber('30.111.222')).toEqual({ valid: true, normalized: '30111222' });
    });

    it('com espaços (30 111 222) → válido, normalizado sem espaços', () => {
      expect(normalizeAndValidateDocumentNumber('30 111 222')).toEqual({ valid: true, normalized: '30111222' });
    });

    it('com traços (30-111-222) → válido, normalizado sem traços', () => {
      expect(normalizeAndValidateDocumentNumber('30-111-222')).toEqual({ valid: true, normalized: '30111222' });
    });

    it('com espaço nas bordas (\'  30111222  \') → válido, trim aplicado', () => {
      expect(normalizeAndValidateDocumentNumber('  30111222  ')).toEqual({ valid: true, normalized: '30111222' });
    });
  });
});
