/**
 * Rotas internas da inbox do webhook do Talentum (spec 095 §3.2, T-095-31).
 *
 * Montadas em `/api/internal` com `systemContextMiddleware('job:talentum-inbox')` + `internalAuthMiddleware` no `app.use`
 * (`index.ts`): o guard de segredo NÃO é por rota. O `internalAuthMiddleware` aceita OIDC sem allowlist (risco aceito, spec §3.2
 * "Auth do push").
 *
 *  - `POST /talentum/inbox/process`: push do Pub/Sub (`{ message: { data: base64(JSON { inboxId }) } }`).
 *  - `POST /talentum/inbox/redrive`: reprocessa linhas da inbox (por chave ou por estado), só contagens na resposta.
 *
 * Nenhum log nem resposta carrega o corpo da inbox (PII): só ids, enums e inteiros.
 */
import { Router, Request, Response } from 'express';
import type { Pool } from 'pg';
import { routeClass } from '@modules/identity/permissions';
import type { ProcessInboxOptions, ProcessInboxResult } from '../../application/ProcessTalentumInboxUseCase';

const TAG = '[TalentumInbox:Route]';

/** Port mínimo do processador (`ProcessTalentumInboxUseCase`). */
export interface ITalentumInboxProcessor {
  execute(inboxId: string, options?: ProcessInboxOptions): Promise<ProcessInboxResult>;
}

export const REDRIVE_STATES = ['FAILED', 'UNSUPPORTED', 'REJECTED_SCHEMA', 'RECEIVED'] as const;
export type RedriveState = (typeof REDRIVE_STATES)[number];
export const REDRIVE_DEFAULT_LIMIT = 50;
/** Teto de um redrive por estado: cada linha é uma decifra + uma transação; 500 cabe numa chamada sem estourar o timeout do Cloud Run. */
export const REDRIVE_MAX_LIMIT = 500;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RedriveSelector =
  | { kind: 'key'; talentumPrescreeningId: string; talentumProfileId: string }
  | { kind: 'state'; state: RedriveState; limit: number };

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** `null` = corpo inválido ou ambíguo (a rota responde 400 e não processa nada). */
export function parseRedriveBody(body: unknown): RedriveSelector | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const hasKey = 'talentumPrescreeningId' in b || 'talentumProfileId' in b;
  const hasState = 'state' in b || 'limit' in b;
  if (hasKey === hasState) return null; // nenhum dos dois, ou os dois: ambíguo

  if (hasKey) {
    if (!nonEmpty(b.talentumPrescreeningId) || !nonEmpty(b.talentumProfileId)) return null;
    return { kind: 'key', talentumPrescreeningId: b.talentumPrescreeningId, talentumProfileId: b.talentumProfileId };
  }
  if (!(REDRIVE_STATES as readonly unknown[]).includes(b.state)) return null;
  const limit = b.limit === undefined ? REDRIVE_DEFAULT_LIMIT : b.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > REDRIVE_MAX_LIMIT) return null;
  return { kind: 'state', state: b.state as RedriveState, limit };
}

/** Decodifica o push do Pub/Sub; `null` se não for `{ message.data: base64(JSON { inboxId: uuid }) }`. */
export function parsePushedInboxId(body: unknown): string | null {
  const data = (body as { message?: { data?: unknown } } | null)?.message?.data;
  if (typeof data !== 'string' || data.length === 0) return null;
  try {
    const inboxId = (JSON.parse(Buffer.from(data, 'base64').toString('utf8')) as { inboxId?: unknown } | null)?.inboxId;
    return typeof inboxId === 'string' && UUID_RE.test(inboxId) ? inboxId : null;
  } catch {
    return null;
  }
}

/** Só `code` do pg ou o nome do erro: a mensagem pode carregar valor da linha (PII). */
function safeCause(err: unknown): string {
  const e = err as { code?: string; name?: string };
  return e?.code ? `code=${e.code}` : `name=${e?.name ?? 'Error'}`;
}

export class TalentumInboxInternalController {
  constructor(
    private readonly processor: ITalentumInboxProcessor,
    private readonly pool: Pick<Pool, 'query'>,
  ) {}

  /** 400 = corpo que nunca vai ser válido; 200 = processada (ou nada a fazer); 500 = o processador falhou (o Pub/Sub reentrega). */
  async process(req: Request, res: Response): Promise<void> {
    const inboxId = parsePushedInboxId(req.body);
    if (!inboxId) {
      res.status(400).json({ error: 'Invalid push body' });
      return;
    }
    try {
      const result = await this.processor.execute(inboxId);
      res.status(200).json({ inboxId, outcome: result.outcome, processed: result.processed });
    } catch (err) {
      console.error(`${TAG} process failed | inboxId=${inboxId} | ${safeCause(err)}`);
      res.status(500).json({ error: 'Processing failed' });
    }
  }

  async redrive(req: Request, res: Response): Promise<void> {
    const selector = parseRedriveBody(req.body);
    if (!selector) {
      res.status(400).json({ error: 'Invalid redrive body' });
      return;
    }

    let ids: string[];
    try {
      ids = await this.selectIds(selector);
    } catch (err) {
      console.error(`${TAG} redrive select failed | ${safeCause(err)}`);
      res.status(500).json({ error: 'Redrive failed' });
      return;
    }

    let processed = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        // reprocess: o redrive existe para levar UNSUPPORTED/REJECTED_SCHEMA de novo depois do deploy que aceita o formato.
        processed += (await this.processor.execute(id, { reprocess: true })).processed;
      } catch (err) {
        failed += 1;
        console.error(`${TAG} redrive row failed | inboxId=${id} | ${safeCause(err)}`);
      }
    }
    console.log(`${TAG} redrive | mode=${selector.kind} | selected=${ids.length} | processed=${processed} | failed=${failed}`);
    res.status(200).json({ selected: ids.length, processed, failed });
  }

  private async selectIds(s: RedriveSelector): Promise<string[]> {
    const r =
      s.kind === 'key'
        ? await this.pool.query(
            `SELECT id FROM talentum_webhook_inbox
              WHERE talentum_prescreening_id = $1 AND talentum_profile_id = $2 AND state <> 'PROCESSED'
              ORDER BY received_at, id`,
            [s.talentumPrescreeningId, s.talentumProfileId],
          )
        : await this.pool.query(
            `SELECT id FROM talentum_webhook_inbox WHERE state = $1 ORDER BY received_at, id LIMIT $2`,
            [s.state, s.limit],
          );
    return (r.rows as Array<{ id: string }>).map((row) => row.id);
  }
}

export function createTalentumInboxInternalRoutes(controller: TalentumInboxInternalController): Router {
  const router = Router();
  router.post('/talentum/inbox/process', routeClass('service'), (req: Request, res: Response) => controller.process(req, res));
  router.post('/talentum/inbox/redrive', routeClass('service'), (req: Request, res: Response) => controller.redrive(req, res));
  return router;
}
