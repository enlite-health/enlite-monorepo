/**
 * src/shared/audit/resourceAccessLog.ts
 *
 * Trilha de LEITURA de recurso sensível (ABAC país Fase 1, task 3.4): quem ABRIU
 * o dossiê de qual pessoa. É a metade que faltava da auditoria — escrita já é
 * coberta por `worker_profile_changes_audit` (D93) e pelas trilhas de funil
 * (D95) — e a base do audit control do HIPAA §164.312(b) para a entrada nos EUA.
 *
 * Três decisões que o design fixou e este arquivo respeita:
 *
 * 1. **Granularidade por RECURSO, não por query** (spec sensitive-access-log): a
 *    tela de dossiê dispara dezenas de queries; aqui sai UMA linha por abertura,
 *    porque o gancho é o endpoint, não o SQL.
 * 2. **Assíncrono e fail-safe**: a gravação sai depois do `finish` da resposta e
 *    qualquer erro dela vira log, nunca 500. Auditoria não derruba atendimento.
 * 3. **Só abertura BEM-SUCEDIDA vira linha.** 404/403 não revelaram nada — e sob
 *    RLS um paciente de outro país É 404. Tentativa frustrada não é acesso.
 */

import type { Request, RequestHandler, Response } from 'express';
import { logger } from '@shared/logging';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { currentDbContext, withSystemDbContext, type DbSessionContext } from '@shared/database/requestDbSession';

export type ResourceType = 'patient' | 'worker';
export type AccessOrigin = 'same_country' | 'group_grant' | 'system';

/** De onde sai o país do recurso, para classificar a origem do acesso. */
const COUNTRY_SOURCE: Record<ResourceType, string> = {
  patient: 'SELECT country FROM patients WHERE id = $1',
  worker: 'SELECT country FROM workers WHERE id = $1',
};

export interface ResourceAccessEntry {
  operatorUid: string;
  operatorRole: string;
  resourceType: ResourceType;
  resourceId: string;
  action: string;
  origin: AccessOrigin;
}

/**
 * Grava a linha. Nunca lança: erro vira log com os campos, para reprocessamento
 * manual (a tabela é append-only e particionada — ver migration 270).
 */
export async function recordResourceAccess(entry: ResourceAccessEntry): Promise<void> {
  try {
    const pool = DatabaseConnection.getInstance().getPool();
    await withSystemDbContext('job:resource-access-log', () =>
      pool.query(
        `INSERT INTO resource_access_log
           (operator_uid, operator_role, resource_type, resource_id, action, origin)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          entry.operatorUid,
          entry.operatorRole,
          entry.resourceType,
          entry.resourceId,
          entry.action,
          entry.origin,
        ],
      ),
    );
  } catch (err) {
    logger.error({ err, ...entry }, '[abac] falha ao gravar resource_access_log — acesso NÃO registrado');
  }
}

/**
 * Classifica como o operador alcançou o recurso.
 *
 * Contexto não-staff (cron, webhook, capability) é `system` sem consulta nenhuma.
 * Para staff, compara o país do recurso com o do operador — a leitura do país sai
 * sob contexto de sistema porque, com a RLS valendo, a sessão da request já foi
 * encerrada quando esta função roda.
 *
 * País do recurso indeterminado (linha sumiu, erro de banco) → `group_grant`
 * DELIBERADAMENTE: numa trilha de compliance, sinalizar um acesso que talvez não
 * fosse cross-país custa uma conferência; deixar passar um que era custa o
 * incidente. Vem com log próprio para não virar ruído silencioso.
 */
export async function resolveAccessOrigin(
  context: DbSessionContext | undefined,
  resourceType: ResourceType,
  resourceId: string,
): Promise<AccessOrigin> {
  if (!context || context.kind !== 'staff') return 'system';
  if (!context.country) return 'group_grant';

  try {
    const pool = DatabaseConnection.getInstance().getPool();
    const result = await withSystemDbContext('job:resource-access-log', () =>
      pool.query<{ country: string | null }>(COUNTRY_SOURCE[resourceType], [resourceId]),
    );
    const country = result.rows[0]?.country;
    if (!country) {
      logger.warn(
        { resourceType, resourceId },
        '[abac] país do recurso indeterminado na trilha de leitura — classificado como cross-país',
      );
      return 'group_grant';
    }
    return country === context.country ? 'same_country' : 'group_grant';
  } catch (err) {
    logger.warn({ err, resourceType, resourceId }, '[abac] falha ao classificar origem do acesso');
    return 'group_grant';
  }
}

/**
 * Middleware para rotas de DETALHE/dossiê. Aplicar depois do guard de auth (o
 * operador precisa já estar resolvido) e antes do handler.
 *
 * @param resourceType tipo do recurso lido
 * @param action rótulo da ação, ex.: `read_detail`
 * @param idFrom de onde tirar o id (default: `req.params.id`)
 */
export function logResourceAccess(
  resourceType: ResourceType,
  action = 'read_detail',
  idFrom: (req: Request) => string | undefined = (req) => req.params.id,
): RequestHandler {
  return (req, res, next) => {
    const resourceId = idFrom(req);
    const user = req.user;
    // Sem id ou sem operador identificado não há o que afirmar na trilha.
    if (!resourceId || !user?.uid) return next();

    // Congela o contexto AGORA: no `finish` o ALS da request pode não valer mais.
    const context = currentDbContext();
    const operatorRole = user.roles?.[0] ?? user.role ?? 'unknown';

    res.once('finish', () => {
      if (!isSuccessful(res)) return;
      void (async () => {
        const origin = await resolveAccessOrigin(context, resourceType, resourceId);
        await recordResourceAccess({
          operatorUid: user.uid,
          operatorRole,
          resourceType,
          resourceId,
          action,
          origin,
        });
      })();
    });

    next();
  };
}

function isSuccessful(res: Response): boolean {
  return res.statusCode >= 200 && res.statusCode < 300;
}
