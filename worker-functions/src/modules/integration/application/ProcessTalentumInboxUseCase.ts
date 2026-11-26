/**
 * ProcessTalentumInboxUseCase — processador da inbox do webhook do Talentum (spec 095 §3.2).
 *
 * Roda DEPOIS do ack (Pub/Sub push só com o `inboxId`): lê a linha, toma o lock da chave
 * `(talentum_prescreening_id, talentum_profile_id)` e processa TODAS as `RECEIVED` e `FAILED` da chave por `received_at`
 * (a mais antiga primeiro) e PARA na primeira que falha: as mais novas ficam como estão (sem tentativa, sem `attempts`)
 * até a anterior passar. Uma `FAILED` antiga nunca é ultrapassada por uma mais nova. Isso também recolhe órfã de `publish`
 * que falhou, sem timer: o próximo evento da mesma chave a leva junto.
 *
 * LOCK (T-095-30, escolha justificada): `pg_advisory_xact_lock` numa transação externa (`withActorContext`), e NÃO
 * `pg_advisory_lock`/`unlock` de sessão em `finally`.
 *  - O lock só precisa estar tomado de ponta a ponta da linha; a transação o segura do `lockKey` até o COMMIT.
 *  - UMA conexão só: o `ProcessTalentumPrescreening` e o caso de uso de vaga recebem o `client` desta transação
 *    (`txBoundPool`: BEGIN/COMMIT internos viram SAVEPOINT). Antes, cada linha pegava outras conexões do MESMO pool com
 *    esta presa: `DB_POOL_MAX=5` e 5 pushes simultâneos travavam o pool da instância até o timeout (e as rotas todas).
 *  - Lock de sessão num client do pool vaza se o `unlock` falhar (a conexão volta ao pool ainda segurando a chave e
 *    ninguém mais a processa até o reciclo). O `xact_lock` é solto pelo próprio Postgres no COMMIT/ROLLBACK/queda.
 *  - Uma transação POR LINHA (não uma para a chave): `now()`/`created_at` valem o início da transação, e a trilha do WJA
 *    ordena por `created_at, id` — linhas da mesma chave numa transação só empatariam e a "última linha" seria sorteada.
 *    O lock é retomado a cada linha; quem entrar no intervalo também pega a mais antiga pendente, então a ordem se mantém.
 *  - Falha de linha NÃO desfaz as marcas: o erro da linha é capturado dentro da transação (SAVEPOINT, que também desfaz o que
 *    a linha gravou pela metade), a linha vira `FAILED`, a transação faz COMMIT e SÓ DEPOIS o erro original é relançado, para
 *    o Pub/Sub reentregar. As linhas mais novas não são tentadas.
 *  - Efeitos externos (Pub/Sub do evento qualified) saem depois do COMMIT da linha, só se ela não desfez.
 *
 * Nada aqui loga o corpo (PII): só ids, enums e contagens. `error_code` é só `code`/`constraint` do pg.
 */
import type { Pool, PoolClient } from 'pg';
import { withActorContext } from '@shared/database/actorContext';
import { reportError } from '@shared/logging';
import type { ITalentumInboxRepository, TalentumInboxRow } from '../domain/TalentumInbox';
import {
  PRESCREENING_CREATED_SUBTYPE,
  PRESCREENING_RESPONSE_SUBTYPES,
  TalentumPrescreeningPayloadSchema,
  type TalentumPrescreeningResponseParsed,
} from '../interfaces/webhooks/validators/talentumPrescreeningSchema';

const TAG = '[TalentumInbox:Process]';

export type TalentumEnvironment = 'production' | 'test';

/** Port do caso de uso de resposta de prescreening (`ProcessTalentumPrescreening`, módulo matching), sem cópia de lógica. */
export interface ITalentumPrescreeningProcessor {
  execute(
    payload: TalentumPrescreeningResponseParsed,
    options?: { environment?: TalentumEnvironment; client?: PoolClient; afterCommit?: AfterCommit },
  ): Promise<unknown>;
}

/** Efeito externo (Pub/Sub) que só pode sair depois do COMMIT da transação do processador. */
export type AfterCommit = (effect: () => Promise<void>) => void;

/** Port da criação de vaga por evento `PRESCREENING` (`CreateJobPostingFromTalentumUseCase`). */
export interface IJobPostingFromTalentumCreator {
  /** `client` = a transação do processador: o caso de uso roda nela, sem 2ª conexão do pool (T-095-30). */
  execute(data: { _id: string; name: string }, environment: TalentumEnvironment, client?: PoolClient): Promise<unknown>;
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

/** Destino de uma linha que NÃO foi processada nem falhou: fica guardada e avisa (F4), mas nunca relança (o Pub/Sub não reentrega). */
type RowVerdict = { kind: 'PROCESSED' } | { kind: 'SETTLED'; state: 'UNSUPPORTED' | 'REJECTED_SCHEMA'; errorCode: string };

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
    let processed = 0;
    let failure: { error: unknown } | undefined;
    let key: { prescreeningId: string | null; profileId: string | null } | undefined;
    const seen = new Set<string>(); // linha já tratada NESTA chamada (o redrive de assentada a mantém "pendente": não repetir)
    const reprocessIds = [inboxId];

