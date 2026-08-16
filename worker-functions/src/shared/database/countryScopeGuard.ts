/**
 * src/shared/database/countryScopeGuard.ts
 *
 * Cortesia de UX por cima da RLS (ABAC país Fase 1, task 3.5) — **nunca**
 * substituto dela. A segurança é a policy do banco; isto só troca um resultado
 * mudo por uma explicação.
 *
 * Cabe exatamente onde o operador DECLARA um país na request (`?country=BR` nos
 * painéis de pacientes, e a criação de paciente da task 5.1). Aí não há
 * vazamento em responder: o país veio de quem perguntou, não do banco. Para
 * DETALHE por id continua valendo o 404 indistinguível de inexistente (spec
 * country-isolation) — dizer "403, existe mas não é seu" confirmaria a
 * existência da pessoa.
 *
 * Sob RLS e sem este guard, o pedido cross-país não erraria: voltaria com
 * contadores zerados, que o operador leria como "não há pacientes no Brasil".
 *
 * Gated por `COUNTRY_RLS_ENABLED` de propósito: enquanto a virada não acontece,
 * ninguém tem claim de país, e enforcement aqui recusaria filtro que hoje
 * funciona. Prod neutro até a task 4.3.
 */

import type { Request, RequestHandler } from 'express';
import type { Pool } from 'pg';
import { logger } from '@shared/logging';
import { DatabaseConnection } from './DatabaseConnection';
import { currentDbContext, isCountryCode, isCountryRlsEnabled } from './requestDbSession';

/**
 * Mesma FONTE da policy RLS de país (migrations 276/278): `iam.effective_countries`
 * — países dos grupos VIVOS do staff (ACTIVE, grupo não-arquivado, vínculo
 * não-removido, escopo não-revogado), resolvidos NO banco. Guard e policy não podem
 * divergir porque chamam a mesma função (lex C3; D115). O guard só antecipa a
 * resposta para explicar: se a policy negar, é a policy que vale.
 */
const LIVE_GRANT_SQL = `
  SELECT $2 = ANY (iam.effective_countries($1, iam.current_tenant_id())) AS granted`;

export async function hasLiveCountryGrant(uid: string, country: string, pool?: Pool): Promise<boolean> {
  const db = pool ?? DatabaseConnection.getInstance().getPool();
  const result = await db.query<{ granted: boolean | null }>(LIVE_GRANT_SQL, [uid, country]);
  return result.rows[0]?.granted === true;
}

/**
 * @param readCountry de onde sai o país pedido (query, body...). Ausente ⇒ o
 * guard não opina: quem recorta é a RLS.
 */
export function requireCountryScope(
  readCountry: (req: Request) => unknown = (req) => req.query.country,
): RequestHandler {
  return async (req, res, next) => {
    if (!isCountryRlsEnabled()) return next();

    const requested = readCountry(req);
    if (requested === undefined || requested === null || requested === '') return next();

    const context = currentDbContext();
    // Sistema/webhook/capability não tem jurisdição própria — segue.
    if (context?.kind !== 'staff') return next();

    if (!isCountryCode(requested)) {
      res.status(400).json({ success: false, error: 'Invalid country', detail: 'País deve ser AR ou BR.' });
      return;
    }

    if (!context.country) {
      res.status(403).json({
        success: false,
        error: 'Country scope required',
        detail: 'Sua conta não tem jurisdição atribuída. Peça a atribuição do país ao admin.',
      });
      return;
    }

    // País do próprio operador (claim): hoje a policy (271/274) ainda tem o ramo
    // `country = claim`, então o guard acompanha. Quando a 278 (grant-only, D114) for
    // aplicada no ambiente (task 5.4), este atalho SAI: o claim vira atributo e só o
    // grant do grupo concede — o país "próprio" passa a ser mais uma linha em
    // effective_countries.
    if (requested === context.country) return next();

    try {
      if (context.uid && (await hasLiveCountryGrant(context.uid, requested))) return next();
    } catch (err) {
      // Falha ao checar o grant não pode virar acesso: a RLS ainda protege o
      // dado, então seguir daria uma tela vazia sem explicação. 403 é honesto.
      logger.error({ err, uid: context.uid, requested }, '[abac] falha ao verificar grant de país');
    }

    logger.warn(
      { uid: context.uid, operatorCountry: context.country, requested },
      '[abac] pedido cross-país sem grant recusado no guard de UX',
    );
    res.status(403).json({
      success: false,
      error: 'Country scope required',
      detail: `Sua conta opera em ${context.country}. Ver dados de ${requested} exige um grupo com escopo para esse país.`,
    });
  };
}
