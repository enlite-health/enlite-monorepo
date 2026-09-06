import { DateTime } from 'luxon';
import { v4 as uuidv4 } from 'uuid';
import { getAccessToken } from './GoogleCalendarEventFinder';

// ─── Constants ───────────────────────────────────────────────────────────────

export const AR_ZONE = 'America/Argentina/Buenos_Aires';

/** Feriados nacionais AR 2026 (fechados a novos slots). YYYY-MM-DD em zona AR. */
export const AR_HOLIDAYS_2026: ReadonlySet<string> = new Set([
  '2026-01-01', // Año Nuevo
  '2026-03-24', // Día de la Memoria
  '2026-04-02', // Malvinas
  '2026-05-01', // Día del Trabajador
  '2026-05-25', // Revolución de Mayo
  '2026-06-20', // Belgrano
  '2026-07-09', // Independencia
  '2026-08-17', // San Martín
  '2026-10-12', // Diversidad Cultural
  '2026-11-20', // Soberanía Nacional
  '2026-12-08', // Inmaculada Concepción
  '2026-12-25', // Navidad
]);

// Grade de slots: hora em hora, 09:00–18:00, duração 45min → últimos starts às 17:00.
const BUSINESS_START_HOUR = 9;
const BUSINESS_END_HOUR = 18;
const DEFAULT_SLOT_MINUTES = 45;
const DEFAULT_MIN_LEAD_MINUTES = 120; // now + 2h
const DEFAULT_HORIZON_BUSINESS_DAYS = 10;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BusyInterval {
  start: Date;
  end: Date;
}

export interface FreeSlot {
  startISO: string;
}

/**
 * Resultado da leitura de ocupação de UMA agenda pelo `freeBusy`.
 *
 * `error` presente = não foi possível ler aquela agenda (sem permissão, id
 * errado, indisponibilidade do Google). Nesse caso `busy` vem vazio, mas o
 * chamador NÃO pode ler isso como "livre": a política é fail-closed — agenda
 * ilegível deixa a pessoa fora do cálculo, em vez de oferecer um horário que
 * pode estar ocupado.
 */
export interface CalendarBusyResult {
  calendarId: string;
  busy: BusyInterval[];
  error?: string;
}

export interface BusinessHoursConfig {
  /** First slot starts at this hour (local time). */
  startHour: number;
  /** Slots must END by this hour (local time). */
  endHour: number;
}

export interface ComputeFreeSlotsParams {
  /**
   * Ocupação por FONTE de disponibilidade, chaveada pelo identificador da
   * agenda. A regra é de UNIÃO: um horário está livre se **alguma** fonte
   * estiver livre nele; só some da lista quando **todas** estão ocupadas.
   *
   * Os dois modos caem na mesma função sem `if` (D2):
   *   · flag OFF → uma única entrada, a agenda de admissão do país. União de um
   *     conjunto unitário = capacidade 1, exatamente o comportamento de hoje.
   *   · flag ON  → uma entrada por atendente ativa do país.
   */
  busyIntervalsByHost: Record<string, BusyInterval[]>;
  /** Instante "agora" (injetável pra teste determinístico). */
  now: Date;
  /** Zona horária do país (default AR). Slots são calculados nesta zona. */
  timezone?: string;
  /** Feriados nacionais (YYYY-MM-DD na zona) fechados a slots (default AR). */
  holidays?: ReadonlySet<string>;
  /** Janela de expediente local (default 09–18). */
  businessHours?: BusinessHoursConfig;
  slotMinutes?: number;
  minLeadMinutes?: number;
  horizonBusinessDays?: number;
}

/**
 * Cria o evento numa AGENDA DEDICADA de admissão (não na primary de ninguém),
 * impersonando `impersonateEmail` (= enlite@enlite.health) — assim a operação
 * mantém UMA agenda por país para auditar o funil inteiro (D3).
 *
 * A atendente atribuída entra como `coHostEmail`, para o compromisso cair
 * também na agenda dela, com notificação e lembrete do Google. Consequência
 * deliberada: a partir daí ele conta como ocupado no `freeBusy` dela, e o
 * horário deixa de ser oferecido sem precisar de código nenhum.
 */
