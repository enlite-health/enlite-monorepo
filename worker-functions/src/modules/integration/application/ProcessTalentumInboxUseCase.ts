/**
 * ProcessTalentumInboxUseCase — processador da inbox do webhook do Talentum (spec 095 §3.2).
 *
 * Roda DEPOIS do ack (Pub/Sub push só com o `inboxId`): lê a linha, toma o lock da chave
 * `(talentum_prescreening_id, talentum_profile_id)` e processa TODAS as `RECEIVED` da chave por `received_at`
 * (a mais antiga primeiro). Isso também recolhe órfã de `publish` que falhou, sem timer: o próximo evento da
 * mesma chave a leva junto.
 *
 * LOCK (T-095-30, escolha justificada): `pg_advisory_xact_lock` numa transação externa (`withActorContext`), e NÃO
 * `pg_advisory_lock`/`unlock` de sessão em `finally`.
 *  - O `ProcessTalentumPrescreening` abre transações PRÓPRIAS (outras conexões do pool); o lock só precisa estar
 *    tomado de ponta a ponta, e a transação externa o segura do `lockKey` até o COMMIT, envolvendo todas elas.
 *  - Lock de sessão num client do pool vaza se o `unlock` falhar (a conexão volta ao pool ainda segurando a chave e
 *    ninguém mais a processa até o reciclo). O `xact_lock` é solto pelo próprio Postgres no COMMIT/ROLLBACK/queda.
 *  - Falha de linha NÃO desfaz as marcas: o erro da linha é capturado dentro da transação (SAVEPOINT por linha),
 *    a linha vira `FAILED`, a transação faz COMMIT (as `PROCESSED` anteriores e o `FAILED` ficam duráveis) e SÓ
 *    DEPOIS o erro original é relançado, para o Pub/Sub reentregar.
 *
 * Nada aqui loga o corpo (PII): só ids, enums e contagens. `error_code` é só `code`/`constraint` do pg.
 */
import type { Pool } from 'pg';
import { withActorContext } from '@shared/database/actorContext';
import type { ITalentumInboxRepository, TalentumInboxRow } from '../domain/TalentumInbox';
import {
  TalentumPrescreeningPayloadSchema,
  type TalentumPrescreeningResponseParsed,
} from '../interfaces/webhooks/validators/talentumPrescreeningSchema';

const TAG = '[TalentumInbox:Process]';

export type TalentumEnvironment = 'production' | 'test';

/** Port do caso de uso de resposta de prescreening (`ProcessTalentumPrescreening`, módulo matching), sem cópia de lógica. */
export interface ITalentumPrescreeningProcessor {
  execute(payload: TalentumPrescreeningResponseParsed, options?: { environment?: TalentumEnvironment }): Promise<unknown>;
}

/** Port da criação de vaga por evento `PRESCREENING` (`CreateJobPostingFromTalentumUseCase`). */
export interface IJobPostingFromTalentumCreator {
  execute(data: { _id: string; name: string }, environment: TalentumEnvironment): Promise<unknown>;
}

export type ProcessInboxOutcome = 'PROCESSED' | 'ALREADY_PROCESSED' | 'NOT_FOUND' | 'SKIPPED';

export interface ProcessInboxResult {
  inboxId: string;
  outcome: ProcessInboxOutcome;
  /** Linhas da chave levadas a `PROCESSED` nesta chamada. */
  processed: number;
}

export interface ProcessInboxOptions {
  /** Redrive: reprocessa também uma linha `UNSUPPORTED`/`REJECTED_SCHEMA` (depois do deploy que aceita o formato). */
  reprocess?: boolean;
}

/** Causa SEM PII: erro do pg → só `code`/`constraint`; erro nosso → 1ª linha da mensagem (molde `describeError` do script). */
export function describeError(err: unknown): string {
  const e = err as { code?: string; message?: string; constraint?: string };
  if (e?.code) return [`code=${e.code}`, e.constraint ? `constraint=${e.constraint}` : null].filter(Boolean).join(' ');
  return (e?.message ?? String(err)).split('\n')[0].slice(0, 200);
}

export class ProcessTalentumInboxUseCase {
  constructor(
    private readonly pool: Pool,
    private readonly inbox: ITalentumInboxRepository,
    private readonly prescreeningProcessor: ITalentumPrescreeningProcessor,
    private readonly jobPostingCreator: IJobPostingFromTalentumCreator,
  ) {}

  async execute(inboxId: string, options: ProcessInboxOptions = {}): Promise<ProcessInboxResult> {
    const row = await this.inbox.findById(this.pool, inboxId);
    if (!row) return { inboxId, outcome: 'NOT_FOUND', processed: 0 };
    if (row.state === 'PROCESSED') return { inboxId, outcome: 'ALREADY_PROCESSED', processed: 0 };
    const settled = row.state === 'UNSUPPORTED' || row.state === 'REJECTED_SCHEMA';
    if (settled && !options.reprocess) return { inboxId, outcome: 'SKIPPED', processed: 0 };

    let failure: { error: unknown } | undefined;
    let processed = 0;

    // Ator do webhook vazio (evento automático): sem carimbo, `changed_by` fica ''/NULL na trilha.
    await withActorContext(this.pool, async (client) => {
      await this.inbox.lockKey(client, row.talentumPrescreeningId, row.talentumProfileId);
      const pending = await this.inbox.pendingForKey(client, row.talentumPrescreeningId, row.talentumProfileId, [row.id]);

      for (const item of pending) {
        await client.query('SAVEPOINT talentum_inbox_row');
        try {
          await this.processRow(item);
          await this.inbox.markProcessed(client, item.id);
          await client.query('RELEASE SAVEPOINT talentum_inbox_row');
          processed += 1;
        } catch (err) {
          await client.query('ROLLBACK TO SAVEPOINT talentum_inbox_row');
          await this.inbox.markFailed(client, item.id, describeError(err));
          failure = { error: err };
          break; // ordem importa: as mais novas ficam RECEIVED e entram na próxima entrega
        }
      }
    });

    console.log(`${TAG} inboxId=${inboxId} | processed=${processed} | failed=${failure ? 1 : 0}`);
    if (failure) throw failure.error;
    return { inboxId, outcome: 'PROCESSED', processed };
  }

  private async processRow(item: TalentumInboxRow): Promise<void> {
    const payload = await this.inbox.decryptPayload(item);
    const parsed = TalentumPrescreeningPayloadSchema.safeParse(payload);
    if (!parsed.success) throw new Error('payload_invalido');

    if (parsed.data.action === 'PRESCREENING') {
      // Criação de vaga (evento `PRESCREENING`/`CREATED`): o mesmo caso de uso que o VacancyCreatedHandler chamava.
      await this.jobPostingCreator.execute(parsed.data.data, item.environment);
      return;
    }
    await this.prescreeningProcessor.execute(parsed.data, { environment: item.environment });
  }
}
