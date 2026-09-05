/**
 * cli-guards — F1-CORREÇÃO D10 (spec 016). Duas falhas de parsing de CLI que já produziram
 * dado errado em produção sintética:
 *
 * 1. `--promote` sem valor caía no ramo de CRAWL (flagValue devolve `undefined`, indistinguível
 *    de "flag ausente") e REESCREVIA o catálogo quando a intenção era só promover. Ver
 *    `__tests__/cli-guards.test.ts`.
 * 2. `--release <X>` aceito sem checar se bate com o release EMBUTIDO na URL de `--api-base`
 *    (`.../icd/release/11/<release>/mms`). Foi exatamente essa divergência (release declarado
 *    != release da API de fato consultada) que produziu o D1: o operador rodou
 *    `--release 2026-05` contra `--api-base .../2026-01/mms`, e o ingestor gravou dado do
 *    release 2026-01 sob o rótulo "2026-05" sem avisar. Isso agora é ERRO, não aviso.
 *
 * Puro — sem HTTP, sem `pg`. Testável isoladamente (ver __tests__).
 */
const API_BASE_RELEASE_MARKER = '/icd/release/11/';

export class InvalidCliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidCliUsageError';
  }
}

/**
 * Lê o valor de `--promote` dos args. Três casos:
 * - flag ausente → `undefined` (uso normal: crawl).
 * - flag presente com valor (próximo item não é outra flag) → o valor.
 * - flag presente SEM valor (é o último arg, ou o próximo item começa com `--`) → lança
 *   `InvalidCliUsageError` — nunca cai silenciosamente no ramo de crawl.
 */
export function parsePromoteFlag(args: readonly string[]): string | undefined {
  const idx = args.indexOf('--promote');
  if (idx === -1) return undefined;

  const value = args[idx + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new InvalidCliUsageError(
      '--promote exige um valor de release (ex.: --promote 2026-01 --by nome). Sem valor, ' +
        'o comando seria ambíguo com "sem --promote" — que crawla e REESCREVE o catálogo.',
    );
  }
  return value;
}

/** Extrai o release embutido no path de `--api-base` (.../icd/release/11/<release>/mms...). */
export function extractReleaseFromApiBase(apiBase: string): string | null {
  const markerIdx = apiBase.indexOf(API_BASE_RELEASE_MARKER);
  if (markerIdx === -1) return null;
  const afterMarker = apiBase.slice(markerIdx + API_BASE_RELEASE_MARKER.length);
  const release = afterMarker.split('/')[0];
  return release || null;
}

/**
 * Garante que o `--release` declarado bate com o release de fato servido por `--api-base`.
 * Divergência é ERRO (não promove/ingere nada silenciosamente sob o rótulo errado) — é a defesa
 * de entrada que fecha o caminho que produziu o D1. Se `--api-base` não seguir o formato
 * esperado (marcador ausente), também é erro: sem conseguir validar, falha visível em vez de
 * assumir que está certo.
 */
export function assertReleaseMatchesApiBase(release: string, apiBase: string): void {
  const releaseFromApiBase = extractReleaseFromApiBase(apiBase);
  if (releaseFromApiBase === null) {
    throw new InvalidCliUsageError(
      `--api-base "${apiBase}" não contém o marcador "${API_BASE_RELEASE_MARKER}<release>/mms" — ` +
        'não dá para confirmar que --release corresponde ao que a API realmente serve.',
    );
  }
  if (releaseFromApiBase !== release) {
    throw new InvalidCliUsageError(
      `--release "${release}" não bate com o release da URL de --api-base ("${releaseFromApiBase}"). ` +
        'Isso já gravou dado de um release sob o rótulo de outro (D1) — corrija --release ou --api-base.',
    );
  }
}

/**
 * Lê `--concurrency`. `Number('abc')` é `NaN`, e `NaN` workers significava CRAWL VAZIO: o
 * ingestor imprimia `✅ Ingestão concluída` com ZERO entidades e saía com código 0 — contagem
 * zero tratada como sucesso, que é o modo de falha que o CLAUDE.md nomeia. Achado do gate
 * `revisao-pr` (BLOQUEADOR 4). Agora valor não-numérico, zero ou negativo é ERRO, não default
 * silencioso: default só quando a flag está AUSENTE.
 */
export function parseConcurrencyFlag(args: readonly string[], padrao = 16): number {
  const idx = args.indexOf('--concurrency');
  if (idx === -1) return padrao;

  const bruto = args[idx + 1];
  if (bruto === undefined || bruto.startsWith('--')) {
    throw new InvalidCliUsageError('--concurrency exige um valor inteiro positivo (ex.: --concurrency 16).');
  }
  const n = Number(bruto);
  if (!Number.isInteger(n) || n < 1 || n > 64) {
    throw new InvalidCliUsageError(
      `--concurrency "${bruto}" não é inteiro entre 1 e 64. Valor inválido virava NaN e o crawl ` +
        'terminava com ZERO entidades anunciando sucesso.',
    );
  }
  return n;
}