export interface CreateEventParams {
  /** Agenda de admissão dedicada (ADMISSION_CALENDAR_ID_{country}). */
  calendarId: string;
  /** Quem impersonar via DWD (dono da agenda de admissão, ex. enlite@enlite.health). */
  impersonateEmail: string;
  summary: string;
  description?: string;
  startISO: string;
  endISO: string;
  /** Zona horária do evento (default AR). */
  timezone?: string;
  /** Atendente atribuída: entra como participante com poder de edição. */
  coHostEmail?: string;
  /** E-mail de contato do paciente/lead (attendee), se houver. */
  patientEmail?: string;
}

interface RawCalendarEvent {
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  status?: string;
}

interface RawFreeBusyCalendar {
  busy?: { start?: string; end?: string }[];
  errors?: { domain?: string; reason?: string }[];
}

// ─── Pure slot computation (testável, sem I/O) ─────────────────────────────────

/** overlap de [aStart,aEnd) com [bStart,bEnd) */
function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * PURO: gera slots hora em hora, seg–sex no expediente (default 09–18), de
 * now+leadMin até +N dias úteis, pulando fim de semana e feriados do país.
 * Um slot entra na lista se ALGUMA das fontes de `busyIntervalsByHost` estiver
 * livre nele (união) e se ele terminar dentro do expediente.
 *
 * A lista devolvida é só de HORÁRIOS: qual atendente está livre em cada um não
 * sai daqui de propósito — o paciente não escolhe pessoa, e `book` refaz a
 * leitura ao vivo antes de atribuir (o estado pode ter mudado no meio).
 *
 * Multi-país: `timezone`, `holidays` e `businessHours` são parâmetros
 * (default = Argentina), então nada aqui é hardcodado por país.
 */
export function computeFreeSlots(params: ComputeFreeSlotsParams): FreeSlot[] {
  const {
    busyIntervalsByHost,
    now,
    timezone = AR_ZONE,
    holidays = AR_HOLIDAYS_2026,
    businessHours = { startHour: BUSINESS_START_HOUR, endHour: BUSINESS_END_HOUR },
    slotMinutes = DEFAULT_SLOT_MINUTES,
    minLeadMinutes = DEFAULT_MIN_LEAD_MINUTES,
    horizonBusinessDays = DEFAULT_HORIZON_BUSINESS_DAYS,
  } = params;

  const { startHour, endHour } = businessHours;

  const isBusinessDay = (dt: DateTime): boolean => {
    if (dt.weekday > 5) return false; // 6=sáb, 7=dom
    return !holidays.has(dt.toFormat('yyyy-MM-dd'));
  };

  const earliestMs = now.getTime() + minLeadMinutes * 60_000;

  // Pré-computa busy em ms por fonte.
  const hostKeys = Object.keys(busyIntervalsByHost ?? {});
  const busyMsByHost: Record<string, { start: number; end: number }[]> = {};
  for (const key of hostKeys) {
    busyMsByHost[key] = (busyIntervalsByHost[key] ?? []).map((b) => ({
      start: b.start.getTime(),
      end: b.end.getTime(),
    }));
  }

  const slots: FreeSlot[] = [];
  let cursor = DateTime.fromJSDate(now, { zone: timezone }).startOf('day');
  let businessDaysSeen = 0;

  while (businessDaysSeen < horizonBusinessDays) {
    if (isBusinessDay(cursor)) {
      businessDaysSeen += 1;
      for (let hour = startHour; hour < endHour; hour += 1) {
        const slotStart = cursor.set({ hour, minute: 0, second: 0, millisecond: 0 });
        const slotEnd = slotStart.plus({ minutes: slotMinutes });
        // Slot precisa terminar dentro do expediente.
        if (slotEnd.hour > endHour || (slotEnd.hour === endHour && slotEnd.minute > 0)) {
          continue;
        }
        const startMs = slotStart.toMillis();
        const endMs = slotEnd.toMillis();
        if (startMs < earliestMs) continue;

        // União: basta UMA fonte livre para o horário ser oferecido.
        const someoneFree = hostKeys.some(
          (key) => !busyMsByHost[key].some((b) => overlaps(startMs, endMs, b.start, b.end)),
        );
        if (someoneFree) {
          slots.push({ startISO: slotStart.toISO() as string });
        }
      }
    }
    cursor = cursor.plus({ days: 1 });
  }

  slots.sort((a, b) => a.startISO.localeCompare(b.startISO));
  return slots;
}

