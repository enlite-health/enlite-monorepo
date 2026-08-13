import { matchesOptOut, normalizeForOptOut, OPT_OUT_BUTTON_PAYLOAD } from '../optOutMatch';

describe('optOutMatch', () => {
  describe('normalizeForOptOut', () => {
    it('minúsculo, sem acento, espaços colapsados', () => {
      expect(normalizeForOptOut('  No  Recibir  MÁS ')).toBe('no recibir mas');
      expect(normalizeForOptOut('Número')).toBe('numero');
    });
  });

  describe('matchesOptOut — EXACT (body inteiro é o termo)', () => {
    it.each([
      'baja', 'BAJA', ' Salir ', 'parar', 'STOP', 'cancelar', 'basta',
      'no quiero', 'unsubscribe', 'opt-out', 'no molestar', 'chau',
    ])('casa "%s"', (body) => {
      expect(matchesOptOut(body)).toBe(true);
    });
  });

  describe('matchesOptOut — CONTAINS (frase inequívoca em qualquer lugar)', () => {
    it.each([
      'Hola, quiero darme de baja por favor',
      'ya no quiero recibir mensajes',
      'por favor no me escriban mas',
      'dejen de enviar mensajes',
      'quiero que borren mi numero de la lista', // verbo-agnóstico via "mi numero de la lista"
      'sacame de la lista',
    ])('casa frase "%s"', (body) => {
      expect(matchesOptOut(body)).toBe(true);
    });

    it('normaliza acento na frase (más → mas)', () => {
      expect(matchesOptOut('ya no quiero recibir más nada')).toBe(true);
    });
  });

  describe('matchesOptOut — NEGATIVOS (não pode calar quem quer falar)', () => {
    it.each([
      '',
      '   ',
      'hola',
      'gracias!',
      'si quiero la vacante',
      'no quiero perder la vacante',       // contém "no quiero" mas NÃO é baixa
      'necesito ayuda con mi baja medica', // "baja" no meio, contexto médico
      'cuando es la entrevista?',
      'dale, confirmo',
    ])('NÃO casa "%s"', (body) => {
      expect(matchesOptOut(body)).toBe(false);
    });
  });

  it('expõe o payload do botão de opt-out', () => {
    expect(OPT_OUT_BUTTON_PAYLOAD).toBe('optout');
  });
});
