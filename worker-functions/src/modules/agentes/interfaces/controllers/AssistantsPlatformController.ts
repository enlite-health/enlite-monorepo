import type { Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '@shared/logging';
import { principalUid } from '@modules/identity';
import { ASSISTANT_CHAT_CELLS } from '@modules/identity/permissions';
import type { AssistantReachUseCase, ResolveActorCells } from '../../application/AssistantReachUseCase';
import {
  escalationFromLegacy,
  escalationResultToLegacy,
  type EscalationInput,
  type PlacarResult,
  type ReporteInput,
} from '../../../mcp/infrastructure/AgentesRepository';
import {
  AREA,
  CASOS_REPORTE,
  DATA_DIA,
  ISO_DATA,
  OPERADOR,
  UUID,
  ref,
  texto,
} from '../../../mcp/application/capabilities/agentesSchemas';

/** Slug -> chat cell, derived from the catalog constants (no literal assistant here). */
const CELL_BY_ASSISTANT: ReadonlyMap<string, string> = new Map(
  ASSISTANT_CHAT_CELLS.map((cell) => [cell.split(':')[0].replace(/^assistant_/, ''), cell] as [string, string]),
);

/** Query of the new route: English names (`operator`, `from`, `to`). */
const scoreboardQuery = z
  .object({ operator: OPERADOR, from: ISO_DATA, to: ISO_DATA })
  .strict()
  .refine((v) => Date.parse(v.from) < Date.parse(v.to), { message: 'from must be before to' });

/**
 * Body of the escalation POST: LEGACY vocabulary (glossary §6.4) — `gestora`, `operador`, `caso`, `observacao`...
 * The handler converts it into the English arguments of `registerEscalationWith`.
 */
const escalationBody = z
  .object({
    gestora: z.string().refine((g) => CELL_BY_ASSISTANT.has(g), { message: 'unknown assistant' }),
    operador: OPERADOR,
    area: AREA,
    caso: z.enum(CASOS_REPORTE),
    regra_ref: ref(1, 200).optional(),
    ocorrencias: z.number().int().min(0).max(32767).optional(),
    janela_de: DATA_DIA,
    janela_ate: DATA_DIA,
    observacao: texto(500),
    regra_proposta: texto(300).optional(),
    veredicto_ids: z.array(UUID).max(100).optional(),
  })
  .strict()
  .refine((v) => v.caso === 'meta' || v.regra_ref !== undefined, { message: 'regra_ref may only be missing when caso is meta' })
  .refine((v) => v.janela_ate >= v.janela_de, { message: 'janela_ate must be >= janela_de' });

export interface AssistantsPlatformDeps {
  reach: AssistantReachUseCase;
  resolveCells: ResolveActorCells;
  /** Real body: `withActorContext(pool, c => readScoreboardWith(c, …), staffActor(uid))`. */
  readScoreboard: (uid: string, p: { operator: string; from: string; to: string }) => Promise<PlacarResult>;
  /** Real body: `withActorContext(pool, c => registerEscalationWith(c, …), staffActor(uid))`. */
  registerEscalation: (uid: string, e: EscalationInput) => Promise<{ id: string; duplicate?: true }>;
}

/** Only the error name/code: the driver's error message may echo values of the row (observacao). */
const safe = (err: unknown) => ({ error: err instanceof Error ? err.name : 'error' });

/**
 * HTTP of the platform routes for the assistants service (spec 080, contract rotas-plataforma-novas §1-§3).
 * No conversation text. Never logs `observacao`.
 */
export class AssistantsPlatformController {
  constructor(private readonly deps: AssistantsPlatformDeps) {}

  async reach(req: Request, res: Response): Promise<void> {
    const uid = principalUid(req);
    if (!uid) return void res.status(401).json({ error: 'Unauthenticated' });
    try {
      const a = await this.deps.reach.execute(uid);
      logger.info({ uid, assistants: a.assistants.length, knowledge: a.knowledge.length }, '[assistants] reach');
      res.status(200).json({ uid, assistants: a.assistants, knowledge: a.knowledge });
    } catch (err) {
      logger.error({ uid, ...safe(err) }, '[assistants] failed to resolve reach');
      res.status(500).json({ error: 'REACH_FAILED' });
    }
  }

  async scoreboard(req: Request, res: Response): Promise<void> {
    const uid = principalUid(req);
    if (!uid) return void res.status(401).json({ error: 'Unauthenticated' });
    const q = scoreboardQuery.safeParse(req.query);
    if (!q.success) return void res.status(400).json({ error: 'INVALID_QUERY' });
    try {
      const p = await this.deps.readScoreboard(uid, q.data);
      logger.info({ uid, operator: q.data.operator, from: q.data.from, to: q.data.to, status: 200 }, '[assistants] scoreboard');
      // Contract projection (legacy body, glossary §6.3): no verdict ids and no `graves` (they carry conversa_ref).
      res.status(200).json({
        operador: p.operador,
        de: p.de,
        ate: p.ate,
        veredictos: p.veredictos,
        conversas: p.conversas,
        nota_media: p.nota_media,
        cruza_areas: p.cruza_areas,
        por_regra: p.por_regra.map((r) => ({
          regra_ref: r.regra_ref,
          violacoes: r.violacoes,
          gravidade_max: r.gravidade_max,
        })),
      });
    } catch (err) {
      logger.error({ uid, operator: q.data.operator, ...safe(err) }, '[assistants] failed to read scoreboard');
      res.status(500).json({ error: 'SCOREBOARD_FAILED' });
    }
  }

  async escalate(req: Request, res: Response): Promise<void> {
    const uid = principalUid(req);
    if (!uid) return void res.status(401).json({ error: 'Unauthenticated' });
    const b = escalationBody.safeParse(req.body);
    if (!b.success) return void res.status(400).json({ error: 'INVALID_BODY' });
    const { gestora: assistant, veredicto_ids, ...rest } = b.data;
    const legacy: ReporteInput = { ...rest, autor: assistant, veredicto_ids: veredicto_ids ?? [] };
    try {
      // Plan check: the person must reach the assistant that the service names.
      const cells = await this.deps.resolveCells(uid);
      const chatCell = CELL_BY_ASSISTANT.get(assistant) as string;
      if (!cells.includes(chatCell)) {
        logger.warn({ uid, assistant, caso: b.data.caso, status: 403 }, '[assistants] escalation without reach to the assistant');
        return void res.status(403).json({ error: 'NO_REACH_TO_ASSISTANT' });
      }
      const r = await this.deps.registerEscalation(uid, escalationFromLegacy(legacy));
      const status = r.duplicate ? 200 : 201;
      logger.info({ uid, assistant, caso: b.data.caso, status }, '[assistants] escalation');
      res.status(status).json(escalationResultToLegacy(r));
    } catch (err) {
      logger.error({ uid, assistant, caso: b.data.caso, ...safe(err) }, '[assistants] failed to register escalation');
      res.status(500).json({ error: 'ESCALATION_FAILED' });
    }
  }
}
