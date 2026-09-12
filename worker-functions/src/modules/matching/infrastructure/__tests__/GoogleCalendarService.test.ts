/**
 * GoogleCalendarService.test.ts
 *
 * Foco: PII guard em `addGuestToMeeting` (achado do lex, C1, 11/09) — os 4
 * pontos que logavam e-mail cru ou a mensagem crua da falha da API do Google:
 *   - :99  "Found event" — organizerEmail
 *   - :114 "Could not get organizer token" — organizerEmail
 *   - :123 "PATCH success: added" — normalized (o guestEmail passado por
 *     BookInterviewSlotUseCase)
 *   - :128 catch geral — `msg` do erro (pode ecoar o e-mail inválido que o
 *     Google rejeitou)
 *
 * Achado do gate, 2ª rodada (11/09) — os "irmãos" do C1 que ficaram fora da
 * 1ª cobertura, todos na mesma classe (e-mail cru saindo por log):
 *   - :169/:211 PATCH success de confirmAttendee/declineAttendee
 *   - :280 patchEventAttendees — corpo cru da resposta de erro do Google
 *   - :77  resolveDateTime — catch geral (linha tocada sem teste próprio)
 *
 * removeGuestFromMeeting segue coberto só pelo catch (it.each N1) — o
 * sucesso desse método não loga e-mail (linha 248), então não há PII ali.
 */

jest.mock('./../GoogleCalendarEventFinder', () => ({
  ...jest.requireActual('./../GoogleCalendarEventFinder'),
  getAccessToken: jest.fn(),
  findEventByMeetLink: jest.fn(),
}));

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({}) }) },
}));

import { GoogleCalendarService } from '../GoogleCalendarService';
import { getAccessToken, findEventByMeetLink } from '../GoogleCalendarEventFinder';
import { maskEmailForLog } from '@shared/utils/emailMask';

const mockGetAccessToken = getAccessToken as jest.Mock;
const mockFindEvent = findEventByMeetLink as jest.Mock;

const MEET_LINK = 'https://meet.google.com/abc-defg-hij';
const GUEST_EMAIL = 'candidata.sensivel@example.com';
const ORGANIZER_EMAIL = 'recrutadora.sensivel@enlite.health';

function foundEvent(overrides: Partial<{ organizerEmail: string | undefined; attendees: unknown[] }> = {}) {
  return {
    event: {
      id: 'evt-1',
      attendees: overrides.attendees ?? [],
      organizer: overrides.organizerEmail === undefined ? { email: ORGANIZER_EMAIL } : { email: overrides.organizerEmail },
    },
    calendarId: 'cal-1',
  };
}

