import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { logger } from '@shared/logging';
import { principalUid } from '@modules/identity';
import {
  TriageIndisponivel,
  type TriagePruebaPort,
  type TurnosPruebaPort,
} from '../../domain/TriagePruebaPort';

/** Teto provisório da 080 §6.9 / spec 086 DF-11: turnos por pessoa por dia. */
export const TETO_DIARIO_PADRAO = 60;

/** `LUZ_PRUEBA_TETO_DIARIO` só vale fora de produção (e2e baixa o teto para provar o 429); em produção o teto é sempre o padrão. */
export function tetoDiarioFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  if (env.NODE_ENV === 'production') return TETO_DIARIO_PADRAO;
  const n = Number(env.LUZ_PRUEBA_TETO_DIARIO);
  return Number.isInteger(n) && n >= 1 ? n : TETO_DIARIO_PADRAO;
}

/** `sessao` entra no header `prueba:<uid>:<sessao>#turno-<N>`: sem `:`, `#` nem espaço. */
const SESSAO = /^[A-Za-z0-9_-]{1,40}$/;
/** O uid também entra no header e no `conversa_ref`: o do Firebase é alfanumérico; qualquer outro formato é recusado. */
const UID = /^[A-Za-z0-9_.-]{1,128}$/;

const bodySchema = z
  .object({
    sessao: z.string().regex(SESSAO),
    mensagem: z.string().min(1).max(1000),
    historico: z
      .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(4000) }).strict())
      .max(10),
  })
  .strict();

const uidHash = (uid: string): string => createHash('sha256').update(uid).digest('hex').slice(0, 12);

/**
 * POST /api/admin/luz-prueba/turn — spec 086, contrato §9.2. A célula (`luz_prueba:chat`) já foi conferida no array da rota.
 * Log de erro SÓ `{uid_hash, sessao, codigo}` (RF-8): nunca mensagem, histórico nem resposta.
 */
export class LuzPruebaController {
  constructor(
    private readonly triage: TriagePruebaPort,
    private readonly turnos: TurnosPruebaPort,
    private readonly limite: number = tetoDiarioFromEnv(),
  ) {}

  async turn(req: Request, res: Response): Promise<void> {
    const uid = principalUid(req);
    if (!uid || !UID.test(uid)) return void res.status(401).json({ error: 'Unauthenticated' });
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) return void res.status(400).json({ codigo: 'REQUISICAO_INVALIDA' });
    const { sessao, mensagem, historico } = parsed.data;
    const base = { uid_hash: uidHash(uid), sessao };

    let consumo: { permitido: boolean; turnos: number };
    try {
      consumo = await this.turnos.consumir(uid, this.limite);
    } catch {
      logger.error({ ...base, codigo: 'CONTADOR_FALHOU' }, '[luz-prueba] contador falhou');
      return void res.status(500).json({ codigo: 'CONTADOR_FALHOU' });
    }
    if (!consumo.permitido) return void res.status(429).json({ codigo: 'TETO_DIARIO', limite: this.limite });

    try {
      const saida = await this.triage.turno({ uid, sessao, mensagem, historico, turno: consumo.turnos });
      res.status(200).json(saida);
    } catch (err) {
      await this.turnos.devolver(uid).catch(() => undefined);
      const causa = err instanceof TriageIndisponivel ? err.causa : 'erro';
      // `codigo` leva a causa curta (timeout, rede, http_403...): nunca corpo, mensagem nem histórico (RF-8).
      logger.error({ ...base, codigo: `TRIAGE_INDISPONIVEL:${causa}` }, '[luz-prueba] triage indisponivel');
      res.status(502).json({ codigo: 'TRIAGE_INDISPONIVEL' });
    }
  }
}
