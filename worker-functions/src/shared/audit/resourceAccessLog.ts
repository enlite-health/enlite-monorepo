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

import { createHash } from 'crypto';
import type { Request, RequestHandler, Response } from 'express';
import { logger } from '@shared/logging';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { currentDbContext, withSystemDbContext, type DbSessionContext } from '@shared/database/requestDbSession';

export type ResourceType = 'patient' | 'worker';
export type AccessOrigin = 'same_country' | 'group_grant' | 'system';

/** Rótulo único de contexto de sistema desta trilha (um por ciclo de gravação). */
const SYSTEM_LABEL = 'job:resource-access-log';

/** De onde sai o país do recurso, para classificar a origem do acesso. */
const COUNTRY_SOURCE: Record<ResourceType, string> = {
  patient: 'SELECT country FROM patients WHERE id = $1',
  worker: 'SELECT country FROM workers WHERE id = $1',
};

/**
 * Identificador do recurso para LOG — nunca o id cru.
 *
 * [lex C2] O log de erro da trilha carrega o uid do operador; somar a ele o id
 * do paciente publicaria no Cloud Logging exatamente o vínculo
 * operador↔paciente que a trilha existe para guardar em tabela auditada e de
 * acesso restrito. O hash curto ainda permite correlacionar duas linhas do log
 * entre si (mesmo recurso) sem revelar de quem se trata.
 */
function resourceIdHash(resourceId: string): string {
  return createHash('sha256').update(resourceId).digest('hex').slice(0, 12);
}

export interface ResourceAccessEntry {
  operatorUid: string;
  operatorRole: string;
  resourceType: ResourceType;
  resourceId: string;
  action: string;
  origin: AccessOrigin;
}

/** INSERT puro — pressupõe contexto de sistema JÁ declarado por quem chama. */
async function insertAccessRow(entry: ResourceAccessEntry): Promise<void> {
  const pool = DatabaseConnection.getInstance().getPool();
  await pool.query(
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
  );
}

/**
 * Log de falha da trilha. Campos suficientes para reprocessar (a tabela é
 * append-only e particionada — migration 270) e NENHUM identificador direto de
 * paciente/prestador: o id vai hasheado (ver `resourceIdHash`).
 */
function logAccessFailure(err: unknown, entry: ResourceAccessEntry): void {
  logger.error(
    {
      err,
      operatorUid: entry.operatorUid,
      operatorRole: entry.operatorRole,
      resourceType: entry.resourceType,
      resourceIdHash: resourceIdHash(entry.resourceId),
      action: entry.action,
      origin: entry.origin,
    },
    '[abac] falha ao gravar resource_access_log — acesso NÃO registrado',
  );
}

/**
 * Grava a linha. Nunca lança: erro vira log, para reprocessamento manual.
 *
 * Declara o contexto de sistema por conta própria — é o caminho para quem chama
 * a gravação isolada. O middleware abaixo usa um contexto só para leitura do
 * país + INSERT (um ciclo de sessão, não dois).
 */
export async function recordResourceAccess(entry: ResourceAccessEntry): Promise<void> {
  try {
    await withSystemDbContext(SYSTEM_LABEL, () => insertAccessRow(entry));
  } catch (err) {
    logAccessFailure(err, entry);
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
  return withSystemDbContext(SYSTEM_LABEL, () =>
    resolveAccessOriginUnderSystemContext(context, resourceType, resourceId),
  );
}

/** Mesma classificação, pressupondo contexto de sistema já declarado. */
async function resolveAccessOriginUnderSystemContext(
  context: DbSessionContext,
  resourceType: ResourceType,
  resourceId: string,
): Promise<AccessOrigin> {
  if (!context.country) return 'group_grant';

  try {
    const pool = DatabaseConnection.getInstance().getPool();
    const result = await pool.query<{ country: string | null }>(COUNTRY_SOURCE[resourceType], [
      resourceId,
    ]);
    const country = result.rows[0]?.country;
    if (!country) {
      logger.warn(
        { resourceType, resourceIdHash: resourceIdHash(resourceId) },
        '[abac] país do recurso indeterminado na trilha de leitura — classificado como cross-país',
      );
      return 'group_grant';
    }
    return country === context.country ? 'same_country' : 'group_grant';
  } catch (err) {
    logger.warn(
      { err, resourceType, resourceIdHash: resourceIdHash(resourceId) },
      '[abac] falha ao classificar origem do acesso',
    );
    return 'group_grant';
  }
}

/**
 * Middleware para rotas de DETALHE/dossiê. Aplicar depois do guard de auth (o
 * operador precisa já estar resolvido) e antes do handler.
 *
 * @param resourceType tipo do recurso lido
 * @param action rótulo da ação, ex.: `read_detail` — ou função da request, avaliada no `finish`,
 *   para a linha carregar o conjunto ENUMERADO de containers servidos (`read_detail:contact+dossier`)
 * @param idFrom de onde tirar o id (default: `req.params.id`)
 */
export function logResourceAccess(
  resourceType: ResourceType,
  action: string | ((req: Request) => string) = 'read_detail',
  idFrom: (req: Request) => string | undefined = (req) => req.params.id,
): RequestHandler {
  return (req, res, next) => {
    const user = req.user;
    // Sem operador identificado não há o que afirmar na trilha.
    if (!user?.uid) return next();

    // Congela o contexto AGORA: no `finish` o ALS da request pode não valer mais.
    // ⚠️ O CONTEXTO é congelado aqui; o ID **não**. Rota que descobre o recurso
    // só DENTRO do handler (`by-phone` resolve o worker pelo telefone, C6) não
    // tem id nenhum neste ponto — antes desta mudança ela saía por `next()` e
    // ficava sem trilha, em silêncio. Para quem usa `req.params.id`, avaliar
    // antes ou depois dá o mesmo valor: o param não muda no meio da request.
    const context = currentDbContext();
    const operatorRole = user.roles?.[0] ?? user.role ?? 'unknown';

    res.once('finish', () => {
      if (!isSuccessful(res)) return;
      const resourceId = idFrom(req);
      if (!resourceId) return;
      // UM ciclo de contexto de sistema para a leitura do país E o INSERT: são
      // duas queries da mesma trilha, e abrir duas sessões (dois clients, dois
      // pares de set_config) dobraria o custo de cada abertura de dossiê.
      // D286: `action` pode ser derivada da request no `finish` — é assim que a linha diz QUE
      // containers da ficha saíram (`read_detail:contact+dossier`), valor ENUMERADO, sem dado.
      const entryBase = { operatorUid: user.uid, operatorRole, resourceType, resourceId, action: typeof action === 'function' ? action(req) : action };
      void withSystemDbContext(SYSTEM_LABEL, async () => {
        const origin =
          !context || context.kind !== 'staff'
            ? ('system' as const)
            : await resolveAccessOriginUnderSystemContext(context, resourceType, resourceId);
        await insertAccessRow({ ...entryBase, origin });
      }).catch((err) => logAccessFailure(err, { ...entryBase, origin: 'system' }));
    });

    next();
  };
}

function isSuccessful(res: Response): boolean {
  return res.statusCode >= 200 && res.statusCode < 300;
}