describe('GoogleCalendarService.addGuestToMeeting — PII guard (C1, 11/09)', () => {
  let service: GoogleCalendarService;
  let logSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new GoogleCalendarService();
    logSpy = jest.spyOn(console, 'log').mockImplementation();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation();
    mockGetAccessToken.mockResolvedValue('token-abc');
  });

  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    jest.restoreAllMocks();
  });

  it(':99 — "Found event": organizerEmail mascarado, nunca cru', async () => {
    mockFindEvent.mockResolvedValue(foundEvent());
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, text: async () => '' } as Response);

    await service.addGuestToMeeting(MEET_LINK, GUEST_EMAIL);

    const lines = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(lines).not.toContain(ORGANIZER_EMAIL);
    expect(lines).toContain(`organizer=${maskEmailForLog(ORGANIZER_EMAIL)}`);
  });

  it(':114 — "Could not get organizer token": organizerEmail mascarado, nunca cru', async () => {
    mockFindEvent.mockResolvedValue(foundEvent());
    // 1ª chamada (impersonate) já veio do beforeEach; 2ª chamada (organizer) falha.
    mockGetAccessToken.mockResolvedValueOnce('token-abc').mockResolvedValueOnce(null);
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, text: async () => '' } as Response);

    await service.addGuestToMeeting(MEET_LINK, GUEST_EMAIL);

    const lines = warnSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(lines).not.toContain(ORGANIZER_EMAIL);
    expect(lines).toContain(`Could not get organizer token for ${maskEmailForLog(ORGANIZER_EMAIL)}`);
  });

  it(':123 — "PATCH success: added": e-mail do convidado mascarado, nunca cru', async () => {
    mockFindEvent.mockResolvedValue(foundEvent());
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, text: async () => '' } as Response);

    await service.addGuestToMeeting(MEET_LINK, GUEST_EMAIL);

    const lines = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(lines).not.toContain(GUEST_EMAIL.toLowerCase());
    expect(lines).toContain(`PATCH success: added ${maskEmailForLog(GUEST_EMAIL)}`);
  });

  it(':128 — catch geral: só status/código do erro, nunca a message crua da API', async () => {
    mockFindEvent.mockResolvedValue(foundEvent());
    const sensitiveMessage = `Invalid email: ${GUEST_EMAIL}`;
    fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(Object.assign(new Error(sensitiveMessage), { code: 'EINVAL' }));

    const result = await service.addGuestToMeeting(MEET_LINK, GUEST_EMAIL);

    expect(result).toMatchObject({ success: false, reason: 'api_error' });
    const lines = warnSpy.mock.calls.map((c) => JSON.stringify(c)).join('\n');
    expect(lines).not.toContain(GUEST_EMAIL);
    expect(lines).not.toContain(sensitiveMessage);
    // safeErrorFields: errorName + code — o suficiente pra diagnosticar sem o valor.
    expect(lines).toContain('"errorName":"Error"');
    expect(lines).toContain('"code":"EINVAL"');
    // N1 (lex, 11/09): o log ficou seguro mas o valor saía pelo RETORNO — o
    // chamador (BookInterviewSlotUseCase) imprime `detail`. Agora `detail` leva
    // só errorName + código.
    expect(JSON.stringify(result)).not.toContain(GUEST_EMAIL);
    expect(JSON.stringify(result)).not.toContain(sensitiveMessage);
    expect(result).toMatchObject({ detail: 'Error EINVAL' });
  });

  // N1 (lex, 11/09) — a MESMA classe nos outros 3 catches do arquivo: cada um
  // logava a message crua E a devolvia em `detail`.
  it.each([
    ['confirmAttendee', (svc: GoogleCalendarService) => svc.confirmAttendee(MEET_LINK, GUEST_EMAIL)],
    ['declineAttendee', (svc: GoogleCalendarService) => svc.declineAttendee(MEET_LINK, GUEST_EMAIL)],
    ['removeGuestFromMeeting', (svc: GoogleCalendarService) => svc.removeGuestFromMeeting(MEET_LINK, GUEST_EMAIL)],
  ])('N1 — %s: nem o log nem o detail levam a message crua', async (_nome, chamar) => {
    mockFindEvent.mockResolvedValue(foundEvent({ attendees: [{ email: GUEST_EMAIL.toLowerCase() }] }));
    const sensitiveMessage = `Invalid email: ${GUEST_EMAIL}`;
    fetchSpy = jest.spyOn(global, 'fetch').mockRejectedValue(Object.assign(new Error(sensitiveMessage), { code: 'EINVAL' }));

    const result = await chamar(service);

    const lines = warnSpy.mock.calls.map((c) => JSON.stringify(c)).join('\n');
    expect(lines).not.toContain(GUEST_EMAIL);
    expect(lines).not.toContain(sensitiveMessage);
    expect(JSON.stringify(result)).not.toContain(GUEST_EMAIL);
    expect(JSON.stringify(result)).not.toContain(sensitiveMessage);
    expect(JSON.stringify(result)).toContain('Error EINVAL');
  });

  // ── :169/:211 — PATCH success (confirmAttendee/declineAttendee) ─────────────
  // MESMA classe do :123, mas o it.each de N1 (linha 128) só cobre o `catch`
  // (mockRejectedValue): nunca passa pelo `if (result.ok)` que loga o e-mail.
  // Achado do gate 11/09 — :169/:211 logavam `normalized` cru e não tinham
  // NENHUMA cobertura própria (nem verde, nem vermelha).
  it.each([
    ['confirmAttendee', 'confirmed', (svc: GoogleCalendarService) => svc.confirmAttendee(MEET_LINK, GUEST_EMAIL)],
    ['declineAttendee', 'declined', (svc: GoogleCalendarService) => svc.declineAttendee(MEET_LINK, GUEST_EMAIL)],
  ])(':169/:211 — %s: PATCH success loga e-mail mascarado, nunca cru', async (_nome, verbo, chamar) => {
    mockFindEvent.mockResolvedValue(foundEvent({ attendees: [{ email: GUEST_EMAIL.toLowerCase() }] }));
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, text: async () => '' } as Response);

    const result = await chamar(service);

    expect(result).toEqual({ success: true });
    const lines = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(lines).not.toContain(GUEST_EMAIL.toLowerCase());
    expect(lines).toContain(`PATCH success: ${verbo} ${maskEmailForLog(GUEST_EMAIL)} on event evt-1`);
  });

  // ── :280 — patchEventAttendees: corpo de erro cru ────────────────────────────
  // O corpo de erro do Google ecoa o payload rejeitado (`attendees`, e-mails
  // incluídos). `fetch` não lança em 4xx/5xx — o `catch` dos métodos públicos
  // NUNCA vê essa resposta, então mascarar só o catch (:129 etc.) não fecha o
  // achado; o ponto de fuga é este `console.warn` dentro do próprio PATCH.
  it(':280 — PATCH error: nunca loga o corpo cru da resposta (pode ecoar e-mail)', async () => {
    mockFindEvent.mockResolvedValue(foundEvent());
    const corpoComEmail = JSON.stringify({ error: { message: 'Invalid attendee' }, attendees: [{ email: GUEST_EMAIL }] });
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 400, text: async () => corpoComEmail } as Response);

    const result = await service.addGuestToMeeting(MEET_LINK, GUEST_EMAIL);

    expect(result).toMatchObject({ success: false, reason: 'api_error', detail: 'HTTP 400' });
    const lines = warnSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(lines).not.toContain(GUEST_EMAIL);
    expect(lines).not.toContain(corpoComEmail);
    expect(lines).toContain('PATCH error 400');
    expect(lines).toContain(`body length=${corpoComEmail.length}`);
  });

  // ── :77 — resolveDateTime catch ──────────────────────────────────────────────
  // Critério 3 do gate: linha tocada pelo diff (dentro de 59-78) sem cobertura
  // própria — nenhum teste forçava este catch a executar.
  it(':77 — resolveDateTime: erro no meio da busca não vaza message/stack', async () => {
    const sensitiveMessage = `token inválido para ${ORGANIZER_EMAIL}`;
    mockGetAccessToken.mockRejectedValueOnce(Object.assign(new Error(sensitiveMessage), { code: 'EAUTH' }));

    const result = await service.resolveDateTime(MEET_LINK);

    expect(result).toBeNull();
    const lines = warnSpy.mock.calls.map((c) => JSON.stringify(c)).join('\n');
    expect(lines).not.toContain(sensitiveMessage);
    expect(lines).not.toContain(ORGANIZER_EMAIL);
    expect(lines).toContain('"errorName":"Error"');
    expect(lines).toContain('"code":"EAUTH"');
  });

  // ── Nota (critério do gate, item 3) ──────────────────────────────────────────
  // Havia aqui um it("sabotagem") que apenas IMPRIMIA o formato antigo
  // (`console.log(...email cru...)`) e verificava que a própria string impressa
  // continha e-mail — não exercitava nenhum código de produção, então
  // permanecia verde com o defeito real reintroduzido (decorativo). O teste
  // ':123' logo acima já É o mutation-kill de verdade: ele lê o log que a
  // PRODUÇÃO gerou e falha tanto se o e-mail cru aparecer (`not.toContain`)
  // quanto se o formato mascarado sumir (`toContain`) — cobre os dois lados sem
  // precisar reproduzir o bug "à parte". Removido em vez de mantido morto.
});
