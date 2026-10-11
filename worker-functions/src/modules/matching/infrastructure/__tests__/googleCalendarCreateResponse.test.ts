/**
 * spec 050 F9 (R-34): resposta do events.insert com id fixo. A doc do Google não diz o que a API responde a um id
 * repetido, então o 409 é resolvido LENDO o evento por id. `fetch` interceptado; nada sai da máquina.
 */
import { readCreatedEvent } from '../googleCalendarCreateResponse';

const CTX = { calendarId: 'cal@example.test', eventId: 'abcde12345', token: 't' };
const LINK = 'https://meet.google.com/abc-defg-hij';

function resp(status: number, body: unknown = {}): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

describe('readCreatedEvent', () => {
  beforeEach(() => {
    global.fetch = jest.fn();
  });

  it('200 → id e link', async () => {
    await expect(readCreatedEvent(resp(200, { id: 'e1', hangoutLink: LINK }), CTX)).resolves.toEqual({ eventId: 'e1', meetLink: LINK });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('200 sem link → devolve link vazio (quem chama trata como falha, R-35)', async () => {
    await expect(readCreatedEvent(resp(200, { id: 'e1' }), CTX)).resolves.toEqual({ eventId: 'e1', meetLink: '' });
  });

  it('409 com id fixo → lê o evento por id e devolve o que já existe (não duplica)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(resp(200, { id: CTX.eventId, hangoutLink: LINK, status: 'confirmed' }));
    await expect(readCreatedEvent(resp(409), CTX)).resolves.toEqual({ eventId: CTX.eventId, meetLink: LINK });
    const [url] = (global.fetch as jest.Mock).mock.calls[0] as [string];
    expect(url).toContain(`/events/${CTX.eventId}`);
  });

  it('409 e o evento lido está cancelado → erro (um id apagado não vale)', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(resp(200, { id: CTX.eventId, status: 'cancelled' }));
    await expect(readCreatedEvent(resp(409), CTX)).rejects.toThrow(/createEvent 409/);
  });

  it('409 e a leitura falha → erro com o status original', async () => {
    (global.fetch as jest.Mock).mockResolvedValue(resp(404));
    await expect(readCreatedEvent(resp(409), CTX)).rejects.toThrow(/createEvent 409/);
  });

  it('409 SEM id fixo → erro, sem leitura', async () => {
    await expect(readCreatedEvent(resp(409), { ...CTX, eventId: undefined })).rejects.toThrow(/createEvent 409/);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('outro erro HTTP → erro com status e agenda', async () => {
    await expect(readCreatedEvent(resp(500, { error: 'x' }), CTX)).rejects.toThrow(/createEvent 500 on cal@example.test/);
  });
});
