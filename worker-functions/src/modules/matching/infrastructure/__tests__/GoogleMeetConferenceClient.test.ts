/**
 * GoogleMeetConferenceClient (spec 049 F5): a trava de teste e o mapeamento de erro. `requestDwdAccessToken` e `fetch` são
 * substituídos — nenhuma chamada ao Google.
 */
import { AdmissionRealAdapterInTestError } from '../../application/ports/AdmissionMessagingPorts';
import { MeetScopeMissingError, MeetTransientError } from '../../application/ports/MeetConferencePort';
import { createAdmissionExternals } from '../admissionExternals';
import { FakeMeetConference } from '../doubles/FakeMeetConference';
import { GoogleMeetConferenceClient } from '../GoogleMeetConferenceClient';
import * as finder from '../GoogleCalendarEventFinder';

const realWhatsApp = jest.fn(() => ({ sendWithContentSid: jest.fn() }));
const PROD = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;

describe('trava de teste do Meet', () => {
  it('new GoogleMeetConferenceClient() com NODE_ENV=test LANÇA (teste nunca toca o Google)', () => {
    expect(process.env.NODE_ENV).toBe('test');
    expect(() => new GoogleMeetConferenceClient()).toThrow(AdmissionRealAdapterInTestError);
    expect(() => new GoogleMeetConferenceClient({ NODE_ENV: 'test' })).toThrow(/NODE_ENV=test/);
  });

  it('a fábrica em NODE_ENV=test NÃO lança no boot e entrega o DUBLÊ; test + real LANÇA; produção constrói o REAL', () => {
    expect(createAdmissionExternals({ NODE_ENV: 'test' }, { realWhatsApp }).meet).toBeInstanceOf(FakeMeetConference);
    expect(() => createAdmissionExternals({ NODE_ENV: 'test', ADMISSION_EXTERNALS: 'real' }, { realWhatsApp })).toThrow(AdmissionRealAdapterInTestError);
    const ext = createAdmissionExternals({ NODE_ENV: 'production' }, { realWhatsApp, realReminderTasks: () => ({ schedule: jest.fn(), cancel: jest.fn() }) as never });
    expect(ext.meet).toBeInstanceOf(GoogleMeetConferenceClient);
  });
});

describe('GoogleMeetConferenceClient (produção simulada)', () => {
  const realFetch = global.fetch;
  let tokenSpy: jest.SpyInstance;
  beforeEach(() => {
    tokenSpy = jest.spyOn(finder, 'requestDwdAccessToken').mockResolvedValue({ token: 'meet-token' });
  });
  afterEach(() => {
    global.fetch = realFetch;
    tokenSpy.mockRestore();
  });
  const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body }) as Response;

  it('pede o token só com o escopo do Meet, impersonando o responsável', async () => {
    global.fetch = jest.fn(async () => json(200, { name: 'spaces/abc123' })) as unknown as typeof fetch;
    await expect(new GoogleMeetConferenceClient(PROD).resolveSpace('abc-defg-hij', 'host@example.test')).resolves.toEqual({ spaceName: 'spaces/abc123' });
    expect(tokenSpy).toHaveBeenCalledWith('host@example.test', 'host@example.test', finder.MEET_SCOPE);
  });

  it('unauthorized_client na troca do token → MeetScopeMissingError (H2); token indisponível → transitório', async () => {
    global.fetch = jest.fn() as unknown as typeof fetch;
    tokenSpy.mockResolvedValueOnce({ error: 'unauthorized_client' });
    await expect(new GoogleMeetConferenceClient(PROD).resolveSpace('abc-defg-hij', 'h@example.test')).rejects.toBeInstanceOf(MeetScopeMissingError);
    tokenSpy.mockResolvedValueOnce({ error: 'unavailable' });
    await expect(new GoogleMeetConferenceClient(PROD).resolveSpace('abc-defg-hij', 'h@example.test')).rejects.toBeInstanceOf(MeetTransientError);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('HTTP 403 → MeetScopeMissingError; 500 e 404 → transitório (não provam nada sobre a reunião)', async () => {
    const client = new GoogleMeetConferenceClient(PROD);
    for (const [status, err] of [[403, MeetScopeMissingError], [500, MeetTransientError], [404, MeetTransientError]] as const) {
      global.fetch = jest.fn(async () => json(status, {})) as unknown as typeof fetch;
      await expect(client.listConferenceRecords('spaces/abc', 'h@example.test')).rejects.toBeInstanceOf(err);
    }
  });

  it('lista com paginação: junta as páginas; endTime ausente → null (conferência aberta); teto de páginas → transitório, nunca lista incompleta', async () => {
    const pages = [
      { conferenceRecords: [{ name: 'conferenceRecords/a', startTime: '2026-10-09T15:00:00Z', endTime: '2026-10-09T15:10:00Z' }], nextPageToken: 'p2' },
      { conferenceRecords: [{ name: 'conferenceRecords/b', startTime: '2026-10-09T15:14:00Z' }] },
    ];
    let i = 0;
    global.fetch = jest.fn(async () => json(200, pages[i++])) as unknown as typeof fetch;
    const out = await new GoogleMeetConferenceClient(PROD).listConferenceRecords('spaces/abc', 'h@example.test');
    expect(out.map((r) => [r.name, r.endTime?.toISOString() ?? null])).toEqual([
      ['conferenceRecords/a', '2026-10-09T15:10:00.000Z'],
      ['conferenceRecords/b', null],
    ]);

    global.fetch = jest.fn(async () => json(200, { conferenceRecords: [], nextPageToken: 'sempre' })) as unknown as typeof fetch;
    await expect(new GoogleMeetConferenceClient(PROD).listConferenceRecords('spaces/abc', 'h@example.test')).rejects.toBeInstanceOf(MeetTransientError);
  });
});
