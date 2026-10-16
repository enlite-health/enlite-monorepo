import { Request, Response } from 'express';
import { z } from 'zod';
import { reportError, safeErrorFields } from '@shared/logging';
import { actorUid, MissingActorError } from '@modules/conversation/interfaces/controllers/ConversationActor';
import {
  InterviewHostAlreadyActiveError,
  InterviewHostNotFoundError,
  InterviewHostUserNotEligibleError,
} from '../../application/InterviewHostErrors';
import type { InterviewHostService } from '../../application/InterviewHostService';

/**
 * InterviewHostController — tela Entrevistadores (spec 055). Rotas ADMIN sob `/api/admin`.
 *
 *   GET   /interview-hosts                  interview_host:read
 *   GET   /interview-hosts/candidates?q=    interview_host:update   (staff ativo, máx. 20)
 *   POST  /interview-hosts                  interview_host:update   {userUid, countries, doesEnquadre, doesAdmission}
 *   PATCH /interview-hosts/:id              interview_host:update   (qualquer subconjunto; os dois fluxos false = Quitar)
 *
 * Erro de domínio vira resposta com `code` ESTÁVEL; o resto vira 500 genérico, relatado só com ids — nunca e-mail nem nome.
 */
const countriesSchema = z.array(z.enum(['AR', 'BR'])).min(1).max(2).refine((c) => new Set(c).size === c.length);
const idParams = z.object({ id: z.string().uuid() });
const candidatesQuery = z.object({ q: z.string().trim().min(1).max(100) });
const createBody = z
  .object({ userUid: z.string().min(1).max(128), countries: countriesSchema, doesEnquadre: z.boolean(), doesAdmission: z.boolean() })
  .strict()
  .refine((b) => b.doesEnquadre || b.doesAdmission, { message: 'at least one flow' });
const patchBody = z
  .object({ countries: countriesSchema.optional(), doesEnquadre: z.boolean().optional(), doesAdmission: z.boolean().optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'empty patch' });

const DOMAIN_STATUS: ReadonlyArray<readonly [new (...a: never[]) => Error, number]> = [
  [InterviewHostUserNotEligibleError, 400],
  [InterviewHostNotFoundError, 404],
  [InterviewHostAlreadyActiveError, 409],
  [MissingActorError, 401],
];

export class InterviewHostController {
  constructor(private readonly service: InterviewHostService) {}

  async list(_req: Request, res: Response): Promise<void> {
    await this.run(res, 'list', async () => {
      const data = await this.service.list();
      res.status(200).json({ success: true, data });
    });
  }

  async candidates(req: Request, res: Response): Promise<void> {
    const query = candidatesQuery.safeParse(req.query);
    if (!query.success) return this.invalid(res);
    await this.run(res, 'candidates', async () => {
      const data = await this.service.candidates(query.data.q);
      res.status(200).json({ success: true, data });
    });
  }

  async create(req: Request, res: Response): Promise<void> {
    const body = createBody.safeParse(req.body);
    if (!body.success) return this.invalid(res);
    await this.run(res, 'create', async () => {
      const data = await this.service.create(body.data, actorUid(req));
      res.status(201).json({ success: true, data });
    });
  }

  async patch(req: Request, res: Response): Promise<void> {
    const params = idParams.safeParse(req.params);
    const body = patchBody.safeParse(req.body);
    if (!params.success || !body.success) return this.invalid(res);
    await this.run(res, 'patch', async () => {
      await this.service.update(params.data.id, body.data, actorUid(req));
      res.status(200).json({ success: true, data: { id: params.data.id } });
    });
  }

  private invalid(res: Response): void {
    res.status(400).json({ success: false, error: 'Invalid request', code: 'INVALID_REQUEST' });
  }

  private async run(res: Response, op: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      const hit = DOMAIN_STATUS.find(([ctor]) => err instanceof ctor);
      if (hit) {
        const code = (err as { code?: string }).code ?? 'ERROR';
        res.status(hit[1]).json({ success: false, error: (err as Error).message, code });
        return;
      }
      // 23505 em POST = dois cadastros simultâneos da mesma pessoa perderam a corrida no UNIQUE(email)/user_uid: é "já ativa".
      if (op === 'create' && safeErrorFields(err).code === '23505') {
        const dup = new InterviewHostAlreadyActiveError();
        res.status(409).json({ success: false, error: dup.message, code: dup.code });
        return;
      }
      // O erro cru do pg carrega `detail: Key (email)=(...)` e o serializer do pino o copia: reporta só nome e SQLSTATE.
      const { errorName, code } = safeErrorFields(err);
      reportError(Object.assign(new Error(errorName), { code }), { source: `InterviewHostController:${op}` });
      res.status(500).json({ success: false, error: 'Internal error', code: 'INTERNAL_ERROR' });
    }
  }
}