/**
 * PURO: minutos ocupados de uma agenda **dentro do expediente** da semana que
 * contém `anyDateInWeekISO`. É a métrica de carga da atribuição (D5): entre
 * duas atendentes livres no horário, atende quem tem a semana mais leve.
 *
 * ⚠️ A janela é deliberadamente estreita — só dias úteis, só entre `startHour`
 * e `endHour`, só a semana do horário pedido (condição CM5 do veredito do
 * `lex`, Ley 25.326 art. 4.1 / LGPD art. 6, III). Somar 24×7 responderia
 * "quanto de vida ela tem marcada" em vez de "quanto ela já trabalha nesta
 * semana", e é exatamente aí que ler agenda de funcionária vira inferência
 * sobre vida privada. Bloco às 22h, no sábado ou num feriado NÃO influencia
 * quem vai atender.
 *
 * Sobreposições não contam duas vezes: duas reuniões empilhadas às 10:00 são
 * uma hora ocupada, não duas.
 */
export function sumBusyMinutesInWeek(
  busy: BusyInterval[],
  anyDateInWeekISO: string,
  timezone: string = AR_ZONE,
  businessHours: BusinessHoursConfig = {
    startHour: BUSINESS_START_HOUR,
    endHour: BUSINESS_END_HOUR,
  },
  holidays: ReadonlySet<string> = AR_HOLIDAYS_2026,
): number {
  const ref = DateTime.fromISO(anyDateInWeekISO, { zone: timezone });
  if (!ref.isValid) return 0;

  // Janelas de expediente da semana: seg–sex, fora de feriado, [start, end).
  const weekStart = ref.startOf('week'); // luxon: segunda 00:00
  const windows: { start: number; end: number }[] = [];
  for (let i = 0; i < 7; i += 1) {
    const day = weekStart.plus({ days: i });
    if (day.weekday > 5) continue;
    if (holidays.has(day.toFormat('yyyy-MM-dd'))) continue;
    windows.push({
      start: day.set({ hour: businessHours.startHour, minute: 0, second: 0, millisecond: 0 }).toMillis(),
      end: day.set({ hour: businessHours.endHour, minute: 0, second: 0, millisecond: 0 }).toMillis(),
    });
  }
  if (windows.length === 0) return 0;

  // Funde os intervalos ocupados antes de somar, para não contar sobreposição
  // duas vezes.
  const sorted = (busy ?? [])
    .map((b) => ({ start: b.start.getTime(), end: b.end.getTime() }))
    .filter((b) => b.end > b.start)
    .sort((a, b) => a.start - b.start);

  const merged: { start: number; end: number }[] = [];
  for (const b of sorted) {
    const last = merged[merged.length - 1];
    if (last && b.start <= last.end) {
      last.end = Math.max(last.end, b.end);
      continue;
    }
    merged.push({ ...b });
  }

  // Só o que cai dentro de alguma janela de expediente entra na conta.
  let totalMs = 0;
  for (const b of merged) {
    for (const w of windows) {
      const overlapMs = Math.min(b.end, w.end) - Math.max(b.start, w.start);
      if (overlapMs > 0) totalMs += overlapMs;
    }
  }

  return Math.round(totalMs / 60_000);
}

// ─── Service (I/O contra Google Calendar) ──────────────────────────────────────

export class AdmissionCalendarService {
  private token(hostEmail: string): Promise<string | null> {
    return getAccessToken(hostEmail, hostEmail);
  }

