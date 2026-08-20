/**
 * AdmissionCalendarService.io.test.ts
 *
 * A parte que fala com o Google: leitura de ocupação por `freeBusy` (D1) e o
 * CORPO do evento criado (D3/D4). O `fetch` é interceptado para que o teste
 * afirme o que sai daqui — é a única camada onde dá para provar que a
 * identidade da atendente não vaza para o paciente e que a leitura é mesmo a
 * mínima (freeBusy, não events.list).
 */

jest.mock('../GoogleCalendarEventFinder', () => ({
  getAccessToken: jest.fn(async () => 'fake-token'),
}));

import { DateTime } from 'luxon';
import { getAccessToken } from '../GoogleCalendarEventFinder';
import {
  AdmissionCalendarService,
  AR_ZONE,
  sumBusyMinutesInWeek,
  BusyInterval,
} from '../AdmissionCalendarService';

const HOST_A = 'ana@enlite.health';
const HOST_B = 'mari@enlite.health';
const CAL_AR = 'admission-ar@group.calendar.google.com';
const IMPERSONATE = 'enlite@enlite.health';

const FROM = '2026-08-03T00:00:00-03:00';
const TO = '2026-08-08T00:00:00-03:00';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** Resposta de erro cujo corpo NÃO pode ser lido (rede caiu no meio). */
function unreadableErrorResponse(status: number): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => {
      throw new Error('stream interrompido');
    },
  } as unknown as Response;
}

/** Última chamada ao fetch: url + corpo já parseado. */
function lastCall(): { url: string; init: RequestInit; body: Record<string, unknown> } {
  const calls = (global.fetch as jest.Mock).mock.calls;
  const [url, init] = calls[calls.length - 1] as [string, RequestInit];
  return { url, init, body: init?.body ? JSON.parse(init.body as string) : {} };
}

