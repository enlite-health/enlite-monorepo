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

const idSchema = z.string().uuid();
const querySchema = z.object({
  area: z.string().min(1).max(40).optional(),
  status: z.enum(PEDIDO_STATUS).optional(),
  grave: z.enum(['true', 'false']).optional(),
});
const negarSchema = z.object({ motivo: z.string().trim().min(1, 'MOTIVO_OBRIGATORIO').max(300) });
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
  ) {}

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
    if (acao === 'negar') {
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