  /**
   * Busy intervals da AGENDA DE ADMISSÃO do país (não a primary de ninguém):
   * lê `calendars/{calendarId}/events` impersonando `impersonateEmail` (dono da
   * agenda, ex. enlite@enlite.health) via DWD. Capacidade 1: QUALQUER evento na
   * agenda ocupa o horário — não há filtro de "declined" por pessoa, porque a
   * disponibilidade é da agenda, não de um roster. Evento all-day = dia inteiro.
   */
  async getBusyIntervals(
    calendarId: string,
    impersonateEmail: string,
    fromISO: string,
    toISO: string,
    timezone: string = AR_ZONE,
  ): Promise<BusyInterval[]> {
    const token = await this.token(impersonateEmail);
    if (!token) throw new Error(`[AdmissionCalendarService] no DWD token for ${impersonateEmail}`);

    const params = new URLSearchParams({
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '2500',
      timeMin: fromISO,
      timeMax: toISO,
      fields: 'items(start,end,status)',
    });

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`[AdmissionCalendarService] events.list ${res.status} on ${calendarId}: ${detail}`);
    }

    const data = (await res.json()) as { items?: RawCalendarEvent[] };
    const intervals: BusyInterval[] = [];

    for (const ev of data.items ?? []) {
      // Evento cancelado não ocupa.
      if (ev.status === 'cancelled') continue;

      if (ev.start?.date && ev.end?.date) {
        // All-day: end.date é exclusivo (dia seguinte). Ocupa [start, end).
        const start = DateTime.fromISO(ev.start.date, { zone: timezone }).startOf('day');
        const end = DateTime.fromISO(ev.end.date, { zone: timezone }).startOf('day');
        if (start.isValid && end.isValid) intervals.push({ start: start.toJSDate(), end: end.toJSDate() });
        continue;
      }

      if (ev.start?.dateTime && ev.end?.dateTime) {
        const start = new Date(ev.start.dateTime);
        const end = new Date(ev.end.dateTime);
        if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime())) {
          intervals.push({ start, end });
        }
      }
    }

    return intervals;
  }

  /**
   * Fuso da agenda, lido do próprio Google (`calendars.get`).
   *
   * É a FONTE DE VERDADE do fuso (pedido do Gabriel, 20/08): a grade de
   * horários passa a seguir o que está configurado na agenda, não uma constante
   * por país no código. Assim, quem opera muda o fuso na tela do Google e o
   * sistema acompanha — e não importa de onde a atendente trabalha, porque o
   * horário oferecido é o da agenda do país, um só para todo mundo.
   *
   * Devolve `null` se não conseguir ler: fuso é apresentação, não trava de
   * segurança, e derrubar a página pública por causa disso seria pior do que
   * cair no default do país (que hoje é exatamente o mesmo valor — medido em
   * 20/08: AR = America/Argentina/Buenos_Aires, BR = America/Sao_Paulo).
   */
  async getCalendarTimezone(calendarId: string, impersonateEmail: string): Promise<string | null> {
    const token = await this.token(impersonateEmail);
    if (!token) throw new Error(`[AdmissionCalendarService] no DWD token for ${impersonateEmail}`);

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}?fields=timeZone`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) return null;

    const data = (await res.json()) as { timeZone?: string };
    const tz = data.timeZone?.trim();
    if (!tz) return null;
    // Fuso inválido viraria uma grade de horários silenciosamente errada.
    return DateTime.now().setZone(tz).isValid ? tz : null;
  }

  /**
   * Ocupação de N agendas numa ÚNICA requisição, por `POST /freeBusy`.
   *
   * ⚠️ É deliberadamente esta API, e não `events.list`, porque aqui se lê a
   * agenda PESSOAL de funcionárias: o `freeBusy` devolve apenas pares
   * `{start, end}` de ocupado — sem título, sem participantes, sem descrição,
   * sem local. A minimização vira propriedade do endpoint, em vez de depender
   * de um `fields=` que qualquer refactor futuro alargaria sem ninguém notar.
   * Brinde: evento marcado como "Livre" (`transparency: transparent`) não
   * bloqueia, que é o que a operação espera.
   *
   * Erro por agenda é ISOLADO: uma agenda ilegível não derruba as outras, volta
   * com `error` preenchido, e o chamador a trata como inutilizável (fail-closed),
   * nunca como livre.
   */
  async getFreeBusyByCalendar(
    calendarIds: string[],
    impersonateEmail: string,
    fromISO: string,
    toISO: string,
    timezone: string = AR_ZONE,
  ): Promise<CalendarBusyResult[]> {
    const ids = [...new Set(calendarIds)].filter((id) => id.trim() !== '');
    if (ids.length === 0) return [];

    const token = await this.token(impersonateEmail);
    if (!token) throw new Error(`[AdmissionCalendarService] no DWD token for ${impersonateEmail}`);

    const res = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timeMin: fromISO,
        timeMax: toISO,
        timeZone: timezone,
        items: ids.map((id) => ({ id })),
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`[AdmissionCalendarService] freeBusy ${res.status}: ${detail}`);
    }

    const data = (await res.json()) as { calendars?: Record<string, RawFreeBusyCalendar> };
    const calendars = data.calendars ?? {};

    return ids.map((calendarId) => {
      const entry = calendars[calendarId];
      if (!entry) {
        return { calendarId, busy: [], error: 'calendar absent from freeBusy response' };
      }
      if (entry.errors?.length) {
        return {
          calendarId,
          busy: [],
          error: entry.errors.map((e) => e.reason ?? 'unknown').join(','),
        };
      }
      const busy: BusyInterval[] = [];
      for (const b of entry.busy ?? []) {
        if (!b.start || !b.end) continue;
        const start = new Date(b.start);
        const end = new Date(b.end);
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
        busy.push({ start, end });
      }
      return { calendarId, busy };
    });
  }

  /**
   * Cria evento com Google Meet numa AGENDA DEDICADA de admissão (não na primary
   * de ninguém), impersonando `impersonateEmail` (= enlite@enlite.health).
   * Attendees = [atendente atribuída?] + [paciente?]. O paciente enxerga quem
   * vai atendê-lo no convite, e isso é aceito (ver comentário no corpo): o que
   * o produto proíbe é ele ESCOLHER, e essa trava está na borda de entrada.
   * Retorna id + hangoutLink.
   */
  async createEventWithMeet(
    {
      calendarId,
      impersonateEmail,
      summary,
      description,
      startISO,
      endISO,
      timezone = AR_ZONE,
      coHostEmail,
      patientEmail,
    }: CreateEventParams,
  ): Promise<{ eventId: string; meetLink: string }> {
    const token = await this.token(impersonateEmail);
    if (!token) throw new Error(`[AdmissionCalendarService] no DWD token for ${impersonateEmail}`);

    const attendees = [
      ...(coHostEmail ? [{ email: coHostEmail }] : []),
      ...(patientEmail ? [{ email: patientEmail }] : []),
    ];

    const body = {
      summary,
      description,
      start: { dateTime: startISO, timeZone: timezone },
      end: { dateTime: endISO, timeZone: timezone },
      attendees,
      // Convidados (o paciente) podem editar/reagendar via convite.
      guestsCanModify: true,
      // ⚠️ NÃO adicionar `guestsCanSeeOtherGuests: false` aqui: com
      // `guestsCanModify: true` o Google DESCARTA o campo em silêncio — medido
      // em 20/08 com dois eventos-sonda na agenda real (com a flag de edição,
      // só `guestsCanModify` é gravado; sem ela, o `false` gruda). A linha
      // existia e não protegia nada.
      //
      // E não precisa proteger: a decisão do produto (Gabriel, 20/08) é que
      // ver quem vai atender DEPOIS do evento criado é aceitável — a pessoa
      // vai encontrar a atendente no Meet de qualquer forma. O que não pode é
      // o paciente ESCOLHER quem atende, e isso é barrado antes: a lista de
      // horários não diz de quem é o horário, e o corpo do `book` é `.strict()`
      // (mandar `hostEmail` devolve 400).
      conferenceData: {
        createRequest: {
          requestId: uuidv4(),
          conferenceSolutionKey: { type: 'hangoutsMeet' },
        },
      },
    };

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?conferenceDataVersion=1&sendUpdates=all`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`[AdmissionCalendarService] createEvent ${res.status} on ${calendarId}: ${detail}`);
    }

    const created = (await res.json()) as { id?: string; hangoutLink?: string };
    return { eventId: created.id ?? '', meetLink: created.hangoutLink ?? '' };
  }

  /** Remove evento de uma agenda (limpeza / cancelamento), impersonando o dono. */
  async deleteEvent(calendarId: string, eventId: string, impersonateEmail: string): Promise<void> {
    const token = await this.token(impersonateEmail);
    if (!token) throw new Error(`[AdmissionCalendarService] no DWD token for ${impersonateEmail}`);

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    );
    // 410 = já deletado; tratamos como sucesso idempotente.
    if (!res.ok && res.status !== 410) {
      const detail = await res.text().catch(() => '');
      throw new Error(`[AdmissionCalendarService] deleteEvent ${res.status} on ${calendarId}: ${detail}`);
    }
  }

}

export const admissionCalendarService = new AdmissionCalendarService();
