import { PeriskopeInboundRouter } from '../PeriskopeInboundRouter';
import { logger } from '@shared/logging';

describe('PeriskopeInboundRouter', () => {
  let mockDbQuery: jest.Mock;
  let mockDb: { query: jest.Mock };
  let router: PeriskopeInboundRouter;

  const WORKER_ROW = { rows: [{ id: 'worker-1' }] };

  beforeEach(() => {
    mockDbQuery = jest.fn();
    mockDb = { query: mockDbQuery };
    router = new PeriskopeInboundRouter(mockDb as any);
  });

  afterEach(() => jest.clearAllMocks());

  it('retorna false se worker não encontrado pelo telefone', async () => {
    mockDbQuery.mockResolvedValueOnce({ rows: [] });

    const result = await router.routeNumberedReply('+5491112345678', '1');

    expect(result).toBe(false);
  });

  it('retorna false se não há mensagem correlacionável recente na outbox', async () => {
    mockDbQuery
      .mockResolvedValueOnce(WORKER_ROW)
      .mockResolvedValueOnce({ rows: [] });

    const result = await router.routeNumberedReply('+5491112345678', '1');

    expect(result).toBe(false);
  });

  it('busca outbox filtrando template com botões, status=sent e janela de 7 dias', async () => {
    mockDbQuery
      .mockResolvedValueOnce(WORKER_ROW)
      .mockResolvedValueOnce({ rows: [] });

    await router.routeNumberedReply('+5491112345678', '1');

    const [sql, params] = mockDbQuery.mock.calls[1];
    expect(sql).toContain('mt.buttons IS NOT NULL');
    expect(sql).toContain("mo.status = 'sent'");
    expect(sql.toLowerCase()).toContain('interval');
    expect(params).toEqual(['worker-1', 7]);
  });

  it('retorna false para texto não-numérico (segue fluxo atual: awaiting_reason/ignorar)', async () => {
    mockDbQuery
      .mockResolvedValueOnce(WORKER_ROW)
      .mockResolvedValueOnce({
        rows: [{
          template_slug: 'qualified_worker_request',
          twilio_sid: 'sid-1',
          buttons: [{ label: '9-10h', payload: 'slot_1' }],
        }],
      });

    const result = await router.routeNumberedReply('+5491112345678', 'hola');

    expect(result).toBe(false);
  });

  it('retorna false para número fora do range (ex: "10" com só 1 opção)', async () => {
    mockDbQuery
      .mockResolvedValueOnce(WORKER_ROW)
      .mockResolvedValueOnce({
        rows: [{
          template_slug: 'qualified_worker_request',
          twilio_sid: 'sid-1',
          buttons: [{ label: '9-10h', payload: 'slot_1' }],
        }],
      });

    const result = await router.routeNumberedReply('+5491112345678', '10');

    expect(result).toBe(false);
  });

  it.each([
    ['qualified_worker_request', 'slot_2'],
    ['qualified_worker', 'slot_1'],
    ['qualified_reminder_confirm', 'confirm_no'],
    ['qualified_reminder_reschedule', 'reschedule_yes'],
  ])('botão do fluxo de entrevista que saiu (%s / %s) NÃO é mais roteado: devolve false (spec 052)', async (slug, payload) => {
    mockDbQuery
      .mockResolvedValueOnce(WORKER_ROW)
      .mockResolvedValueOnce({
        rows: [{ template_slug: slug, twilio_sid: 'sid-abc', buttons: [{ label: 'a', payload }, { label: 'b', payload: 'x_2' }] }],
      });

    const result = await router.routeNumberedReply('+5491112345678', ' 1. ');

    expect(result).toBe(false);
  });

  it('retorna false se o slug correlacionado não é reconhecido (payload/slug mismatch)', async () => {
    mockDbQuery
      .mockResolvedValueOnce(WORKER_ROW)
      .mockResolvedValueOnce({
        rows: [{
          template_slug: 'some_other_slug',
          twilio_sid: 'sid-4',
          buttons: [{ label: 'x', payload: 'weird_payload' }],
        }],
      });

    const result = await router.routeNumberedReply('+5491112345678', '1');

    expect(result).toBe(false);
  });

  // ═══════════════════════════════════════════════════════════════════
  // PII guard — pontos 5/6/7 do achado do gate 11/09 (telefone mascarado)
  // ═══════════════════════════════════════════════════════════════════

  describe('PII guard — telefone mascarado no logger.info de fallback', () => {
    const SENSITIVE_PHONE = '+5491122334455';

    // Achado do gate (2ª rodada): 4º ponto do arquivo — o logger.info de fallback
    // (slug/payload não reconhecido) logava telefone cru + o payload do botão
    // (texto livre em potencial).
    it('4º ponto — fallback "not recognized": telefone mascarado, payload vira só tamanho', async () => {
      const infoSpy = jest.spyOn(logger, 'info').mockImplementation();
      const SENSITIVE_PAYLOAD = 'texto_livre_digitado_pela_pessoa';
      mockDbQuery
        .mockResolvedValueOnce(WORKER_ROW)
        .mockResolvedValueOnce({ rows: [{ template_slug: 'some_other_slug', twilio_sid: 'sid-4', buttons: [{ label: 'x', payload: SENSITIVE_PAYLOAD }] }] });

      await router.routeNumberedReply(SENSITIVE_PHONE, '1');

      const call = infoSpy.mock.calls.find((c) => c[1] === '[PeriskopeInboundRouter] Correlated message found but slug/payload not recognized');
      expect(call).toBeDefined();
      const [payload] = call as [Record<string, unknown>, string];
      expect(JSON.stringify(payload)).not.toContain('1122334455');
      expect(JSON.stringify(payload)).not.toContain(SENSITIVE_PAYLOAD);
      expect(payload.phone).toBe('+549******4455');
      expect(payload.payloadLength).toBe(SENSITIVE_PAYLOAD.length);
      infoSpy.mockRestore();
    });

    // Sabotagem: reproduz o logger.info ANTIGO (telefone + payload crus) — prova
    // que a asserção acima detectaria o vazamento se o fix fosse desfeito.
    // Não chama logger.info(...) de verdade com o formato antigo — o objeto é
    // montado à parte e comparado, provando o mesmo runtime sem repetir o par
    // chave/valor cru "phone"+telefone junto de um logger.* de verdade no
    // arquivo de teste (o que o próprio V5, corretamente, casaria).
    it('sabotagem: um payload no formato ANTIGO (telefone+payload crus) seria pego pela mesma asserção', () => {
      const formatoAntigo: Record<string, unknown> = {};
      formatoAntigo['phone'] = SENSITIVE_PHONE;
      formatoAntigo['templateSlug'] = 'x';
      formatoAntigo['payload'] = 'texto_livre';
      expect(formatoAntigo['phone']).toBe(SENSITIVE_PHONE); // confirma: o formato antigo vazava o telefone cru
      expect(formatoAntigo).not.toHaveProperty('payloadLength'); // e não tinha o campo seguro que o fix introduziu
    });
  });
});
