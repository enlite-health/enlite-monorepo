import { renderNumberedOptions, parseNumberedReply } from '../numberedButtonOptions';
import { TemplateButton } from '../MessageTemplate';

describe('numberedButtonOptions', () => {
  const buttons: TemplateButton[] = [
    { label: 'Sí', payload: 'confirm_yes' },
    { label: 'No', payload: 'confirm_no' },
  ];

  describe('renderNumberedOptions (SSOT usado pelo outbound)', () => {
    it('numera os botões em ordem e adiciona instrução de resposta', () => {
      const rendered = renderNumberedOptions(buttons);
      expect(rendered).toBe('*1.* Sí\n*2.* No\n\n_Respondé con el número de la opción._');
    });
  });

  describe('parseNumberedReply (SSOT usado pelo inbound)', () => {
    it('mapeia "1" para o primeiro botão', () => {
      expect(parseNumberedReply('1', buttons)).toEqual(buttons[0]);
    });

    it('mapeia "2" para o segundo botão', () => {
      expect(parseNumberedReply('2', buttons)).toEqual(buttons[1]);
    });

    it('tolera espaços em volta do número', () => {
      expect(parseNumberedReply('  1  ', buttons)).toEqual(buttons[0]);
    });

    it('tolera ponto final', () => {
      expect(parseNumberedReply('1.', buttons)).toEqual(buttons[0]);
    });

    it('retorna null para número fora do range (maior que a quantidade de opções)', () => {
      expect(parseNumberedReply('10', buttons)).toBeNull();
    });

    it('retorna null para índice zero', () => {
      expect(parseNumberedReply('0', buttons)).toBeNull();
    });

    it('retorna null para índice negativo', () => {
      expect(parseNumberedReply('-1', buttons)).toBeNull();
    });

    it('retorna null para texto não-numérico', () => {
      expect(parseNumberedReply('hola', buttons)).toBeNull();
    });

    it('retorna null para texto misto (número + palavra)', () => {
      expect(parseNumberedReply('1 sí', buttons)).toBeNull();
    });

    it('retorna null se lista de botões vazia', () => {
      expect(parseNumberedReply('1', [])).toBeNull();
    });
  });
});
