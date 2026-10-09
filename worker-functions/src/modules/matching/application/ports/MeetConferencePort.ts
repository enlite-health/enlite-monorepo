/**
 * Porta da Meet REST API (spec 049 F5, §3.3 "Quando a call termina — pelo Google, não pelo Tactiq").
 *
 * O fim REAL da call vem do `conferenceRecords.list` do Google, não da hora marcada nem do Tactiq. Tudo passa por esta
 * porta: em teste entra dublê (`FakeMeetConference`) e o adapter real lança no construtor com NODE_ENV=test.
 * `subjectEmail` é o responsável da reunião (a delegação de domínio impersona quem criou o evento).
 */

export interface MeetConferenceRecord {
  /** `conferenceRecords/{id}` — só id; vai para a trilha, nunca nome de participante. */
  name: string;
  startTime: Date;
  /** `null` = a conferência ainda está aberta ("unset if the conference is ongoing"). */
  endTime: Date | null;
}

export interface MeetConferencePort {
  /** Código do Meet (`abc-defg-hij`) → `spaces/{id}` estável (o código expira ~365 dias depois do último uso). */
  resolveSpace(meetCode: string, subjectEmail: string): Promise<{ spaceName: string }>;
  /** Todas as conferências do espaço (queda e retorno geram mais de uma). Vazia = ninguém entrou. */
  listConferenceRecords(spaceName: string, subjectEmail: string): Promise<MeetConferenceRecord[]>;
}

/**
 * O Workspace NÃO delegou `meetings.space.readonly` à conta de serviço (`unauthorized_client`) ou o Google devolveu 403.
 * É o H2 da spec: a reunião fica `blocked reason=meet_scope_missing` — NUNCA confundida com "ninguém entrou" (`no_show`).
 */
export class MeetScopeMissingError extends Error {
  readonly code = 'meet_scope_missing';
  constructor() {
    super('meet_scope_missing');
    this.name = 'MeetScopeMissingError';
  }
}

/** Rede, 5xx, 404, token indisponível: não prova nada sobre a reunião. O job tenta de novo na próxima execução. */
export class MeetTransientError extends Error {
  constructor(readonly reason: string) {
    super(`meet_transient:${reason}`);
    this.name = 'MeetTransientError';
  }
}
