import { existsSync, readFileSync } from 'fs';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';

// ─── Constants ───────────────────────────────────────────────────────────────

export const MEET_LINK_REGEX = /^https:\/\/meet\.google\.com\/[a-z0-9]+-[a-z0-9]+-[a-z0-9]+$/;

const METADATA_BASE = 'http://metadata.google.internal/computeMetadata/v1';
const METADATA_HEADERS = { 'Metadata-Flavor': 'Google' };
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';
const SEARCH_BATCH_SIZE = 5;

// ─── Internal types ───────────────────────────────────────────────────────────

export interface ConferenceEntryPoint { uri?: string }
export interface CalendarAttendee { email?: string; responseStatus?: string }

export interface CalendarEvent {
  id?: string;
  hangoutLink?: string;
  attendees?: CalendarAttendee[];
  conferenceData?: { entryPoints?: ConferenceEntryPoint[] };
  start?: { dateTime?: string; date?: string };
  organizer?: { email?: string };
}

export interface FoundEvent {
  event: CalendarEvent;
  calendarId: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function extractMeetingCode(link: string): string {
  return link.trim().split('/').pop() || '';
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

interface ServiceAccountKey {
  client_email?: string;
  private_key?: string;
}

/**
 * Caminho LOCAL (dev): se GOOGLE_APPLICATION_CREDENTIALS aponta pra um arquivo de
 * chave de SA com private_key, assina o JWT DWD localmente (RS256) e troca por
 * access_token. Em Cloud Run essa env NÃO está setada → retorna null e o
 * chamador cai no caminho metadata+signJwt (keyless). NUNCA usado em prod.
 */
async function getLocalDwdToken(subject: string): Promise<string | null> {
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyPath || !existsSync(keyPath)) return null;

  let key: ServiceAccountKey;
  try {
    key = JSON.parse(readFileSync(keyPath, 'utf8')) as ServiceAccountKey;
  } catch (err: unknown) {
    console.warn('[GoogleCalendarService] could not parse GOOGLE_APPLICATION_CREDENTIALS:', err instanceof Error ? err.message : err);
    return null;
  }
  if (!key.private_key || !key.client_email) return null;

  try {
    const now = Math.floor(Date.now() / 1000);
    const assertion = jwt.sign(
      {
        iss: key.client_email,
        sub: subject,
        scope: CALENDAR_SCOPE,
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
      },
      key.private_key,
      { algorithm: 'RS256' },
    );

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });
    if (!tokenRes.ok) {
      const detail = await tokenRes.text().catch(() => '');
      console.warn(`[GoogleCalendarService] local token exchange error ${tokenRes.status}: ${detail}`);
      return null;
    }
    const { access_token } = (await tokenRes.json()) as { access_token: string };
    return access_token ?? null;
  } catch (err: unknown) {
    console.warn('[GoogleCalendarService] local DWD sign error:', err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Obtém access token impersonando via signJwt (Domain-Wide Delegation).
 * No Cloud Run, GoogleAuth ignora clientOptions.subject — por isso usamos
 * metadata server → signJwt → token exchange.
 * LOCAL (dev): se GOOGLE_APPLICATION_CREDENTIALS existe, assina o JWT localmente.
 */
export async function getAccessToken(subjectEmail: string, fallbackEmail: string): Promise<string | null> {
  const subject = subjectEmail || fallbackEmail;
  if (!subject) {
    console.warn('[GoogleCalendarService] GOOGLE_CALENDAR_IMPERSONATE_EMAIL not set');
    return null;
  }

  // Caminho LOCAL (dev) — só dispara se a chave de SA estiver presente.
  const localToken = await getLocalDwdToken(subject);
  if (localToken) return localToken;

  try {
    const [saEmailRes, saTokenRes] = await Promise.all([
      fetch(`${METADATA_BASE}/instance/service-accounts/default/email`, { headers: METADATA_HEADERS }),
      fetch(`${METADATA_BASE}/instance/service-accounts/default/token`, { headers: METADATA_HEADERS }),
    ]);
    if (!saEmailRes.ok || !saTokenRes.ok) {
      console.warn('[GoogleCalendarService] metadata server error');
      return null;
    }
    const saEmail = await saEmailRes.text();
    const { access_token: saToken } = (await saTokenRes.json()) as { access_token: string };

    const now = Math.floor(Date.now() / 1000);
    const claimSet = {
      iss: saEmail,
      sub: subject,
      scope: CALENDAR_SCOPE,
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    };

    const signRes = await fetch(
      `https://iam.googleapis.com/v1/projects/-/serviceAccounts/${saEmail}:signJwt`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload: JSON.stringify(claimSet) }),
      },
    );
    if (!signRes.ok) {
      const detail = await signRes.text().catch(() => '');
      console.warn(`[GoogleCalendarService] signJwt error ${signRes.status}: ${detail}`);
      return null;
    }
    const { signedJwt } = (await signRes.json()) as { signedJwt: string };

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: signedJwt,
      }),
    });
    if (!tokenRes.ok) {
      const detail = await tokenRes.text().catch(() => '');
      console.warn(`[GoogleCalendarService] token exchange error ${tokenRes.status}: ${detail}`);
      return null;
    }
    const { access_token } = (await tokenRes.json()) as { access_token: string };
    return access_token ?? null;
  } catch (err: unknown) {
    console.warn('[GoogleCalendarService] Auth error:', err instanceof Error ? err.message : err);
    return null;
  }
}

