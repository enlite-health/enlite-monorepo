/**
 * Guard against issuing a signed READ url — or a DELETE, or a SAVE — for an
 * arbitrary file path.
 *
 * `getViewSignedUrl` on both the worker self-service and the admin routes
 * takes a `filePath` straight from the request body and, before this guard
 * existed, signed it unconditionally — so any authenticated caller could
 * read ANY worker's document (or, for the admin route, any path at all,
 * including one that never belonged to `:id`) just by naming its path.
 *
 * `resolveDocumentRelativePath` normalizes a client-supplied path/URL to the
 * relative GCS object path: it percent-decodes the input once, then rejects
 * anything that isn't a plain relative path inside THIS bucket — path
 * traversal (`..`), an encoded traversal (`%2e%2e`), a leading slash or
 * backslash, a doubled slash, a stray `?`/`#`, an absolute filesystem path,
 * or an absolute URL to a different host/bucket.
 *
 * Hotfix 13/09 (extensão — trava por PREFIXO do dono, não só pelo registro):
 * o guard original só comparava o caminho pedido contra os caminhos
 * GRAVADOS no registro do worker (`assertDocumentPathBelongsToWorker`). Mas
 * os endpoints de SAVE (`WorkerDocumentsMeController.saveDocumentPath`,
 * `WorkerAdditionalDocsMeController.save`, `AdminAdditionalDocsController.save`,
 * `AdminWorkerDocumentsController.saveDocumentPath`) aceitavam `filePath` do
 * corpo sem checar prefixo — um worker A podia GRAVAR o caminho do
 * documento de B no PRÓPRIO registro (o guard antigo aprovava a leitura:
 * "está no registro de A") e então DELETAR o objeto do caminho gravado,
 * apagando o arquivo de B.
 *
 * Hotfix 13/09, RODADA 2 (gate `revisao-pr` bloqueou a rodada 1 por
 * regressão funcional): a rodada 1 introduziu uma SEGUNDA checagem —
 * `matchesOwnedDocumentPathShape`, a forma EXATA
 * `workers/<workerId>/(<docType fixo>|additional)/<uuid>.<pdf|jpg|png>` —
 * e exigia as DUAS (prefixo + forma) para o guard de VIEW
 * (`assertDocumentPathBelongsToWorker`). Isso fechava a vulnerabilidade
 * original, mas quebrava três fluxos legítimos que nunca tiveram essa
 * forma:
 *   - documento ADICIONAL: o `filePath` fica em `worker_additional_documents`,
 *     nunca em `worker_documents` — o guard de VIEW só olhava as 11 colunas
 *     fixas, então mesmo um caminho na forma certa (`.../additional/<uuid>.pdf`)
 *     nunca estava entre os `ownedPaths` passados pelo controller;
 *   - documento INGERIDO via MCP/WhatsApp
 *     (`IngestDocumentFromUrlUseCase.ts:116`:
 *     `workers/<workerId>/ingested/<documentType>/<timestamp-ms>`, sem
 *     extensão e sem UUID) — nunca bate a forma exata;
 *   - qualquer caminho legado gravado antes deste padrão de upload existir.
 *
 * A correção da rodada 2: o guard de VIEW volta a exigir só (i) o caminho
 * normalizado, (ii) o PREFIXO `workers/<workerId>/` do dono, e (iii)
 * pertencer à lista de caminhos de fato GRAVADOS do worker — a mesma
 * checagem de PREFIXO que SAVE e a 2ª camada (`GCSStorageService`) sempre
 * usaram (`matchesOwnedDocumentPrefix`). A checagem de FORMA EXATA
 * (`matchesOwnedDocumentPathShape`/`buildOwnedDocumentPathPattern`) foi
 * removida — ficou sem nenhum uso depois desta mudança, e mantê-la morta
 * seria dívida sem função: a segurança não vem da forma do caminho, vem de
 * (ii) + (iii) juntos — path fora do prefixo do dono NUNCA passa, e path
 * dentro do prefixo só é aceito se estiver gravado no registro do PRÓPRIO
 * worker (não basta "parecer" um documento — tem de SER um documento dele).
 */

const ABSOLUTE_URL_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

function percentDecodeOrNull(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function hasUnsafeShape(path: string): boolean {
  return (
    path.length === 0 ||
    path.startsWith('/') ||
    path.startsWith('\\') ||
    path.includes('..') ||
    path.includes('\\') ||
    path.includes('//') ||
    path.includes('?') ||
    path.includes('#')
  );
}

export function resolveDocumentRelativePath(rawPath: unknown, bucketName: string): string | null {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return null;

  const bucketPrefix = `https://storage.googleapis.com/${bucketName}/`;
  let path = rawPath;

  if (path.startsWith(bucketPrefix)) {
    path = path.slice(bucketPrefix.length).split('?')[0];
  } else if (ABSOLUTE_URL_RE.test(path)) {
    // Absolute URL to a different host, or a different bucket on GCS itself.
    return null;
  }

  // Percent-decode once: `%2e%2e` (traversal) e `%2f` (barra) chegam como
  // string literal até aqui — sem isto, "workers/x/%2e%2e/y" passaria pelos
  // checks de ".." abaixo sem ser reconhecido como traversal.
  const decoded = percentDecodeOrNull(path);
  if (decoded === null) return null;
  path = decoded;

  if (hasUnsafeShape(path)) return null;

  return path;
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Regex do PREFIXO de um documento do PRÓPRIO `workerId`: `workers/<workerId>/`
 * seguido de qualquer coisa (sem traversal — já garantido por
 * `resolveDocumentRelativePath`).
 */
export function buildOwnedDocumentPrefixPattern(workerId: string): RegExp {
  return new RegExp(`^workers/${escapeForRegex(workerId)}/`, 'i');
}

/**
 * true quando o caminho normalizado começa por `workers/<workerId>/` — a
 * checagem de PREFIXO. Não confere tipo de documento, extensão nem forma de
 * uuid — só que o caminho está dentro do namespace do PRÓPRIO worker. É a
 * ÚNICA checagem de forma usada em todo o guard (SAVE, VIEW e a 2ª camada em
 * `GCSStorageService`) — ver nota da rodada 2 no topo do arquivo.
 */
export function matchesOwnedDocumentPrefix(
  rawPath: unknown,
  bucketName: string,
  workerId: string,
): boolean {
  const normalized = resolveDocumentRelativePath(rawPath, bucketName);
  if (!normalized) return false;
  return buildOwnedDocumentPrefixPattern(workerId).test(normalized);
}

/**
 * true só quando o caminho pedido (a) está dentro do PREFIXO do próprio
 * `workerId` — `matchesOwnedDocumentPrefix` — E (b) bate com um dos
 * caminhos de fato GRAVADOS no registro do worker (`ownedPaths`) — a união
 * das 11 colunas fixas de `worker_documents`, `additional_certificates_urls`
 * e `worker_additional_documents.file_path`, montada pelo controller
 * chamador. Não exige mais a forma exata de upload (rodada 2) — ver nota no
 * topo do arquivo.
 */
export function assertDocumentPathBelongsToWorker(
  rawPath: unknown,
  bucketName: string,
  workerId: string,
  ownedPaths: Array<string | null | undefined>,
): boolean {
  const normalized = resolveDocumentRelativePath(rawPath, bucketName);
  if (!normalized) return false;
  if (!buildOwnedDocumentPrefixPattern(workerId).test(normalized)) return false;

  return ownedPaths.some((stored) => {
    if (!stored) return false;
    const storedNormalized = resolveDocumentRelativePath(stored, bucketName);
    return storedNormalized !== null && storedNormalized === normalized;
  });
}