    // UMA transação POR LINHA (T-095-30), cada uma com UMA conexão do pool: leitura, lock da chave, processamento e marcas
    // rodam no `client` dela; nada daqui (nem de `processRow`) chama `pool.connect()`/`pool.query()`. Por linha, e não uma
    // transação para a chave toda, porque `now()`/`created_at` do Postgres são o INÍCIO da transação: a trilha do WJA
    // (`ORDER BY created_at DESC, id DESC` em `lastTrailActor`/reversão) perderia a ordem entre linhas da mesma chave.
    // O lock (`xact_lock`) é retomado no início de cada linha; entre duas linhas outro push pode entrar, mas ele também
    // pega a MAIS ANTIGA pendente (a ordem se mantém). Ator do webhook vazio: sem carimbo, `changed_by` fica ''/NULL.
    for (;;) {
      const step = await withActorContext(this.pool, async (client): Promise<
        | { kind: 'early'; result: ProcessInboxResult }
        | { kind: 'done' }
        | { kind: 'row'; effects: Array<() => Promise<void>>; more: boolean; failure?: { error: unknown } }
      > => {
        if (!key) {
          const row = await this.inbox.findById(client, inboxId);
          if (!row) return { kind: 'early', result: { inboxId, outcome: 'NOT_FOUND', processed: 0 } };
          if (row.state === 'PROCESSED') return { kind: 'early', result: { inboxId, outcome: 'ALREADY_PROCESSED', processed: 0 } };
          const settled = row.state === 'UNSUPPORTED' || row.state === 'REJECTED_SCHEMA';
          if (settled && !options.reprocess) return { kind: 'early', result: { inboxId, outcome: 'SKIPPED', processed: 0 } };
          key = { prescreeningId: row.talentumPrescreeningId, profileId: row.talentumProfileId };
        }
        await this.inbox.lockKey(client, key.prescreeningId, key.profileId);
        const pending = await this.inbox.pendingForKey(client, key.prescreeningId, key.profileId, reprocessIds);
        const item = pending.find((p) => !seen.has(p.id));
        if (!item) return { kind: 'done' };
        seen.add(item.id);
        const more = pending.some((p) => !seen.has(p.id)); // havia outra pendente além desta: só então vale outra transação

        await client.query('SAVEPOINT talentum_inbox_row');
        const effects: Array<() => Promise<void>> = [];
        try {
          const verdict = await this.processRow(item, client, (effect) => { effects.push(effect); });
          if (verdict.kind === 'PROCESSED') {
            await this.inbox.markProcessed(client, item.id);
            processed += 1;
          } else {
            await this.inbox.markState(client, item.id, verdict.state, verdict.errorCode);
          }
          await client.query('RELEASE SAVEPOINT talentum_inbox_row');
          return { kind: 'row', effects, more };
        } catch (err) {
          // Desfaz o que a linha gravou pela metade, marca FAILED (durável: o COMMIT vem depois) e relança só no fim.
          await client.query('ROLLBACK TO SAVEPOINT talentum_inbox_row');
          await this.inbox.markFailed(client, item.id, describeError(err));
          return { kind: 'row', effects: [], more, failure: { error: err } };
        }
      });

      if (step.kind === 'early') return step.result;
      if (step.kind === 'done') break;
      for (const effect of step.effects) await effect(); // já commitado: o consumidor do Pub/Sub enxerga o que a linha gravou
      if (step.failure) { failure = step.failure; break; } // ordem importa: as mais novas não são tentadas; entram na próxima entrega
      if (!step.more) break;
    }

    console.log(
      `${TAG} inboxId=${inboxId} | talentumPrescreeningId=${key?.prescreeningId ?? 'none'} | processed=${processed} | failed=${failure ? 1 : 0}`,
    );
    if (failure) throw failure.error;
    return { inboxId, outcome: 'PROCESSED', processed };
  }

  private async processRow(item: TalentumInboxRow, client: PoolClient, afterCommit: AfterCommit): Promise<RowVerdict> {
    const payload = await this.inbox.decryptPayload(item);

    // 1) Formato desconhecido (action/subtype fora do que o processador entende) → UNSUPPORTED, sem tentar o schema.
    //    A linha fica guardada; depois do deploy que aceita o formato, o redrive a reprocessa.
    const unsupported = unsupportedReason(payload);
    if (unsupported) return { kind: 'SETTLED', state: 'UNSUPPORTED', errorCode: unsupported };

    // 2) Schema completo (saiu do ack). Recusa → REJECTED_SCHEMA + alarme só com as CHAVES que falharam, nunca valores.
    const parsed = TalentumPrescreeningPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      const paths = Object.keys(parsed.error.flatten().fieldErrors);
      reportError(new Error('TALENTUM_PAYLOAD_REJECTED'), {
        source: 'ProcessTalentumInboxUseCase:schema',
        kind: 'TALENTUM_PAYLOAD_REJECTED',
        inboxId: item.id,
        paths,
      });
      return { kind: 'SETTLED', state: 'REJECTED_SCHEMA', errorCode: 'SCHEMA_INVALID' };
    }

    if (parsed.data.action === 'PRESCREENING') {
      // Criação de vaga (evento `PRESCREENING`/`CREATED`): o mesmo caso de uso que o VacancyCreatedHandler chamava.
      await this.jobPostingCreator.execute(parsed.data.data, item.environment, client);
      return { kind: 'PROCESSED' };
    }
    await this.prescreeningProcessor.execute(parsed.data, { environment: item.environment, client, afterCommit });
    return { kind: 'PROCESSED' };
  }
}

/** `null` se o formato é conhecido; senão o código (sem PII) do porquê. Só lê `action` e `subtype`, e nunca os loga. */
function unsupportedReason(payload: unknown): string | null {
  const b = (payload ?? {}) as { action?: unknown; subtype?: unknown };
  if (b.action === 'PRESCREENING_RESPONSE') {
    return (PRESCREENING_RESPONSE_SUBTYPES as readonly unknown[]).includes(b.subtype) ? null : 'UNSUPPORTED_SUBTYPE';
  }
  if (b.action === 'PRESCREENING') return b.subtype === PRESCREENING_CREATED_SUBTYPE ? null : 'UNSUPPORTED_SUBTYPE';
  return 'UNSUPPORTED_ACTION';
}
