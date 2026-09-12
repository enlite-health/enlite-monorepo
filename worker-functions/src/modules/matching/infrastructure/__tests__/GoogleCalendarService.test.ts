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
 * Não cobre confirmAttendee/declineAttendee/removeGuestFromMeeting nem o
 * restante do arquivo — fora do escopo deste achado.
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
import { redactContact } from '@shared/logging';

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
    expect(lines).toContain(`organizer=${redactContact(ORGANIZER_EMAIL, 'email')}`);
  });

  it(':114 — "Could not get organizer token": organizerEmail mascarado, nunca cru', async () => {
    mockFindEvent.mockResolvedValue(foundEvent());
    // 1ª chamada (impersonate) já veio do beforeEach; 2ª chamada (organizer) falha.
    mockGetAccessToken.mockResolvedValueOnce('token-abc').mockResolvedValueOnce(null);
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, text: async () => '' } as Response);

    await service.addGuestToMeeting(MEET_LINK, GUEST_EMAIL);

    const lines = warnSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(lines).not.toContain(ORGANIZER_EMAIL);
    expect(lines).toContain(`Could not get organizer token for ${redactContact(ORGANIZER_EMAIL, 'email')}`);
  });

  it(':123 — "PATCH success: added": e-mail do convidado mascarado, nunca cru', async () => {
    mockFindEvent.mockResolvedValue(foundEvent());
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({ ok: true, status: 200, text: async () => '' } as Response);

    await service.addGuestToMeeting(MEET_LINK, GUEST_EMAIL);

    const lines = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(lines).not.toContain(GUEST_EMAIL.toLowerCase());
    expect(lines).toContain(`PATCH success: added ${redactContact(GUEST_EMAIL, 'email')}`);
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

  // ── Sabotagem (evidência) ────────────────────────────────────────────────────
  // Reproduz o console.log ANTIGO (e-mail cru) — prova que a asserção do :123
  // detectaria o vazamento se o fix fosse desfeito.
  it('sabotagem: reproduzindo o console.log ANTIGO (e-mail cru) em :123, a asserção acima cairia', () => {
    console.log(`[GoogleCalendarService] PATCH success: added ${GUEST_EMAIL.toLowerCase()} to event evt-1 (via ${ORGANIZER_EMAIL})`);
    const oldLines = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(oldLines).toContain(GUEST_EMAIL.toLowerCase()); // confirma: o formato antigo vazava
  });
});
