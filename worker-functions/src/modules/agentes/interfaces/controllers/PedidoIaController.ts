import type { Request, Response } from 'express';
import { z } from 'zod';
import { AuthMiddleware } from '@modules/identity';
import { reportError } from '@shared/logging';
import {
  ComentarioObrigatorioError,
  DecisaoJaRegistradaError,
  PedidoJaDecididoError,
  MotivoObrigatorioError,
  PEDIDO_STATUS,
  PedidoNaoEncontradoError,
  type AcaoDecisao,
} from '../../domain/PedidoIa';
import {
  DecidirPedidoIaUseCase,
  ListarPedidosIaUseCase,
  ObterPedidoIaUseCase,
} from '../../application/PedidosIaUseCases';
import type { ContadoresPedidos } from '../../infrastructure/PedidoContadorQuery';

/** Leitura dos dois contadores (spec 081 T094). Produção: `withActorContext(pool, (c) => consultarContadoresPedidos(c, janela), staffActor(uid))`. */
export type LerContadoresPedidos = (actorUid: string, janela: { de: Date; ate: Date }) => Promise<ContadoresPedidos>;

const SEMANAS_JANELA_PADRAO = 28; // > 26 (régua do contador 2) + semana parcial
const MS_SEMANA = 7 * 24 * 3600 * 1000;
const dataSchema = z.string().refine((v) => /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2}))?$/.test(v) && !Number.isNaN(Date.parse(v)));
const janelaSchema = z.object({ de: dataSchema.optional(), ate: dataSchema.optional() });

const idSchema = z.string().uuid();
const querySchema = z.object({
  area: z.string().min(1).max(40).optional(),
  status: z.enum(PEDIDO_STATUS).optional(),
  grave: z.enum(['true', 'false']).optional(),
});
const negarSchema = z.object({ motivo: z.string().trim().min(1, 'MOTIVO_OBRIGATORIO').max(300) });
/** Aprovar com comentário: o corpo é opcional; se vier `comentario`, 1..1000 (aparado). */
const aceitarSchema = z.object({ comentario: z.string().trim().min(1, 'COMENTARIO_INVALIDO').max(1000).optional() });
const descreverSchema = z.object({ comentario: z.string().trim().min(1, 'COMENTARIO_OBRIGATORIO').max(500) });

/**
 * HTTP dos pedidos do Sol (spec 078, M3b-1). Sem lógica de negócio. Envelope dos irmãos: `{success, data}` /
 * `{success:false, code}`. Ator = `AuthMiddleware.getAuthContext(req).principal.id`; ausente = 401, sem fallback.
 */
export class PedidoIaController {
  constructor(
    private readonly listar: ListarPedidosIaUseCase,
    private readonly obter: ObterPedidoIaUseCase,
    private readonly decidir: DecidirPedidoIaUseCase,
    private readonly lerContadores?: LerContadoresPedidos,
  ) {}

  /** GET só-leitura dos dois contadores. `de`/`ate` (ISO) opcionais: padrão = 28 semanas até agora; `de` < `ate`, senão 400. */
  async contadores(req: Request, res: Response): Promise<void> {
    const q = janelaSchema.safeParse(req.query);
    if (!q.success) return void res.status(400).json({ success: false, code: 'INVALID_QUERY' });
    const ate = q.data.ate ? new Date(q.data.ate) : new Date();
    const de = q.data.de ? new Date(q.data.de) : new Date(ate.getTime() - SEMANAS_JANELA_PADRAO * MS_SEMANA);
    if (de.getTime() >= ate.getTime()) return void res.status(400).json({ success: false, code: 'INVALID_QUERY' });
    const actorUid = AuthMiddleware.getAuthContext(req)?.principal.id;
    if (!actorUid) return void res.status(401).json({ success: false, code: 'UNAUTHENTICATED' });
    if (!this.lerContadores) return void res.status(501).json({ success: false, code: 'NOT_CONFIGURED' });
    try {
      const data = await this.lerContadores(actorUid, { de, ate });
      res.status(200).json({ success: true, data: { ...data, janela: { de: de.toISOString(), ate: ate.toISOString() } } });
    } catch (err) {
      this.fail(err, res, 'contadores');
    }
  }

