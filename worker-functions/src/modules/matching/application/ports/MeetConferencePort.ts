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

/**
 * Quem entrou na conferência (`conferenceRecords.participants`, spec 052 T-34c). `displayName` é o nome exibido no Meet (dado pessoal:
 * serve só para ligar ao convocado, NUNCA vai a log, trilha nem resposta). `identityKey` só existe para deduplicar o mesmo participante
 * que caiu e voltou (`users/{id}` do Google no `signedin`) — também nunca sai do processo. Sem e-mail: o recurso não o traz.
 */
export type MeetParticipantKind = 'signedin' | 'anonymous' | 'phone';
export interface MeetParticipant {
  kind: MeetParticipantKind;
  displayName: string | null;
  identityKey: string | null;
}

export interface MeetConferencePort {
  /** Código do Meet (`abc-defg-hij`) → `spaces/{id}` estável (o código expira ~365 dias depois do último uso). */
  resolveSpace(meetCode: string, subjectEmail: string): Promise<{ spaceName: string }>;
  /** Todas as conferências do espaço (queda e retorno geram mais de uma). Vazia = ninguém entrou. */
  listConferenceRecords(spaceName: string, subjectEmail: string): Promise<MeetConferenceRecord[]>;
  /** Participantes de UMA conferência (`conferenceRecords/{id}`), todas as páginas. Só o enquadre usa (a admissão não mede presença). */
  listParticipants(conferenceRecordName: string, subjectEmail: string): Promise<MeetParticipant[]>;
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
