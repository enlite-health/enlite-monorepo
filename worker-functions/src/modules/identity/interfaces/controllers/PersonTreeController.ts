/**
 * `GET /v1/persons/:pid/tree` — a árvore de pessoas do `iam` (design §2.2 "Não impedir", T138).
 *
 * Contrato consumido pelo learn-service (spec B): "mesma pessoa?" nunca é igualdade de `pid`; resolve-se por esta árvore.
 * Só leitura sobre `iam.person_tree` (raiz do `pid` dado + toda pessoa cuja cadeia chega nela). Sem cache no servidor
 * (o cache ≤ 1 h é do CONSUMIDOR) e sem evento `person.merged`. A resposta é só `pid` (uuid): nenhum dado de pessoa.
 */
import type { Request, Response } from 'express';
import type { Pool } from 'pg';
import { logger } from '@shared/logging';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PersonTreeController {
  constructor(private readonly pool: Pool) {}

  async tree(req: Request, res: Response): Promise<void> {
    const pid = String(req.params.pid ?? '');
    if (!UUID_RE.test(pid)) {
      res.status(400).json({ success: false, error: 'pid inválido' });
      return;
    }
    try {
      const result = await this.pool.query<{ pid: string }>(`SELECT iam.person_tree($1::uuid) AS pid`, [pid]);
      if (result.rows.length === 0) {
        res.status(404).json({ success: false, error: 'pid desconhecido' });
        return;
      }
      res.json(result.rows.map((r) => r.pid).sort());
    } catch (error) {
      logger.error({ err: error }, '[persons/tree] falha ao resolver a árvore');
      res.status(500).json({ success: false, error: 'Falha ao resolver a árvore' });
    }
  }
}
