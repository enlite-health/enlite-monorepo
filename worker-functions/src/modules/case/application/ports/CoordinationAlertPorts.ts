/**
 * Portas do alerta à coordenação (emenda 077 §5). Tudo que o `CoordinationAlertUseCase` precisa do mundo de fora entra por aqui;
 * os adapters moram em `infrastructure/`. Sem nome, endereço, coordenada nem dado clínico em NENHUM tipo desta porta: só ids, horários e país.
 */
export type CoordinationAlertKind = 'PRESENCE_OPEN_4H' | 'CHECK_IN_REFUSED_NO_ENTRY';
export type DeliveryChannelCode = 'IN_APP' | 'EMAIL';
export type DeliveryStatus = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'SKIPPED_TEST' | 'SKIPPED_NO_KEY' | 'NO_ADDRESS';

/** O turno (ocorrência do itinerário) que o alerta cobre. `startTime`/`endTime` = hora local do país (`HH:MM`), para o texto do aviso. */
export interface ShiftFacts {
  occurrenceId: string;
  slotId: string;
  onDate: string;
  workerId: string;
  serviceId: string;
  patientId: string;
  country: string;
  startsAt: string;
  endsAt: string;
  startTime: string;
  endTime: string;
  /** `workers.is_test` OU `patients.is_test` (D664): alerta nunca é emitido. */
  isTest: boolean;
}

/** Ocorrência `OPEN` no attendance (check-in aceito, sem saída). */
export interface OpenPresenceRecord {
  occurrenceId: string;
  workerId: string;
  slotId: string;
  onDate: string;
}

/** Ocorrência com tentativa de check-in recusada e nenhum check-in aceito; `firstRefusedAt` = instante da 1ª recusa. */
export interface RefusedWithoutEntryRecord {
  occurrenceId: string;
  workerId: string;
  firstRefusedAt: string;
}

/** Dono: o attendance. Lança `PresenceUnavailableError` se estiver fora do ar (vira 500 e o Scheduler re-tenta). */
export interface AttendancePresenceAlertReader {
  openPresence(onDateFrom: string): Promise<OpenPresenceRecord[]>;
  refusedWithoutEntry(since: Date): Promise<RefusedWithoutEntryRecord[]>;
}

/** Dono: o itinerário (WF). Só devolve a ocorrência que EXISTE no itinerário do prestador; o resto fica de fora (R1/R3 vão para a fila, §6). */
export interface ShiftDirectory {
  resolve(candidates: ReadonlyArray<{ occurrenceId: string; workerId: string }>, window: { from: string; to: string }): Promise<Map<string, ShiftFacts>>;
}

export interface AlertRecipient {
  uid: string;
  email: string | null;
  /** Países cujos pacientes ele pode ver (mesmo escopo do "Sin cubrir"). */
  countries: string[];
}

/** Quem recebe: célula `presence_alert:receive` OU Acesso Master. */
export interface AlertRecipientResolver {
  resolve(): Promise<AlertRecipient[]>;
}

export interface AlertToDeliver {
  alertId: string;
  kind: CoordinationAlertKind;
  shift: ShiftFacts;
}

export interface DeliveryOutcome {
  status: Exclude<DeliveryStatus, 'PENDING' | 'SENDING'>;
  /** Só com `FAILED`: código curto, nunca a mensagem do provedor (pode ecoar o endereço). */
  errorCode?: string;
  /** Só do canal IN_APP: o evento de notificação (a entrega o referencia). */
  notificationEventId?: string;
}

/** Transação opaca do alerta: o canal in-app a recebe para gravar o aviso na MESMA transação; os demais a ignoram. */
export type DeliveryTx = unknown;

export interface CoordinationAlertChannel {
  readonly channel: DeliveryChannelCode;
  deliver(alert: AlertToDeliver, recipient: AlertRecipient, tx?: DeliveryTx): Promise<DeliveryOutcome>;
}

export interface AlertTransaction {
  readonly handle: DeliveryTx;
  /** `null` = o turno já tinha este alerta (UNIQUE (kind, occurrence_id)): nada novo. */
  insertAlertIfAbsent(kind: CoordinationAlertKind, occurrenceId: string): Promise<string | null>;
  recordDelivery(row: { alertId: string; recipientUid: string; channel: DeliveryChannelCode; status: DeliveryStatus; errorCode?: string; notificationEventId?: string }): Promise<void>;
}

export interface CoordinationAlertStore {
  inTransaction<T>(work: (tx: AlertTransaction) => Promise<T>): Promise<T>;
  /** Reivindica a entrega `PENDING` → `SENDING` (UPDATE atômico). `false` = outra execução a reivindicou. */
  claimDelivery(alertId: string, recipientUid: string, channel: DeliveryChannelCode): Promise<boolean>;
  markDelivery(alertId: string, recipientUid: string, channel: DeliveryChannelCode, outcome: DeliveryOutcome): Promise<void>;
}
