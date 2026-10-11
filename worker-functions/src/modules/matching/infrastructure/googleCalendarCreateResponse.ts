/**
 * Resposta do `events.insert` da admissão (spec 050 F9, R-34).
 *
 * O evento nasce com um id FIXO por reunião (`eventId`), para que repetir a criação depois de uma resposta perdida não
 * duplique. A documentação do `events.insert` diz que o id é escolhido pelo cliente e que colisões "podem não ser detectadas" na
 * criação, mas NÃO diz o que a API responde a um id repetido. Por isso um 409 não é tratado como erro nem como sucesso às
 * cegas: o evento é LIDO por id (events.get) e só vale se existe, não está cancelado e tem id + link do Meet.
 */
export interface CreatedEvent {
  eventId: string;
  meetLink: string;
}

interface RawCreated {
  id?: string;
  hangoutLink?: string;
  status?: string;
}

const EVENTS_URL = (calendarId: string): string => `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;

export async function readCreatedEvent(
  res: Response,
  ctx: { calendarId: string; eventId?: string; token: string },
): Promise<CreatedEvent> {
  const { calendarId, eventId, token } = ctx;
  if (res.status === 409 && eventId) {
    const got = await fetch(`${EVENTS_URL(calendarId)}/${encodeURIComponent(eventId)}`, { headers: { Authorization: `Bearer ${token}` } });
    const existing = got.ok ? ((await got.json()) as RawCreated) : null;
    if (existing && existing.status !== 'cancelled') return { eventId: existing.id ?? '', meetLink: existing.hangoutLink ?? '' };
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`[AdmissionCalendarService] createEvent ${res.status} on ${calendarId}: ${detail}`);
  }
  const created = (await res.json()) as RawCreated;
  return { eventId: created.id ?? '', meetLink: created.hangoutLink ?? '' };
}
