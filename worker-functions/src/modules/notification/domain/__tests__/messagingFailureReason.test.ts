import { classifyMessagingFailureReason } from '../messagingFailureReason';

describe('classifyMessagingFailureReason', () => {
  it('nulo/vazio → UNKNOWN_ERROR', () => {
    expect(classifyMessagingFailureReason(null)).toBe('UNKNOWN_ERROR');
    expect(classifyMessagingFailureReason(undefined)).toBe('UNKNOWN_ERROR');
    expect(classifyMessagingFailureReason('')).toBe('UNKNOWN_ERROR');
  });

  it('"<provider> service not configured..." → PROVIDER_NOT_CONFIGURED', () => {
    expect(
      classifyMessagingFailureReason(
        'Twilio service not configured. Please set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_WHATSAPP_NUMBER environment variables.',
      ),
    ).toBe('PROVIDER_NOT_CONFIGURED');
    expect(
      classifyMessagingFailureReason(
        'Periskope service not configured. Please set PERISKOPE_API_KEY and PERISKOPE_PHONE environment variables.',
      ),
    ).toBe('PROVIDER_NOT_CONFIGURED');
  });

  it('"Invalid phone number: <telefone>" → INVALID_PHONE, e o telefone nunca aparece no código devolvido', () => {
    const raw = 'Invalid phone number: +5491155261243';
    const reason = classifyMessagingFailureReason(raw);
    expect(reason).toBe('INVALID_PHONE');
    expect(reason).not.toContain('+5491155261243');
  });

  it('"Template \'<slug>\' não encontrado ou inativo" → TEMPLATE_NOT_FOUND', () => {
    expect(classifyMessagingFailureReason("Template 'complete_register_ofc' não encontrado ou inativo")).toBe(
      'TEMPLATE_NOT_FOUND',
    );
  });

  it('"Unresolved PII tokens..." (guardUnresolvedTokens) → UNRESOLVED_TOKEN', () => {
    expect(
      classifyMessagingFailureReason(
        'Unresolved PII tokens in message variables (worker_name=tk_abc123). Caller must call TokenService.resolveVariables() before sendWhatsApp.',
      ),
    ).toBe('UNRESOLVED_TOKEN');
  });

  it('"Twilio error: <detalhe com telefone>" → PROVIDER_ERROR, sem vazar o detalhe', () => {
    const raw = "Twilio error: The 'To' number +5491155261243 is not a valid phone number.";
    const reason = classifyMessagingFailureReason(raw);
    expect(reason).toBe('PROVIDER_ERROR');
    expect(reason).not.toContain('+5491155261243');
  });

  it('"Periskope error: <detalhe> — {json com telefone}" → PROVIDER_ERROR, sem vazar o JSON', () => {
    const raw = 'Periskope error: Request failed with status code 400 — {"error":"invalid chat_id","to":"+5491155261243"}';
    const reason = classifyMessagingFailureReason(raw);
    expect(reason).toBe('PROVIDER_ERROR');
    expect(reason).not.toContain('+5491155261243');
    expect(reason).not.toContain('chat_id');
  });

  it('mensagem desconhecida (provider novo, formato mudou) → UNKNOWN_ERROR, nunca a string original', () => {
    const raw = 'Something totally unexpected happened with phone +5491155261243';
    const reason = classifyMessagingFailureReason(raw);
    expect(reason).toBe('UNKNOWN_ERROR');
    expect(reason).not.toContain('+5491155261243');
  });

  it('vocabulário fechado: todo retorno possível é um dos 6 códigos SCREAMING_SNAKE conhecidos', () => {
    const KNOWN = new Set([
      'PROVIDER_NOT_CONFIGURED', 'INVALID_PHONE', 'TEMPLATE_NOT_FOUND',
      'UNRESOLVED_TOKEN', 'PROVIDER_ERROR', 'UNKNOWN_ERROR',
    ]);
    const samples = [
      null, '', 'qualquer coisa', 'Twilio error: x', 'Periskope error: y',
      'Invalid phone number: 123', 'Template \'x\' não encontrado ou inativo',
    ];
    for (const s of samples) {
      expect(KNOWN.has(classifyMessagingFailureReason(s))).toBe(true);
    }
  });
});
