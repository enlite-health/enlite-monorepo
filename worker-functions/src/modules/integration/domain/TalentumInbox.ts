/**
 * TalentumInbox — domínio da inbox do webhook do Talentum (spec 095 §3.2, tabela `talentum_webhook_inbox`).
 *
 * A inbox é dona só de "o que o Talentum nos mandou e quando". O status do espelho é de
 * `talentum_prescreenings`; ninguém lê a inbox para decidir etapa.
 *
 * O port (`ITalentumInboxRepository`) mora aqui; o adapter pg + KMS, em
 * `infrastructure/TalentumInboxRepository.ts`. O `payload` tem PII: nunca vai a log.
 */
import { createHash } from 'crypto';

export type TalentumInboxState = 'RECEIVED' | 'PROCESSED' | 'FAILED' | 'REJECTED_SCHEMA' | 'UNSUPPORTED';

/** Mínimo de uma conexão pg (Pool ou PoolClient): o lock e as leituras da chave rodam na transação do chamador. */
export interface InboxQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: any[] }>;
}

export interface InsertReceivedParams {
  bodyHash: string;
  action: string;
  subtype: string | null;
  statusLabel: string | null;
  prescreeningId: string | null;
  profileId: string | null;
  environment: 'production' | 'test';
  ingressHost: string | null;
  /** Corpo cru do webhook (PII). O adapter cifra antes de gravar. */
  payload: unknown;
}

export interface InsertReceivedResult {
  id: string;
  duplicate: boolean;
}

export interface TalentumInboxRow {
  id: string;
  receivedAt: Date;
  action: string;
  subtype: string | null;
  /** Chave de ordenação/lock (colunas `talentum_prescreening_id`/`talentum_profile_id`); nulas em ação desconhecida. */
  talentumPrescreeningId: string | null;
  talentumProfileId: string | null;
  environment: 'production' | 'test';
  state: TalentumInboxState;
  attempts: number;
  /** Corpo cifrado (nulo depois da poda). Decifrar com `decryptPayload`. */
  payloadEnc: string | null;
}

export interface ITalentumInboxRepository {
  insertReceived(params: InsertReceivedParams): Promise<InsertReceivedResult>;
  /** `pg_advisory_xact_lock` da chave (prescreening, profile): vale até o fim da transação de `client`. */
  lockKey(client: InboxQueryable, prescreeningId: string | null, profileId: string | null): Promise<void>;
  /** Uma linha pelo id (qualquer estado), ou `null` se não existe. */
  findById(client: InboxQueryable, id: string): Promise<TalentumInboxRow | null>;
  /**
   * Linhas `RECEIVED` da chave, da mais antiga para a mais nova (`received_at`). `alsoIds`: linhas pedidas
   * explicitamente que entram mesmo fora de `RECEIVED` (reentrega de `FAILED`, redrive de `UNSUPPORTED`/`REJECTED_SCHEMA`),
   * exceto `PROCESSED`.
   */
  pendingForKey(
    client: InboxQueryable, prescreeningId: string | null, profileId: string | null, alsoIds?: string[],
  ): Promise<TalentumInboxRow[]>;
  decryptPayload(row: Pick<TalentumInboxRow, 'payloadEnc'>): Promise<unknown>;
  markProcessed(client: InboxQueryable, id: string): Promise<void>;
  /** `errorCode` sem PII (code/constraint do pg). */
  markFailed(client: InboxQueryable, id: string, errorCode: string): Promise<void>;
  markState(
    client: InboxQueryable,
    id: string,
    state: Exclude<TalentumInboxState, 'RECEIVED' | 'PROCESSED'>,
    errorCode: string | null,
  ): Promise<void>;
}

/** JSON canônico: chaves de objeto em ordem alfabética (recursivo); a ordem dos arrays é preservada. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const parts = Object.keys(obj)
    .sort()
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${parts.join(',')}}`;
}

/** Chave de dedup (UNIQUE): sha256 do corpo canônico. Não existe id de evento no payload do Talentum (spec §3.2 item 4). */
export function computeBodyHash(body: unknown): string {
  return createHash('sha256').update(canonicalJson(body)).digest('hex');
}
