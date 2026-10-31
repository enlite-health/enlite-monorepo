import type { Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '@shared/logging';
import { principalUid } from '@modules/identity';
import { ASSISTENTE_CHAT_CELLS } from '../../../identity/permissions/domain/PermissionCell';
import type { AlcanceAssistentesUseCase, ResolverCelulasDoAtor } from '../../application/AlcanceAssistentesUseCase';
import type { PlacarResult, ReporteInput } from '../../../mcp/infrastructure/AgentesRepository';
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

/** Slug -> célula de chat, derivado das constantes do catálogo (nenhuma gestora literal aqui). */
const CELULA_POR_GESTORA: ReadonlyMap<string, string> = new Map(
  ASSISTENTE_CHAT_CELLS.map((celula) => [celula.split(':')[0].replace(/^assistente_/, ''), celula] as [string, string]),
);

const placarQuery = z
  .object({ operador: OPERADOR, de: ISO_DATA, ate: ISO_DATA })
  .strict()
  .refine((v) => Date.parse(v.de) < Date.parse(v.ate), { message: 'de deve ser anterior a ate' });

const reporteBody = z
  .object({
    gestora: z.string().refine((g) => CELULA_POR_GESTORA.has(g), { message: 'gestora desconhecida' }),
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
  .refine((v) => v.caso === 'meta' || v.regra_ref !== undefined, { message: 'regra_ref só pode faltar no caso meta' })
  .refine((v) => v.janela_ate >= v.janela_de, { message: 'janela_ate deve ser >= janela_de' });

export interface AssistentesPlataformaDeps {
  alcance: AlcanceAssistentesUseCase;
  resolverCelulas: ResolverCelulasDoAtor;
  /** Corpo real: `withActorContext(pool, c => lerPlacarCom(c, …), staffActor(uid))`. */
  lerPlacar: (uid: string, p: { operador: string; de: string; ate: string }) => Promise<PlacarResult>;
  /** Corpo real: `withActorContext(pool, c => registrarReporteCom(c, …), staffActor(uid))`. */
  registrarReporte: (uid: string, r: ReporteInput) => Promise<{ id: string; duplicado?: true }>;
}

/** Só nome/código do erro: a mensagem de erro do driver pode ecoar valores da linha (observacao). */
const seguro = (err: unknown) => ({ erro: err instanceof Error ? err.name : 'erro' });

/**
 * HTTP das rotas da plataforma para o serviço das gestoras (spec 080, contrato rotas-plataforma-novas §1-§3).
 * Sem texto de conversa. Nunca loga `observacao`.
 */
export class AssistentesPlataformaController {
  constructor(private readonly deps: AssistentesPlataformaDeps) {}

  async alcance(req: Request, res: Response): Promise<void> {
    const uid = principalUid(req);
    if (!uid) return void res.status(401).json({ error: 'Unauthenticated' });
    try {
      const a = await this.deps.alcance.executar(uid);
      logger.info({ uid, gestoras: a.gestoras.length, conhecimento: a.conhecimento.length }, '[assistentes] alcance');
      res.status(200).json({ uid, gestoras: a.gestoras, conhecimento: a.conhecimento });
    } catch (err) {
      logger.error({ uid, ...seguro(err) }, '[assistentes] falha ao resolver alcance');
      res.status(500).json({ error: 'ALCANCE_FALHOU' });
    }
  }

  async placar(req: Request, res: Response): Promise<void> {
    const uid = principalUid(req);
    if (!uid) return void res.status(401).json({ error: 'Unauthenticated' });
    const q = placarQuery.safeParse(req.query);
    if (!q.success) return void res.status(400).json({ error: 'INVALID_QUERY' });
    try {
      const p = await this.deps.lerPlacar(uid, q.data);
      logger.info({ uid, operador: q.data.operador, de: q.data.de, ate: q.data.ate, status: 200 }, '[assistentes] placar');
      // Projeção do contrato: nada de ids de veredicto nem `graves` (carregam conversa_ref).
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
      logger.error({ uid, operador: q.data.operador, ...seguro(err) }, '[assistentes] falha ao ler placar');
      res.status(500).json({ error: 'PLACAR_FALHOU' });
    }
  }

  async reportar(req: Request, res: Response): Promise<void> {
    const uid = principalUid(req);
    if (!uid) return void res.status(401).json({ error: 'Unauthenticated' });
    const b = reporteBody.safeParse(req.body);
    if (!b.success) return void res.status(400).json({ error: 'INVALID_BODY' });
    const { gestora, veredicto_ids, ...resto } = b.data;
    try {
      // Conferência do plano: a pessoa tem de alcançar a gestora que o serviço nomeia.
      const celulas = await this.deps.resolverCelulas(uid);
      const celulaChat = CELULA_POR_GESTORA.get(gestora) as string;
      if (!celulas.includes(celulaChat)) {
        logger.warn({ uid, gestora, caso: b.data.caso, status: 403 }, '[assistentes] reporte sem alcance à gestora');
        return void res.status(403).json({ error: 'SEM_ALCANCE_A_GESTORA' });
      }
      const r = await this.deps.registrarReporte(uid, { ...resto, autor: gestora, veredicto_ids: veredicto_ids ?? [] });
      const status = r.duplicado ? 200 : 201;
      logger.info({ uid, gestora, caso: b.data.caso, status }, '[assistentes] reporte');
      res.status(status).json(r.duplicado ? { id: r.id, duplicado: true } : { id: r.id });
    } catch (err) {
      logger.error({ uid, gestora, caso: b.data.caso, ...seguro(err) }, '[assistentes] falha ao registrar reporte');
      res.status(500).json({ error: 'REPORTE_FALHOU' });
    }
  }
}
