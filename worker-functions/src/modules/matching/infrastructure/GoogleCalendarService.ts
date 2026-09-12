import { Pool } from 'pg';
import { redactContact, safeErrorFields } from '@shared/logging';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import {
  MEET_LINK_REGEX,
  CalendarAttendee,
  FoundEvent,
  extractMeetingCode,
  getAccessToken,
  findEventByMeetLink,
} from './GoogleCalendarEventFinder';

export type AddGuestResult =
  | { success: true }
  | { success: false; reason: 'invalid_link' | 'invalid_email' | 'event_not_found' | 'already_invited' | 'auth_error' | 'api_error'; detail?: string };

export type RemoveGuestResult =
  | { success: true }
  | { success: false; reason: 'invalid_link' | 'invalid_email' | 'event_not_found' | 'not_invited' | 'auth_error' | 'api_error'; detail?: string };

export type ConfirmAttendeeResult =
  | { success: true }
  | { success: false; reason: 'invalid_link' | 'invalid_email' | 'event_not_found' | 'not_invited' | 'auth_error' | 'api_error'; detail?: string };

export class GoogleCalendarService {
  private impersonateEmail: string;
  private _db: Pool | null = null;

  private get db(): Pool {
    if (!this._db) {
      this._db = DatabaseConnection.getInstance().getPool();
    }
    return this._db;
  }

  constructor() {
    this.impersonateEmail = process.env.GOOGLE_CALENDAR_IMPERSONATE_EMAIL || '';
  }

  isValidMeetLink(link: string): boolean {
    return MEET_LINK_REGEX.test(link.trim());
  }

  extractMeetingCode(link: string): string {
    return extractMeetingCode(link);
  }

  private getToken(subjectEmail?: string): Promise<string | null> {
    return getAccessToken(subjectEmail ?? this.impersonateEmail, this.impersonateEmail);
  }

  private findEvent(meetLink: string, token: string, targetDate?: string): Promise<FoundEvent | null> {
    return findEventByMeetLink(meetLink, token, this.db, this.impersonateEmail, targetDate);
  }

  // ─── Public methods ──────────────────────────────────────────────────────────

