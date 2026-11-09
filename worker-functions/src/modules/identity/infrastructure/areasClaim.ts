/**
 * Claims `areas` + `pid` (design §3, V1 09/11): recalculados INTEIROS do registro, nunca por delta, e gravados por
 * `mergeCustomClaims` (preserva `role`, `account_type`, `country`) em CADA login vivo da árvore da pessoa.
 *
 * V1: o `areas` varia por LOGIN. Para cada uid o principal é montado como o portão o monta
 * (`FirebaseAuthStrategy.authenticateProduction`): claims atuais `account_type`/`role`; claim que falta vem de `users`
 * por uid OU e-mail com `is_active`, e `accountTypeOf` (a mesma função, exportada de lá) faz a ponte pelo papel.
 * `backoffice`·staff sai de `isStaffAccount(principal)` dentro do `ListPersonAreasUseCase`; o resto, da árvore.
 */
import * as admin from 'firebase-admin';
import { Result } from '@shared/utils/Result';
import { ListPersonAreasUseCase, type AreaRegistryReader } from '../application/ListPersonAreasUseCase';
import { mergeCustomClaims } from './mergeCustomClaims';
import { accountTypeOf } from './FirebaseAuthStrategy';

/** Teto do Firebase para o objeto de custom claims inteiro. */
export const MAX_CLAIMS_BYTES = 1000;

export type AreasClaim = Record<string, string[]>;

/** Porta de logins da árvore e do fallback de identidade (mesma consulta do portão). */
export interface LoginDirectory {
  /** `iam.person_login_uids(pid)` — logins vivos da árvore da pessoa. */
  loginUids(pid: string): Promise<string[]>;
  /** `users` por uid OU e-mail com `is_active` — só chamada quando falta `role` ou `account_type` no claim. */
  identityFromUsers(uid: string, email?: string): Promise<{ role: string | null; account_type: string | null } | null>;
}

export interface SyncAreasClaimsOptions {
  /** Revogação encerra as sessões: `revokeRefreshTokens` em cada login vivo. */
  revokeTokens: boolean;
}

export interface SyncAreasClaimsResult {
  uids: string[];
  /** Logins cujo Firebase falhou na escrita (os demais foram gravados). */
  failedUids: string[];
}

export function claimsBytes(claims: Record<string, unknown>): number {
  return Buffer.byteLength(JSON.stringify(claims), 'utf8');
}

async function areasForLogin(
  uid: string,
  pid: string,
  registry: AreaRegistryReader,
  dir: LoginDirectory,
): Promise<{ areas: AreasClaim; claims: Record<string, unknown> }> {
  const user = await admin.auth().getUser(uid);
  const claims = (user.customClaims ?? {}) as Record<string, unknown>;
  const claimRole = claims.role as string | undefined;
  const claimAccountType = claims.account_type as string | undefined;
  const fromDb = claimRole && claimAccountType ? null : await dir.identityFromUsers(uid, user.email);
  const role = claimRole ?? fromDb?.role ?? null;
  const accountType = accountTypeOf(claimAccountType ?? fromDb?.account_type, role);
  const principal = { roles: role ? [role] : [], ...(accountType ? { accountType } : {}) };

  const listed = await new ListPersonAreasUseCase(registry).execute({ principal, pid });
  if (listed.isFailure) throw new Error(listed.error);
  const areas: AreasClaim = {};
  for (const { area, role: r } of listed.getValue()) (areas[area] ??= []).push(r);
  return { areas, claims };
}

export async function syncAreasClaims(
  pid: string,
  registry: AreaRegistryReader,
  dir: LoginDirectory,
  opts: SyncAreasClaimsOptions,
): Promise<Result<SyncAreasClaimsResult>> {
  try {
    const uids = await dir.loginUids(pid);
    // 1) calcula TUDO antes de escrever: um login acima do teto recusa a operação inteira, sem truncar e sem escrita parcial.
    const plan: Array<{ uid: string; patch: { pid: string; areas: AreasClaim } }> = [];
    for (const uid of uids) {
      const { areas, claims } = await areasForLogin(uid, pid, registry, dir);
      const patch = { pid, areas };
      const bytes = claimsBytes({ ...claims, ...patch });
      if (bytes > MAX_CLAIMS_BYTES) {
        return Result.fail(`claims do login excedem ${MAX_CLAIMS_BYTES} bytes (${bytes}); nada foi gravado no Firebase`);
      }
      plan.push({ uid, patch });
    }
    // 2) grava em cada login vivo; falha de um não impede os outros.
    const failedUids: string[] = [];
    for (const { uid, patch } of plan) {
      try {
        await mergeCustomClaims(uid, patch);
        if (opts.revokeTokens) await admin.auth().revokeRefreshTokens(uid);
      } catch {
        failedUids.push(uid);
      }
    }
    return Result.ok({ uids, failedUids });
  } catch (error) {
    return Result.fail(error instanceof Error ? error.message : 'Failed to sync areas claims');
  }
}