  async list(req: Request, res: Response): Promise<void> {
    const q = querySchema.safeParse(req.query);
    if (!q.success) return void res.status(400).json({ success: false, code: 'INVALID_QUERY' });
    try {
      const data = await this.listar.execute({
        ...(q.data.area !== undefined ? { area: q.data.area } : {}),
        ...(q.data.status !== undefined ? { status: q.data.status } : {}),
        ...(q.data.grave !== undefined ? { grave: q.data.grave === 'true' } : {}),
      });
      res.status(200).json({ success: true, data });
    } catch (err) {
      this.fail(err, res, 'list');
    }
  }

  async get(req: Request, res: Response): Promise<void> {
    const id = idSchema.safeParse(req.params.id);
    if (!id.success) return void res.status(404).json({ success: false, code: 'NOT_FOUND' });
    try {
      res.status(200).json({ success: true, data: await this.obter.execute(id.data) });
    } catch (err) {
      this.fail(err, res, 'get');
    }
  }

  aceitar = (req: Request, res: Response): Promise<void> => this.decide(req, res, 'aceitar');
  negar = (req: Request, res: Response): Promise<void> => this.decide(req, res, 'negar');
  descrever = (req: Request, res: Response): Promise<void> => this.decide(req, res, 'descrever');

  private async decide(req: Request, res: Response, acao: AcaoDecisao): Promise<void> {
    const id = idSchema.safeParse(req.params.id);
    if (!id.success) return void res.status(404).json({ success: false, code: 'NOT_FOUND' });
    const actorUid = AuthMiddleware.getAuthContext(req)?.principal.id;
    if (!actorUid) return void res.status(401).json({ success: false, code: 'UNAUTHENTICATED' });

    let motivo: string | undefined;
    let comentario: string | undefined;
    if (acao === 'aceitar') {
      const b = aceitarSchema.safeParse(req.body ?? {});
      if (!b.success) return void res.status(400).json({ success: false, code: 'COMENTARIO_INVALIDO' });
      comentario = b.data.comentario;
    } else if (acao === 'negar') {
      const b = negarSchema.safeParse(req.body ?? {});
      if (!b.success) return void res.status(400).json({ success: false, code: 'MOTIVO_OBRIGATORIO' });
      motivo = b.data.motivo;
    } else if (acao === 'descrever') {
      const b = descreverSchema.safeParse(req.body ?? {});
      if (!b.success) return void res.status(400).json({ success: false, code: 'COMENTARIO_OBRIGATORIO' });
      comentario = b.data.comentario;
    }
    try {
      const data = await this.decidir.execute({ pedidoId: id.data, acao, actorUid, motivo, comentario });
      res.status(200).json({ success: true, data });
    } catch (err) {
      this.fail(err, res, acao);
    }
  }

  private fail(err: unknown, res: Response, method: string): void {
    if (err instanceof PedidoNaoEncontradoError) return void res.status(404).json({ success: false, code: 'NOT_FOUND' });
    if (err instanceof DecisaoJaRegistradaError) return void res.status(409).json({ success: false, code: 'DECISAO_JA_REGISTRADA' });
    if (err instanceof PedidoJaDecididoError) return void res.status(409).json({ success: false, code: 'PEDIDO_JA_DECIDIDO' });
    if (err instanceof MotivoObrigatorioError) return void res.status(400).json({ success: false, code: 'MOTIVO_OBRIGATORIO' });
    if (err instanceof ComentarioObrigatorioError) return void res.status(400).json({ success: false, code: 'COMENTARIO_OBRIGATORIO' });
    reportError(err instanceof Error ? err : new Error(String(err)), { source: `PedidoIaController:${method}` });
    res.status(500).json({ success: false, code: 'INTERNAL_ERROR' });
  }
}
