/**
 * O que estes testes travam é um defeito que existia em produção e era INVISÍVEL:
 * `paused` e `disabled` não estavam no union, o payload entrava por `as
 * WhatsAppApproval` (cast, não validação), e uma mensagem que a Meta desligasse
 * por denúncia de spam falhava no `=== 'approved'` do sync e sumia da base sem
 * nada ficar vermelho.
 *
 * Cada teste abaixo falha se alguém reverter uma dessas três coisas.
 */
import { parseWhatsAppApproval, WHATSAPP_APPROVAL_STATUSES } from '../twilio-client';

describe('parseWhatsAppApproval', () => {
  describe('os estados de desligamento, que faltavam', () => {
    it.each(['paused', 'disabled'])('reconhece %s em vez de tratá-lo como desconhecido', (status) => {
      const { approval, unknownStatus } = parseWhatsAppApproval({ status });
      expect(approval?.status).toBe(status);
      expect(unknownStatus).toBeNull();
    });

    it('paused NÃO é approved — é o que faz o sync não o guardar como no ar', () => {
      const { approval } = parseWhatsAppApproval({ status: 'paused' });
      expect(approval?.status).not.toBe('approved');
    });
  });

  describe('estado que a Meta invente amanhã', () => {
    it('preserva o valor em vez de descartar', () => {
      const { approval, unknownStatus } = parseWhatsAppApproval({ status: 'in_appeal' });
      expect(unknownStatus).toBe('in_appeal');
      expect(approval?.status).toBe('in_appeal');
    });

    it('não vira approved por engano', () => {
      const { approval } = parseWhatsAppApproval({ status: 'algo_novo' });
      expect(approval?.status).not.toBe('approved');
    });
  });

  describe('validação, não cast', () => {
    it.each([
      ['null', null],
      ['string', 'approved'],
      ['número', 42],
      ['objeto sem status', { category: 'UTILITY' }],
      ['status não-string', { status: 7 }],
      ['status vazio', { status: '' }],
    ])('devolve null para %s — "não sei" e não "não aprovado"', (_label, raw) => {
      expect(parseWhatsAppApproval(raw).approval).toBeNull();
    });
  });

  describe('rejection_reason', () => {
    it('é lido — a Twilio devolve e nós ignorávamos', () => {
      const { approval } = parseWhatsAppApproval({ status: 'rejected', rejection_reason: 'INVALID_FORMAT' });
      expect(approval?.rejection_reason).toBe('INVALID_FORMAT');
    });

    it('string vazia vira undefined, não string vazia na tela', () => {
      const { approval } = parseWhatsAppApproval({ status: 'approved', rejection_reason: '' });
      expect(approval?.rejection_reason).toBeUndefined();
    });
  });

  it('normaliza caixa — a Meta escreve em maiúsculas, a Twilio em minúsculas', () => {
    expect(parseWhatsAppApproval({ status: 'APPROVED' }).approval?.status).toBe('approved');
  });

  it('o conjunto de estados conhecidos tem os 7', () => {
    expect([...WHATSAPP_APPROVAL_STATUSES].sort()).toEqual(
      ['approved', 'disabled', 'paused', 'pending', 'received', 'rejected', 'unsubmitted'].sort(),
    );
  });
});
