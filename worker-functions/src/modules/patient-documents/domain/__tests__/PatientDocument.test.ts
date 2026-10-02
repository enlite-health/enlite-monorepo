import {
  normalizeDocumentLabel,
  InvalidDocumentLabelError,
  DOCUMENT_LABEL_MAX_LENGTH,
} from '../PatientDocument';

describe('normalizeDocumentLabel (FR-002/FR-013)', () => {
  it('faz trim e devolve o nome', () => {
    expect(normalizeDocumentLabel('  DNI frente  ')).toBe('DNI frente');
  });

  it('aceita exatamente 255 caracteres', () => {
    expect(normalizeDocumentLabel('a'.repeat(DOCUMENT_LABEL_MAX_LENGTH))).toHaveLength(DOCUMENT_LABEL_MAX_LENGTH);
  });

  it.each([['vazio', ''], ['só espaços', '   \t '], ['256 caracteres', 'a'.repeat(256)], ['null', null], ['número', 42], ['undefined', undefined]])(
    'recusa %s com InvalidDocumentLabelError (400) sem ecoar o valor',
    (_nome, valor) => {
      let erro: unknown;
      try {
        normalizeDocumentLabel(valor);
      } catch (e) {
        erro = e;
      }
      expect(erro).toBeInstanceOf(InvalidDocumentLabelError);
      expect((erro as InvalidDocumentLabelError).status).toBe(400);
      if (typeof valor === 'string' && valor.trim().length > 0) {
        expect((erro as Error).message).not.toContain(valor);
      }
    },
  );

  it('o nome só com espaços na ponta conta o tamanho DEPOIS do trim (255 + espaços passa)', () => {
    expect(normalizeDocumentLabel(` ${'a'.repeat(255)} `)).toHaveLength(255);
  });
});
