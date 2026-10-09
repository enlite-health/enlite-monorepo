import {
  MeetScopeMissingError,
  MeetTransientError,
  type MeetConferencePort,
  type MeetConferenceRecord,
} from '../application/ports/MeetConferencePort';
import { AdmissionRealAdapterInTestError } from '../application/ports/AdmissionMessagingPorts';
import { MEET_SCOPE, requestDwdAccessToken } from './GoogleCalendarEventFinder';

const MEET_BASE = 'https://meet.googleapis.com/v2';
const CALL_TIMEOUT_MS = 10_000;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

/**
 * Cliente REAL da Meet REST API, por delegação de domínio com token PRÓPRIO (escopo `meetings.space.readonly` sozinho:
 * somado ao do Calendar derrubaria o agendamento enquanto o H2 está aberto — spec 049 T3). Nunca loga corpo de resposta.
 *
 *  - troca do token falha com `unauthorized_client` ou o Google responde 403 → `MeetScopeMissingError` (H2);
 *  - qualquer outra falha (rede, 5xx, 404, metadata) → `MeetTransientError`.
 *
 * ⚠️ Lança no construtor com NODE_ENV=test: teste nunca toca o Google.
 */
export class GoogleMeetConferenceClient implements MeetConferencePort {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {
    if (this.env.NODE_ENV === 'test') throw new AdmissionRealAdapterInTestError('new GoogleMeetConferenceClient()');
  }

  async resolveSpace(meetCode: string, subjectEmail: string): Promise<{ spaceName: string }> {
    const body = await this.get(`/spaces/${encodeURIComponent(meetCode)}`, subjectEmail);
    const name = (body as { name?: unknown }).name;
    if (typeof name !== 'string' || !name.startsWith('spaces/')) throw new MeetTransientError('space_malformed');
    return { spaceName: name };
  }

  async listConferenceRecords(spaceName: string, subjectEmail: string): Promise<MeetConferenceRecord[]> {
    const out: MeetConferenceRecord[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const params = new URLSearchParams({ filter: `space.name = "${spaceName}"`, pageSize: String(PAGE_SIZE) });
      if (pageToken) params.set('pageToken', pageToken);
      const body = (await this.get(`/conferenceRecords?${params}`, subjectEmail)) as {
        conferenceRecords?: Array<{ name?: string; startTime?: string; endTime?: string }>;
        nextPageToken?: string;
      };
      for (const r of body.conferenceRecords ?? []) {
        if (typeof r.name !== 'string' || typeof r.startTime !== 'string') throw new MeetTransientError('record_malformed');
        out.push({ name: r.name, startTime: new Date(r.startTime), endTime: r.endTime ? new Date(r.endTime) : null });
      }
      pageToken = body.nextPageToken || undefined;
      if (!pageToken) return out;
    }
    // Mais páginas do que o teto: lista incompleta NÃO pode virar "a call acabou" nem "ninguém entrou".
    throw new MeetTransientError('too_many_pages');
  }

  private async get(path: string, subjectEmail: string): Promise<unknown> {
    const tokenRes = await requestDwdAccessToken(subjectEmail, subjectEmail, MEET_SCOPE);
    if ('error' in tokenRes) {
      if (tokenRes.error === 'unauthorized_client') throw new MeetScopeMissingError();
      throw new MeetTransientError('token_unavailable');
    }
    let res: Response;
    try {
      res = await fetch(`${MEET_BASE}${path}`, {
        headers: { Authorization: `Bearer ${tokenRes.token}` },
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch {
      throw new MeetTransientError('network');
    }
    if (res.status === 403) throw new MeetScopeMissingError();
    if (!res.ok) throw new MeetTransientError(`http_${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new MeetTransientError('body_not_json');
    }
  }
}
