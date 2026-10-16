/**
 * admissionHarnessKit — peças que os harness da admissão (spec 049/050) repetiam: escopo de variáveis de ambiente que se desfaz no
 * `afterAll`, a conexão sob RLS (runtime × dono), o `AuthMiddleware` de verdade e a criação de bucket no fake-gcs. Zero regra de negócio.
 */
import { urlFor } from './loginRoles';

export interface EscopoDeEnv {
  set(k: string, v: string | undefined): void;
  setAll(vars: Record<string, string | undefined>): void;
  restaurar(): void;
}

/** `set` guarda o valor anterior na 1ª troca de cada chave; `restaurar` devolve tudo (apaga a chave que não existia). */
export function criarEscopoDeEnv(): EscopoDeEnv {
  const anterior: Record<string, string | undefined> = {};
  const escopo: EscopoDeEnv = {
    set(k, v) {
      if (!(k in anterior)) anterior[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    },
    setAll(vars) {
      for (const [k, v] of Object.entries(vars)) escopo.set(k, v);
    },
    restaurar() {
      for (const [k, v] of Object.entries(anterior)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
  return escopo;
}

/** Env da conexão: `runtime` = login membro de `app_runtime` + pool de sistema `app_system`; `dono` = o dono do banco (bypassa RLS). */
export function configurarConexaoRls(
  env: EscopoDeEnv,
  o: { conexao: 'runtime' | 'dono'; databaseUrl: string; runtimeUser: string; systemUser: string; senha: string; secret: string },
): void {
  const runtime = o.conexao === 'runtime';
  env.set('DATABASE_URL', runtime ? urlFor(o.databaseUrl, o.runtimeUser, o.senha) : o.databaseUrl);
  env.set('DATABASE_SYSTEM_URL', runtime ? urlFor(o.databaseUrl, o.systemUser, o.senha) : undefined);
  env.set('COUNTRY_RLS_ENABLED', 'true');
  env.set('USE_MOCK_AUTH', 'true');
  env.set('DB_POOL_MAX', '4');
  env.set('DB_SYSTEM_POOL_MAX', '2');
  env.set('INTERNAL_TOKEN_SECRET', o.secret);
}

/** O `AuthMiddleware` de produção (MultiAuthService + motor simplificado) sobre o pool da conexão já configurada. */
export async function montarAuthDeProducao() {
  const [identity, { DatabaseConnection }] = await Promise.all([import('@modules/identity'), import('@shared/database/DatabaseConnection')]);
  const auth = new identity.AuthMiddleware(
    new identity.MultiAuthService({ enableApiKeys: true, enableJwt: false, enableGoogleIdToken: true }, DatabaseConnection.getInstance().getPool()),
    new identity.SimplifiedAuthorizationEngine(),
  );
  return { auth, DatabaseConnection };
}

export async function criarBucketNoFakeGcs(fakeGcsUrl: string, name: string): Promise<void> {
  const res = await fetch(`${fakeGcsUrl}/storage/v1/b?project=enlite-test`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  });
  if (!res.ok && res.status !== 409) throw new Error(`fake-gcs: bucket ${name} -> ${res.status}`);
}


/**
 * Barreira de concorrência: ligada, quem chega espera (até `esperaMs`) a OUTRA requisição chegar — prova de que um lock serializa
 * (sem o lock as duas chegam juntas; com ele a 2ª nem chega e a 1ª passa depois do prazo).
 */
export function criarBarreiraDeRequisicoes(esperaMs = 600) {
  const barreira = {
    ligada: false,
    chegadas: 0,
    async esperarOutra(): Promise<void> {
      if (!barreira.ligada) return;
      barreira.chegadas += 1;
      const ate = Date.now() + esperaMs;
      while (barreira.chegadas < 2 && Date.now() < ate) await new Promise((r) => setTimeout(r, 10));
    },
  };
  return barreira;
}