describe('AdmissionCalendarService — I/O', () => {
  let service: AdmissionCalendarService;

  beforeEach(() => {
    jest.clearAllMocks();
    (getAccessToken as jest.Mock).mockResolvedValue('fake-token');
    global.fetch = jest.fn();
    service = new AdmissionCalendarService();
  });

  describe('getFreeBusyByCalendar', () => {
    it('lê N agendas numa única requisição POST /freeBusy', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        jsonResponse({
          calendars: {
            [HOST_A]: { busy: [{ start: '2026-08-03T13:00:00Z', end: '2026-08-03T14:00:00Z' }] },
            [HOST_B]: { busy: [] },
          },
        }),
      );

      const out = await service.getFreeBusyByCalendar([HOST_A, HOST_B], IMPERSONATE, FROM, TO);

      // Uma chamada só, para o endpoint de freeBusy — não events.list.
      expect(global.fetch).toHaveBeenCalledTimes(1);
      const { url, init, body } = lastCall();
      expect(url).toBe('https://www.googleapis.com/calendar/v3/freeBusy');
      expect(init.method).toBe('POST');
      expect(body.items).toEqual([{ id: HOST_A }, { id: HOST_B }]);
      expect(body.timeMin).toBe(FROM);
      expect(body.timeMax).toBe(TO);

      expect(out).toHaveLength(2);
      expect(out[0].calendarId).toBe(HOST_A);
      expect(out[0].error).toBeUndefined();
      expect(out[0].busy).toHaveLength(1);
      expect(out[0].busy[0].start.toISOString()).toBe('2026-08-03T13:00:00.000Z');
      expect(out[1].busy).toEqual([]);
    });

    it('impersona quem o chamador mandou', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ calendars: {} }));
      await service.getFreeBusyByCalendar([HOST_A], IMPERSONATE, FROM, TO);
      expect(getAccessToken).toHaveBeenCalledWith(IMPERSONATE, IMPERSONATE);
    });

    it('erro em UMA agenda não contamina as outras (e não vira "livre")', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        jsonResponse({
          calendars: {
            [HOST_A]: { errors: [{ domain: 'global', reason: 'notFound' }] },
            [HOST_B]: { busy: [{ start: '2026-08-03T13:00:00Z', end: '2026-08-03T14:00:00Z' }] },
          },
        }),
      );

      const out = await service.getFreeBusyByCalendar([HOST_A, HOST_B], IMPERSONATE, FROM, TO);

      expect(out[0]).toMatchObject({ calendarId: HOST_A, busy: [], error: 'notFound' });
      expect(out[1].error).toBeUndefined();
      expect(out[1].busy).toHaveLength(1);
    });

    it('erro sem "reason" vira "unknown" em vez de string vazia', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        jsonResponse({ calendars: { [HOST_A]: { errors: [{ domain: 'global' }] } } }),
      );
      const out = await service.getFreeBusyByCalendar([HOST_A], IMPERSONATE, FROM, TO);
      expect(out[0].error).toBe('unknown');
    });

    it('sem timezone explícito usa a zona AR', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ calendars: {} }));
      await service.getFreeBusyByCalendar([HOST_A], IMPERSONATE, FROM, TO);
      expect(lastCall().body.timeZone).toBe(AR_ZONE);
    });

    it('agenda presente e totalmente livre (sem "busy" na resposta) → lista vazia, sem erro', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        jsonResponse({ calendars: { [HOST_A]: {} } }),
      );
      const out = await service.getFreeBusyByCalendar([HOST_A], IMPERSONATE, FROM, TO);
      expect(out[0]).toEqual({ calendarId: HOST_A, busy: [] });
    });

    it('agenda ausente da resposta vem marcada com erro, não como livre', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ calendars: {} }));
      const out = await service.getFreeBusyByCalendar([HOST_A], IMPERSONATE, FROM, TO);
      expect(out[0].error).toBe('calendar absent from freeBusy response');
      expect(out[0].busy).toEqual([]);
    });

    it('intervalo vazio e resposta sem "calendars" não quebram', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}));
      const out = await service.getFreeBusyByCalendar([HOST_A], IMPERSONATE, FROM, TO);
      expect(out).toHaveLength(1);
      expect(out[0].busy).toEqual([]);
    });

    it('descarta intervalo malformado em vez de propagar Invalid Date', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        jsonResponse({
          calendars: {
            [HOST_A]: {
              busy: [
                { start: 'não-é-data', end: '2026-08-03T14:00:00Z' },
                { start: '2026-08-03T15:00:00Z' },
                { start: '2026-08-03T16:00:00Z', end: '2026-08-03T17:00:00Z' },
              ],
            },
          },
        }),
      );
      const out = await service.getFreeBusyByCalendar([HOST_A], IMPERSONATE, FROM, TO);
      expect(out[0].busy).toHaveLength(1);
      expect(out[0].busy[0].end.toISOString()).toBe('2026-08-03T17:00:00.000Z');
    });

    it('lista vazia (ou só ids em branco) não chega a chamar o Google', async () => {
      expect(await service.getFreeBusyByCalendar([], IMPERSONATE, FROM, TO)).toEqual([]);
      expect(await service.getFreeBusyByCalendar(['  '], IMPERSONATE, FROM, TO)).toEqual([]);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('id repetido é lido uma vez só', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ calendars: {} }));
      await service.getFreeBusyByCalendar([HOST_A, HOST_A], IMPERSONATE, FROM, TO);
      expect(lastCall().body.items).toEqual([{ id: HOST_A }]);
    });

    it('sem token DWD → erro explícito', async () => {
      (getAccessToken as jest.Mock).mockResolvedValue(null);
      await expect(
        service.getFreeBusyByCalendar([HOST_A], IMPERSONATE, FROM, TO),
      ).rejects.toThrow(/no DWD token/);
    });

    it('HTTP de erro → erro explícito com status', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ error: 'nope' }, false, 403));
      await expect(
        service.getFreeBusyByCalendar([HOST_A], IMPERSONATE, FROM, TO),
      ).rejects.toThrow(/freeBusy 403/);
    });

    it('erro cujo corpo não pode ser lido ainda reporta o status', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(unreadableErrorResponse(500));
      await expect(
        service.getFreeBusyByCalendar([HOST_A], IMPERSONATE, FROM, TO),
      ).rejects.toThrow(/freeBusy 500/);
    });
  });

  // getBusyIntervals é o caminho do MODO ANTIGO (agenda do país, events.list).
  // Fica coberto porque ele continua sendo o que roda em produção enquanto a
  // flag do roster estiver desligada.
  describe('getBusyIntervals — agenda do país (modo antigo)', () => {
    it('lê events.list da agenda, com campos enxutos', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        jsonResponse({
          items: [
            { start: { dateTime: '2026-08-03T13:00:00Z' }, end: { dateTime: '2026-08-03T14:00:00Z' } },
          ],
        }),
      );

      const out = await service.getBusyIntervals(CAL_AR, IMPERSONATE, FROM, TO, AR_ZONE);

      const { url } = lastCall();
      expect(url).toContain(`/calendars/${encodeURIComponent(CAL_AR)}/events`);
      expect(url).toContain('fields=items%28start%2Cend%2Cstatus%29');
      expect(out).toHaveLength(1);
      expect(out[0].start.toISOString()).toBe('2026-08-03T13:00:00.000Z');
    });

    it('evento cancelado não ocupa', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        jsonResponse({
          items: [
            {
              status: 'cancelled',
              start: { dateTime: '2026-08-03T13:00:00Z' },
              end: { dateTime: '2026-08-03T14:00:00Z' },
            },
          ],
        }),
      );
      expect(await service.getBusyIntervals(CAL_AR, IMPERSONATE, FROM, TO)).toEqual([]);
    });

    it('evento de dia inteiro ocupa o dia (end.date é exclusivo)', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        jsonResponse({ items: [{ start: { date: '2026-08-03' }, end: { date: '2026-08-04' } }] }),
      );
      const out = await service.getBusyIntervals(CAL_AR, IMPERSONATE, FROM, TO, AR_ZONE);
      expect(out).toHaveLength(1);
      expect(
        DateTime.fromJSDate(out[0].start).setZone(AR_ZONE).toFormat('yyyy-MM-dd HH:mm'),
      ).toBe('2026-08-03 00:00');
    });

    it('datas malformadas e resposta sem items não quebram', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(
        jsonResponse({
          items: [
            { start: { date: 'xx' }, end: { date: 'yy' } },
            { start: { dateTime: 'xx' }, end: { dateTime: 'yy' } },
            {},
          ],
        }),
      );
      expect(await service.getBusyIntervals(CAL_AR, IMPERSONATE, FROM, TO)).toEqual([]);

      (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}));
      expect(await service.getBusyIntervals(CAL_AR, IMPERSONATE, FROM, TO)).toEqual([]);
    });

    it('sem token DWD → erro explícito', async () => {
      (getAccessToken as jest.Mock).mockResolvedValue(null);
      await expect(service.getBusyIntervals(CAL_AR, IMPERSONATE, FROM, TO)).rejects.toThrow(
        /no DWD token/,
      );
    });

    it('HTTP de erro → erro explícito com status', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ e: 1 }, false, 404));
      await expect(service.getBusyIntervals(CAL_AR, IMPERSONATE, FROM, TO)).rejects.toThrow(
        /events.list 404/,
      );
    });

    it('erro cujo corpo não pode ser lido ainda reporta o status', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(unreadableErrorResponse(502));
      await expect(service.getBusyIntervals(CAL_AR, IMPERSONATE, FROM, TO)).rejects.toThrow(
        /events.list 502/,
      );
    });
  });

  describe('deleteEvent', () => {
    it('apaga o evento avisando os convidados', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}, true, 204));
      await service.deleteEvent(CAL_AR, 'evt-1', IMPERSONATE);
      const { url, init } = lastCall();
      expect(init.method).toBe('DELETE');
      expect(url).toContain('sendUpdates=all');
      expect(url).toContain('/events/evt-1');
    });

    it('410 (já apagado) é sucesso idempotente', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}, false, 410));
      await expect(service.deleteEvent(CAL_AR, 'evt-1', IMPERSONATE)).resolves.toBeUndefined();
    });

    it('outro erro HTTP sobe', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}, false, 500));
      await expect(service.deleteEvent(CAL_AR, 'evt-1', IMPERSONATE)).rejects.toThrow(
        /deleteEvent 500/,
      );
    });

    it('erro cujo corpo não pode ser lido ainda reporta o status', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(unreadableErrorResponse(504));
      await expect(service.deleteEvent(CAL_AR, 'evt-1', IMPERSONATE)).rejects.toThrow(
        /deleteEvent 504/,
      );
    });

    it('sem token DWD → erro explícito', async () => {
      (getAccessToken as jest.Mock).mockResolvedValue(null);
      await expect(service.deleteEvent(CAL_AR, 'evt-1', IMPERSONATE)).rejects.toThrow(
        /no DWD token/,
      );
    });
  });

  describe('getCalendarTimezone', () => {
    it('lê o fuso da própria agenda, pedindo só esse campo', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ timeZone: 'America/Sao_Paulo' }));

      const tz = await service.getCalendarTimezone(CAL_AR, IMPERSONATE);

      expect(tz).toBe('America/Sao_Paulo');
      const { url } = lastCall();
      expect(url).toContain(`/calendars/${encodeURIComponent(CAL_AR)}`);
      expect(url).toContain('fields=timeZone');
    });

    it('HTTP de erro devolve null em vez de derrubar a página pública', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}, false, 404));
      expect(await service.getCalendarTimezone(CAL_AR, IMPERSONATE)).toBeNull();
    });

    it('resposta sem fuso, ou com fuso em branco, devolve null', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}));
      expect(await service.getCalendarTimezone(CAL_AR, IMPERSONATE)).toBeNull();

      (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ timeZone: '   ' }));
      expect(await service.getCalendarTimezone(CAL_AR, IMPERSONATE)).toBeNull();
    });

    it('fuso INVÁLIDO devolve null — grade errada em silêncio seria pior', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ timeZone: 'Marte/Olympus' }));
      expect(await service.getCalendarTimezone(CAL_AR, IMPERSONATE)).toBeNull();
    });

    it('sem token DWD → erro explícito', async () => {
      (getAccessToken as jest.Mock).mockResolvedValue(null);
      await expect(service.getCalendarTimezone(CAL_AR, IMPERSONATE)).rejects.toThrow(
        /no DWD token/,
      );
    });
  });

  describe('createEventWithMeet', () => {
    const baseParams = {
      calendarId: CAL_AR,
      impersonateEmail: IMPERSONATE,
      summary: 'Entrevista de admisión — Equipo de Admisión EnLite',
      description: 'Entrevista de admisión Enlite (AR).',
      startISO: '2026-08-03T10:00:00-03:00',
      endISO: '2026-08-03T11:00:00-03:00',
      timezone: AR_ZONE,
    };

    beforeEach(() => {
      (global.fetch as jest.Mock).mockResolvedValue(
        jsonResponse({ id: 'evt-1', hangoutLink: 'https://meet.google.com/abc-defg-hij' }),
      );
    });

    it('leva a atendente como participante e ESCONDE a lista de convidados', async () => {
      await service.createEventWithMeet({
        ...baseParams,
        coHostEmail: HOST_A,
        patientEmail: 'paciente@example.com',
      });

      const { url, body } = lastCall();
      expect(url).toContain(encodeURIComponent(CAL_AR));
      expect(body.attendees).toEqual([
        { email: HOST_A },
        { email: 'paciente@example.com' },
      ]);
      // O paciente não pode descobrir quem vai atendê-lo.
      expect(body.guestsCanSeeOtherGuests).toBe(false);
      // ...e o título nomeia a EQUIPE, nunca a pessoa.
      expect(body.summary).toBe('Entrevista de admisión — Equipo de Admisión EnLite');
      expect(JSON.stringify(body)).not.toContain('Ana');
    });

    it('sem atendente e sem paciente → nenhum participante', async () => {
      await service.createEventWithMeet(baseParams);
      expect(lastCall().body.attendees).toEqual([]);
      expect(lastCall().body.guestsCanSeeOtherGuests).toBe(false);
    });

    it('sem timezone explícito o evento sai na zona AR', async () => {
      const { timezone: _omitido, ...semZona } = baseParams;
      await service.createEventWithMeet(semZona);
      const body = lastCall().body as { start: { timeZone: string } };
      expect(body.start.timeZone).toBe(AR_ZONE);
    });

    it('devolve id e link do Meet', async () => {
      const out = await service.createEventWithMeet({ ...baseParams, coHostEmail: HOST_A });
      expect(out).toEqual({
        eventId: 'evt-1',
        meetLink: 'https://meet.google.com/abc-defg-hij',
      });
    });

    it('resposta sem id/hangoutLink degrada para string vazia', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({}));
      expect(await service.createEventWithMeet(baseParams)).toEqual({ eventId: '', meetLink: '' });
    });

    it('sem token DWD → erro explícito', async () => {
      (getAccessToken as jest.Mock).mockResolvedValue(null);
      await expect(service.createEventWithMeet(baseParams)).rejects.toThrow(/no DWD token/);
    });

    it('HTTP de erro → erro explícito com status', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(jsonResponse({ error: 'nope' }, false, 500));
      await expect(service.createEventWithMeet(baseParams)).rejects.toThrow(/createEvent 500/);
    });

    it('erro cujo corpo não pode ser lido ainda reporta o status', async () => {
      (global.fetch as jest.Mock).mockResolvedValue(unreadableErrorResponse(503));
      await expect(service.createEventWithMeet(baseParams)).rejects.toThrow(/createEvent 503/);
    });
  });

  describe('sumBusyMinutesInWeek', () => {
    const ref = '2026-08-05T10:00:00-03:00'; // quarta

    function busy(fromISO: string, toISO: string): BusyInterval {
      return {
        start: DateTime.fromISO(fromISO, { zone: AR_ZONE }).toJSDate(),
        end: DateTime.fromISO(toISO, { zone: AR_ZONE }).toJSDate(),
      };
    }

    it('soma a duração dos intervalos da semana', () => {
      const total = sumBusyMinutesInWeek(
        [busy('2026-08-03T09:00', '2026-08-03T11:00'), busy('2026-08-06T14:00', '2026-08-06T15:00')],
        ref,
        AR_ZONE,
      );
      expect(total).toBe(180);
    });

    it('ignora o que está fora da SEMANA e recorta quem cruza a borda do expediente', () => {
      const total = sumBusyMinutesInWeek(
        [
          busy('2026-07-31T09:00', '2026-07-31T18:00'), // sexta da semana anterior
          busy('2026-08-03T08:00', '2026-08-03T10:00'), // segunda 08→10: só 09→10 conta
        ],
        ref,
        AR_ZONE,
      );
      expect(total).toBe(60);
    });

    it('não conta duas vezes o que se sobrepõe', () => {
      const total = sumBusyMinutesInWeek(
        [busy('2026-08-03T09:00', '2026-08-03T11:00'), busy('2026-08-03T10:00', '2026-08-03T12:00')],
        ref,
        AR_ZONE,
      );
      expect(total).toBe(180); // 09→12, não 4h
    });

    it('funde intervalos que se encostam', () => {
      const total = sumBusyMinutesInWeek(
        [busy('2026-08-03T09:00', '2026-08-03T10:00'), busy('2026-08-03T10:00', '2026-08-03T11:00')],
        ref,
        AR_ZONE,
      );
      expect(total).toBe(120);
    });

    it('agenda vazia, lista ausente ou data inválida → 0', () => {
      expect(sumBusyMinutesInWeek([], ref, AR_ZONE)).toBe(0);
      expect(sumBusyMinutesInWeek(undefined as unknown as BusyInterval[], ref, AR_ZONE)).toBe(0);
      expect(sumBusyMinutesInWeek([busy('2026-08-03T09:00', '2026-08-03T10:00')], 'lixo')).toBe(0);
    });

    it('intervalo degenerado (fim <= início) não conta', () => {
      expect(
        sumBusyMinutesInWeek([busy('2026-08-03T10:00', '2026-08-03T10:00')], ref, AR_ZONE),
      ).toBe(0);
    });

    // ── CM5 do veredito do `lex`: a vida fora do expediente não decide nada ──

    it('bloco às 22h de terça NÃO conta', () => {
      expect(
        sumBusyMinutesInWeek([busy('2026-08-04T22:00', '2026-08-04T23:30')], ref, AR_ZONE),
      ).toBe(0);
    });

    it('sábado e domingo inteiros NÃO contam', () => {
      expect(
        sumBusyMinutesInWeek(
          [busy('2026-08-08T09:00', '2026-08-08T18:00'), busy('2026-08-09T09:00', '2026-08-09T18:00')],
          ref,
          AR_ZONE,
        ),
      ).toBe(0);
    });

    it('bloco às 15h de terça CONTA — é trabalho, e é o que deve pesar', () => {
      expect(
        sumBusyMinutesInWeek([busy('2026-08-04T15:00', '2026-08-04T16:00')], ref, AR_ZONE),
      ).toBe(60);
    });

    it('feriado nacional não conta como carga', () => {
      // 17/08/2026 = San Martín (segunda). Semana de referência: 19/08 (quarta).
      expect(
        sumBusyMinutesInWeek(
          [busy('2026-08-17T09:00', '2026-08-17T18:00')],
          '2026-08-19T10:00:00-03:00',
          AR_ZONE,
        ),
      ).toBe(0);
    });

    it('compromisso que atravessa a noite conta só a parte do expediente', () => {
      // Terça 16:00 → quarta 10:00: 2h na terça + 1h na quarta.
      expect(
        sumBusyMinutesInWeek([busy('2026-08-04T16:00', '2026-08-05T10:00')], ref, AR_ZONE),
      ).toBe(180);
    });

    it('semana sem nenhum dia útil → 0 (expediente inexistente, não divisão por zero)', () => {
      const noWeekdays = new Set([
        '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07',
      ]);
      expect(
        sumBusyMinutesInWeek(
          [busy('2026-08-03T09:00', '2026-08-03T18:00')],
          ref,
          AR_ZONE,
          { startHour: 9, endHour: 18 },
          noWeekdays,
        ),
      ).toBe(0);
    });

    it('respeita expediente de outro país (config BR passada pelo chamador)', () => {
      expect(
        sumBusyMinutesInWeek(
          [busy('2026-08-04T08:00', '2026-08-04T09:30')],
          ref,
          AR_ZONE,
          { startHour: 8, endHour: 17 },
          new Set<string>(),
        ),
      ).toBe(90);
    });

    it('usa a zona AR por default', () => {
      expect(sumBusyMinutesInWeek([busy('2026-08-03T09:00', '2026-08-03T10:00')], ref)).toBe(60);
    });
  });
});
