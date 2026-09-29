/**
 * src/shared/utils/envFlag.ts
 *
 * Leitura de flag booleana de ambiente, num lugar só.
 *
 * Existe porque a change `painel-grupos-permissao` chegou a ter TRÊS formas do
 * mesmo teste (`flagOn(env, name)` no middleware, `flagOn(name)` no bootstrap e
 * `env.X === 'true'` cru no guard) — e três formas do mesmo booleano é como
 * nasce a que esquece o `=== 'true'` e liga a flag com `'false'`.
 *
 * Só `'true'` liga, de propósito: `'1'`, `'yes'` e `'True'` NÃO ligam. É a
 * convenção que o resto do serviço já usa (`COUNTRY_RLS_ENABLED`,
 * `USE_MOCK_AUTH`, `MCP_ENABLED`), e aceitar variações aqui faria o mesmo valor
 * significar coisas diferentes dependendo de quem lê.
 * `isEnvFlagOff` é o espelho para flag de padrão LIGADO (cadeia Fase 15, `ENLITE_DERIVACAO_ESTADO`).
 */

/** `true` só quando a env vale exatamente `'true'`. */
export function isEnvFlagOn(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return env[name] === 'true';
}

/**
 * O espelho de `isEnvFlagOn` para flag de PADRÃO LIGADO: só o literal `'off'` desliga
 * (`'false'`, `'0'`, `'OFF'` NÃO desligam — a mesma regra de um literal só).
 */
export function isEnvFlagOff(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return env[name] === 'off';
}