  async resolveDateTime(meetLink: string): Promise<string | null> {
    if (!meetLink || !this.isValidMeetLink(meetLink)) return null;

    if (process.env.USE_MOCK_GOOGLE_CALENDAR === 'true') {
      return '2026-04-05T14:00:00-03:00';
    }

    try {
      const token = await this.getToken();
      if (!token) return null;

      const found = await this.findEvent(meetLink, token);
      if (!found) {
        console.warn(`[GoogleCalendarService] No event found for: ${extractMeetingCode(meetLink)}`);
        return null;
      }

      return found.event.start?.dateTime ?? found.event.start?.date ?? null;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[GoogleCalendarService] resolveDateTime error: ${msg}`);
      return null;
    }
  }

  async addGuestToMeeting(meetLink: string, guestEmail: string, sendInvite = true, targetDate?: string): Promise<AddGuestResult> {
    if (!meetLink || !this.isValidMeetLink(meetLink)) return { success: false, reason: 'invalid_link' };
    if (!guestEmail || !guestEmail.includes('@')) return { success: false, reason: 'invalid_email' };
    if (process.env.USE_MOCK_GOOGLE_CALENDAR === 'true') return { success: true };

    try {
      const token = await this.getToken();
      if (!token) return { success: false, reason: 'auth_error' };

      const meetingCode = extractMeetingCode(meetLink);
      const found = await this.findEvent(meetLink, token, targetDate);
      if (!found?.event.id) {
        console.warn(`[GoogleCalendarService] No event found for meet code: ${meetingCode}`);
        return { success: false, reason: 'event_not_found' };
      }

      const organizerEmail = found.event.organizer?.email;
      // PII (C1, 11/09): organizerEmail mascarado — não é o worker, é o colaborador
      // dono do evento, mas ainda é PII de pessoa (Ley 25.326).
      console.log(`[GoogleCalendarService] Found event: id=${found.event.id} calendar=${found.calendarId} organizer=${organizerEmail ? redactContact(organizerEmail, 'email') : 'unknown'}`);

      const currentAttendees = found.event.attendees ?? [];
      const normalized = guestEmail.trim().toLowerCase();

      if (currentAttendees.some((a) => a.email?.toLowerCase() === normalized)) {
        return { success: false, reason: 'already_invited' };
      }

      let patchToken = token;
      if (organizerEmail && organizerEmail !== this.impersonateEmail) {
        const orgToken = await this.getToken(organizerEmail);
        if (orgToken) {
          patchToken = orgToken;
        } else {
          console.warn(`[GoogleCalendarService] Could not get organizer token for ${redactContact(organizerEmail, 'email')}, using default`);
        }
      }

      const updatedAttendees = [...currentAttendees, { email: normalized }];
      const sendUpdates = sendInvite ? 'externalOnly' : 'none';

      const result = await this.patchEventAttendees(found.calendarId, found.event.id, updatedAttendees, sendUpdates, patchToken);
      if (result.ok) {
        console.log(`[GoogleCalendarService] PATCH success: added ${redactContact(normalized, 'email')} to event ${found.event.id} (via ${organizerEmail ? redactContact(organizerEmail, 'email') : 'default'})`);
      }
      return result.ok ? { success: true } : { success: false, reason: 'api_error', detail: `HTTP ${result.status}` };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // PII (C1, 11/09): a mensagem do erro pode ecoar o e-mail que o Google rejeitou
      // (ex.: "Invalid email: <valor>") — nunca a message crua, só errorName+código.
      console.warn('[GoogleCalendarService] addGuestToMeeting error:', safeErrorFields(err));
      return { success: false, reason: 'api_error', detail: msg };
    }
  }

  async confirmAttendee(meetLink: string, guestEmail: string, targetDate?: string): Promise<ConfirmAttendeeResult> {
    if (!meetLink || !this.isValidMeetLink(meetLink)) return { success: false, reason: 'invalid_link' };
    if (!guestEmail || !guestEmail.includes('@')) return { success: false, reason: 'invalid_email' };
    if (process.env.USE_MOCK_GOOGLE_CALENDAR === 'true') return { success: true };

    try {
      const token = await this.getToken();
      if (!token) return { success: false, reason: 'auth_error' };

      const found = await this.findEvent(meetLink, token, targetDate);
      if (!found?.event.id) return { success: false, reason: 'event_not_found' };

      const currentAttendees = found.event.attendees ?? [];
      const normalized = guestEmail.trim().toLowerCase();
      const attendeeIndex = currentAttendees.findIndex((a) => a.email?.toLowerCase() === normalized);

      if (attendeeIndex === -1) return { success: false, reason: 'not_invited' };

      const updatedAttendees = currentAttendees.map((a, i) =>
        i === attendeeIndex ? { ...a, responseStatus: 'accepted' } : a,
      );

      let patchToken = token;
      const organizerEmail = found.event.organizer?.email;
      if (organizerEmail && organizerEmail !== this.impersonateEmail) {
        const orgToken = await this.getToken(organizerEmail);
        if (orgToken) patchToken = orgToken;
      }

      const result = await this.patchEventAttendees(found.calendarId, found.event.id, updatedAttendees, 'none', patchToken);
      if (result.ok) {
        console.log(`[GoogleCalendarService] PATCH success: confirmed ${normalized} on event ${found.event.id}`);
      }
      return result.ok ? { success: true } : { success: false, reason: 'api_error', detail: `HTTP ${result.status}` };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[GoogleCalendarService] confirmAttendee error:', msg);
      return { success: false, reason: 'api_error', detail: msg };
    }
  }

  async declineAttendee(meetLink: string, guestEmail: string, targetDate?: string): Promise<ConfirmAttendeeResult> {
    if (!meetLink || !this.isValidMeetLink(meetLink)) return { success: false, reason: 'invalid_link' };
    if (!guestEmail || !guestEmail.includes('@')) return { success: false, reason: 'invalid_email' };
    if (process.env.USE_MOCK_GOOGLE_CALENDAR === 'true') return { success: true };

    try {
      const token = await this.getToken();
      if (!token) return { success: false, reason: 'auth_error' };

      const found = await this.findEvent(meetLink, token, targetDate);
      if (!found?.event.id) return { success: false, reason: 'event_not_found' };

      const currentAttendees = found.event.attendees ?? [];
      const normalized = guestEmail.trim().toLowerCase();
      const attendeeIndex = currentAttendees.findIndex((a) => a.email?.toLowerCase() === normalized);

      if (attendeeIndex === -1) return { success: false, reason: 'not_invited' };

      const updatedAttendees = currentAttendees.map((a, i) =>
        i === attendeeIndex ? { ...a, responseStatus: 'declined' } : a,
      );

      let patchToken = token;
      const organizerEmail = found.event.organizer?.email;
      if (organizerEmail && organizerEmail !== this.impersonateEmail) {
        const orgToken = await this.getToken(organizerEmail);
        if (orgToken) patchToken = orgToken;
      }

      const result = await this.patchEventAttendees(found.calendarId, found.event.id, updatedAttendees, 'none', patchToken);
      if (result.ok) {
        console.log(`[GoogleCalendarService] PATCH success: declined ${normalized} on event ${found.event.id}`);
      }
      return result.ok ? { success: true } : { success: false, reason: 'api_error', detail: `HTTP ${result.status}` };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[GoogleCalendarService] declineAttendee error:', msg);
      return { success: false, reason: 'api_error', detail: msg };
    }
  }

  async removeGuestFromMeeting(meetLink: string, guestEmail: string, targetDate?: string): Promise<RemoveGuestResult> {
    if (!meetLink || !this.isValidMeetLink(meetLink)) return { success: false, reason: 'invalid_link' };
    if (!guestEmail || !guestEmail.includes('@')) return { success: false, reason: 'invalid_email' };
    if (process.env.USE_MOCK_GOOGLE_CALENDAR === 'true') return { success: true };

    try {
      const token = await this.getToken();
      if (!token) return { success: false, reason: 'auth_error' };

      const found = await this.findEvent(meetLink, token, targetDate);
      if (!found?.event.id) return { success: false, reason: 'event_not_found' };

      const currentAttendees = found.event.attendees ?? [];
      const normalized = guestEmail.trim().toLowerCase();
      const filtered = currentAttendees.filter((a) => a.email?.toLowerCase() !== normalized);

      if (filtered.length === currentAttendees.length) return { success: false, reason: 'not_invited' };

      let patchToken = token;
      const organizerEmail = found.event.organizer?.email;
      if (organizerEmail && organizerEmail !== this.impersonateEmail) {
        const orgToken = await this.getToken(organizerEmail);
        if (orgToken) patchToken = orgToken;
      }

      const result = await this.patchEventAttendees(found.calendarId, found.event.id, filtered, 'none', patchToken);
      return result.ok ? { success: true } : { success: false, reason: 'api_error', detail: `HTTP ${result.status}` };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[GoogleCalendarService] removeGuestFromMeeting error:', msg);
      return { success: false, reason: 'api_error', detail: msg };
    }
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private async patchEventAttendees(
    calendarId: string,
    eventId: string,
    attendees: CalendarAttendee[],
    sendUpdates: string,
    token: string,
  ): Promise<{ ok: boolean; status: number }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${eventId}?sendUpdates=${sendUpdates}`,
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ attendees }),
          signal: controller.signal,
        },
      );
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        console.warn(`[GoogleCalendarService] PATCH error ${res.status}: ${detail}`);
      }
      return { ok: res.ok, status: res.status };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const googleCalendarService = new GoogleCalendarService();