// ─── Event search ─────────────────────────────────────────────────────────────

/** Lista emails dos staff do domínio a partir da tabela users (sem Admin SDK). */
export async function listStaffEmails(db: Pool, impersonateEmail: string): Promise<string[]> {
  const domain = impersonateEmail.split('@')[1];
  if (!domain) return [];

  try {
    const result = await db.query<{ email: string }>(
      `SELECT DISTINCT email FROM users
       WHERE email LIKE $1 AND is_active = true
         AND role IN ('admin', 'recruiter', 'community_manager')`,
      [`%@${domain}`],
    );
    const emails = result.rows.map((r) => r.email);
    console.log(`[GoogleCalendarService] Staff emails from DB: ${emails.length}`);
    return emails;
  } catch (err: unknown) {
    console.warn('[GoogleCalendarService] DB staff query error:', err instanceof Error ? err.message : err);
    return [];
  }
}

/** Busca evento com Meet code em um calendário. Filtra por hangoutLink/conferenceData.
 *  Se targetDate fornecido, retorna a instância mais próxima dessa data (para eventos recorrentes). */
export async function searchCalendarForMeet(
  calendarId: string,
  meetingCode: string,
  timeMin: string,
  timeMax: string,
  token: string,
  signal?: AbortSignal,
  targetDate?: string,
): Promise<FoundEvent | null> {
  const params = new URLSearchParams({
    maxResults: '250',
    singleEvents: 'true',
    orderBy: 'startTime',
    timeMin,
    timeMax,
    fields: 'items(id,hangoutLink,conferenceData,start,attendees,organizer)',
  });

  try {
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`,
      { headers: { Authorization: `Bearer ${token}` }, signal },
    );
    if (!res.ok) return null;

    const data = (await res.json()) as { items?: CalendarEvent[] };
    const matching = (data.items ?? []).filter((ev) => {
      if (ev.hangoutLink?.includes(meetingCode)) return true;
      return (ev.conferenceData?.entryPoints ?? []).some((ep) => ep.uri?.includes(meetingCode));
    });

    if (matching.length === 0) return null;

    if (targetDate && matching.length > 1) {
      const target = new Date(targetDate).getTime();
      let closest = matching[0];
      let closestDiff = Infinity;
      for (const ev of matching) {
        const evTime = new Date(ev.start?.dateTime ?? ev.start?.date ?? '').getTime();
        const diff = Math.abs(evTime - target);
        if (diff < closestDiff) {
          closestDiff = diff;
          closest = ev;
        }
      }
      return { event: closest, calendarId };
    }

    return { event: matching[0], calendarId };
  } catch {
    return null;
  }
}

/**
 * Busca em lotes de SEARCH_BATCH_SIZE calendários em paralelo.
 * Aborta todas as requests pendentes assim que encontra o evento.
 */
export async function searchCalendarsUntilFound(
  calendarIds: string[],
  meetingCode: string,
  timeMin: string,
  timeMax: string,
  token: string,
  targetDate?: string,
): Promise<FoundEvent | null> {
  let found: FoundEvent | null = null;
  const abortController = new AbortController();

  for (let i = 0; i < calendarIds.length && !found; i += SEARCH_BATCH_SIZE) {
    const batch = calendarIds.slice(i, i + SEARCH_BATCH_SIZE);
    await Promise.all(
      batch.map(async (calId) => {
        if (found || abortController.signal.aborted) return;
        const result = await searchCalendarForMeet(
          calId, meetingCode, timeMin, timeMax, token, abortController.signal, targetDate,
        );
        if (result && !found) {
          found = result;
          abortController.abort();
        }
      }),
    );
  }

  return found;
}

/**
 * Busca evento pelo Meet link em duas fases:
 *   1. Calendários no calendarList do impersonateEmail (compartilhados/inscritos)
 *   2. Calendário primário de cada staff do domínio (via DB)
 */
export async function findEventByMeetLink(
  meetLink: string,
  token: string,
  db: Pool,
  impersonateEmail: string,
  targetDate?: string,
): Promise<FoundEvent | null> {
  const meetingCode = extractMeetingCode(meetLink);
  const now = new Date();
  const timeMin = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString();

  const calListRes = await fetch(
    'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250',
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const calIds: string[] = calListRes.ok
    ? ((await calListRes.json()) as { items?: { id?: string }[] }).items
        ?.map((c) => c.id)
        .filter((id): id is string => !!id) ?? []
    : [];
  console.log(`[GoogleCalendarService] Phase 1: searching ${calIds.length} subscribed calendars`);

  const phase1 = await searchCalendarsUntilFound(calIds, meetingCode, timeMin, timeMax, token, targetDate);
  if (phase1) return phase1;

  const staffEmails = await listStaffEmails(db, impersonateEmail);
  const searched = new Set(calIds);
  const unsearched = staffEmails.filter((e) => !searched.has(e));
  console.log(`[GoogleCalendarService] Phase 2: searching ${unsearched.length} staff calendars`);

  return searchCalendarsUntilFound(unsearched, meetingCode, timeMin, timeMax, token, targetDate);
}
