/**
 * admissionCalendar.ts — ler a agenda de admissão no GOOGLE, não no nosso banco.
 *
 * A diferença importa: `admission_appointments.calendar_event_id` preenchido
 * prova que NÓS achamos que criamos o evento. Só o Google responder com o evento
 * prova que ele existe. Como a suíte é monitor de caixa-preta, a fonte externa é
 * a que vale.
 *
 * Escopo: `calendar` (ver CALENDAR_SCOPE em gcp.ts — readonly ainda não está na
 * allowlist da DWD). Este módulo só chama `events.get`; quem apaga o evento de
 * teste é o backend, no purge.
 */
import { dwdToken, CALENDAR_SCOPE } from './gcp';

/** Dono da agenda a impersonar (mesmo default do backend). */
const IMPERSONATE = process.env.ADMISSION_IMPERSONATE_EMAIL ?? 'enlite@enlite.health';

export interface CalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  hangoutLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}

/** Id da agenda de admissão do país, pela mesma env que o backend usa. */
export function admissionCalendarId(country: 'AR' | 'BR'): string {
  const env = country === 'AR' ? 'ADMISSION_CALENDAR_ID_AR' : 'ADMISSION_CALENDAR_ID_BR';
  const id = process.env[env];
  if (!id) throw new Error(`env ${env} não configurada no runner`);
  return id;
}

/**
 * Busca um evento por id. Devolve null em 404 (evento não existe / já apagado) —
 * ausência é um resultado legítimo, não erro: o teste usa isto nos dois sentidos
 * (existe depois de agendar · sumiu depois de limpar).
 */
export async function getAdmissionEvent(
  country: 'AR' | 'BR',
  eventId: string,
): Promise<CalendarEvent | null> {
  const token = await dwdToken(IMPERSONATE, CALENDAR_SCOPE);
  const calendarId = admissionCalendarId(country);

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) {
    throw new Error(`calendar events.get ${res.status}: ${await res.text().catch(() => '')}`);
  }
  return (await res.json()) as CalendarEvent;
}

/**
 * Espera o evento SUMIR da agenda (usado depois do purge). O Google leva alguns
 * segundos para propagar a exclusão; e um evento cancelado continua respondendo
 * 200 com `status: 'cancelled'` — as duas coisas contam como "sumiu".
 */
export async function waitForEventGone(
  country: 'AR' | 'BR',
  eventId: string,
  { timeoutMs = 60_000, intervalMs = 5_000 } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const ev = await getAdmissionEvent(country, eventId);
    if (ev === null || ev.status === 'cancelled') return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/**
 * Procura o evento de admissão que ocupa uma janela de horário. É assim que se
 * prova o agendamento sem depender do nosso banco: o `book` devolve o horário,
 * e o Google diz se existe evento ali.
 *
 * Ignora eventos cancelados (o Google mantém o registro com status 'cancelled'
 * por um tempo depois do delete).
 */
export async function findAdmissionEventAtSlot(
  country: 'AR' | 'BR',
  slotStartISO: string,
  slotMinutes = 45,
): Promise<CalendarEvent | null> {
  const token = await dwdToken(IMPERSONATE, CALENDAR_SCOPE);
  const calendarId = admissionCalendarId(country);

  const start = new Date(slotStartISO);
  const timeMin = new Date(start.getTime() - 60_000).toISOString();
  const timeMax = new Date(start.getTime() + slotMinutes * 60_000).toISOString();

  const params = new URLSearchParams({
    singleEvents: 'true',
    orderBy: 'startTime',
    timeMin,
    timeMax,
    maxResults: '10',
  });

  const res = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    throw new Error(`calendar events.list ${res.status}: ${await res.text().catch(() => '')}`);
  }
  const body = (await res.json()) as { items?: CalendarEvent[] };
  return (body.items ?? []).find((e) => e.status !== 'cancelled') ?? null;
}

/** Espera o horário ficar LIVRE na agenda (usado depois do purge). */
export async function waitForSlotFree(
  country: 'AR' | 'BR',
  slotStartISO: string,
  { timeoutMs = 60_000, intervalMs = 5_000 } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await findAdmissionEventAtSlot(country, slotStartISO)) === null) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
