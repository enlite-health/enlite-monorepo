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
 * Duas checagens de FORMA, com escopos diferentes — medido contra a suíte
 * e2e existente (17 testes legítimos gravam/apagam caminho fora do padrão
 * `<uuid>.<ext>`, ex. fixtures como `workers/<id>/resume_cv/test.pdf`, sem
 * jamais atravessar workerId — exigir o padrão INTEIRO ali quebrava
 * comportamento correto sem fechar brecha nenhuma):
 *
 *   - `matchesOwnedDocumentPrefix` — só o PREFIXO: `workers/<workerId>/...`,
 *     normalizado (sem traversal/URL de outro host). É o suficiente para
 *     fechar a vulnerabilidade (worker nunca escreve/lê/apaga fora do
 *     próprio prefixo) e é o que os 3 endpoints de SAVE e o
 *     `GCSStorageService` (2ª camada, view E delete) usam.
 *   - `matchesOwnedDocumentPathShape` — o padrão EXATO
 *     `workers/<workerId>/(<docType>|additional)/<uuid>.<ext>` (`<docType>`
 *     um dos 11 tipos fixos — `WorkerDocuments.ts:1-12` — ou `additional`;
 *     `<ext>` uma de `pdf`/`jpg`/`png`, as únicas que
 *     `GCSStorageService.signUpload` de fato grava — `GCSStorageService.ts:78-81`).
 *     É o que `assertDocumentPathBelongsToWorker` exige ALÉM de bater com o
 *     registro — a checagem mais forte, reservada para o guard de VIEW
 *     (`getViewSignedUrl`), onde nenhum teste legítimo depende de caminho
 *     fora do padrão de upload.
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

// Os 11 tipos fixos de documento — mesma lista já duplicada em
// `WorkerDocuments.ts:1-12`, `GCSStorageService.ts:5-16`,
// `WorkerDocumentsMeController.ts` e `AdminWorkerDocumentsController.ts`
// (convenção existente no código; mantida aqui pelo mesmo padrão em vez de
// forçar um refactor de dedup fora do escopo deste hotfix).
const DOCUMENT_TYPE_SEGMENTS = [
  'resume_cv',
  'identity_document',
  'identity_document_back',
  'criminal_record',
  'professional_registration',
  'liability_insurance',
  'monotributo_certificate',
  'at_certificate',
  'apto_psicofisico',
  'analitico_universitario',
  'carta_recomendacion',
  'additional',
];

// Extensões que `GCSStorageService.signUpload` de fato gera hoje
// (GCSStorageService.ts:78-81: extMap 'application/pdf'→'pdf',
// 'image/jpeg'→'jpg', 'image/png'→'png'; qualquer outro content-type cai no
// default 'pdf'). Nenhum upload emitido pelo servidor grava outra extensão.
const ACCEPTED_EXTENSIONS = ['pdf', 'jpg', 'png'];

const UUID_SEGMENT_SOURCE =
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

/**
 * Regex exata do caminho de um documento do PRÓPRIO `workerId`:
 * `workers/<workerId>/(<docType>|additional)/<uuid>.<pdf|jpg|png>`.
 */
export function buildOwnedDocumentPathPattern(workerId: string): RegExp {
  const typeAlternation = DOCUMENT_TYPE_SEGMENTS.join('|');
  const extAlternation = ACCEPTED_EXTENSIONS.join('|');
  return new RegExp(
    `^workers/${escapeForRegex(workerId)}/(?:${typeAlternation})/${UUID_SEGMENT_SOURCE}\\.(?:${extAlternation})$`,
    'i',
  );
}

/**
 * true quando o caminho normalizado começa por `workers/<workerId>/` — a
 * checagem de PREFIXO usada pelos 3 endpoints de SAVE e pelo
 * `GCSStorageService` (2ª camada de view/delete). Não confere tipo de
 * documento nem extensão nem forma de uuid — só que o caminho está dentro
 * do namespace do PRÓPRIO worker.
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
 * O caminho normalizado tem a FORMA EXATA de um documento do PRÓPRIO
 * `workerId` (prefixo + tipo válido + uuid + extensão aceita). Não confere
 * se o objeto existe nem se está gravado no registro — é a checagem mais
 * forte, usada só por `assertDocumentPathBelongsToWorker` (guard de VIEW).
 */
export function matchesOwnedDocumentPathShape(
  rawPath: unknown,
  bucketName: string,
  workerId: string,
): boolean {
  const normalized = resolveDocumentRelativePath(rawPath, bucketName);
  if (!normalized) return false;
  return buildOwnedDocumentPathPattern(workerId).test(normalized);
}

/**
 * true só quando o caminho pedido (a) tem a FORMA EXATA de um documento do
 * PRÓPRIO `workerId` — `matchesOwnedDocumentPathShape` — E (b) bate com um
 * dos caminhos de fato GRAVADOS no registro do worker (`ownedPaths`).
 */
export function assertDocumentPathBelongsToWorker(
  rawPath: unknown,
  bucketName: string,
  workerId: string,
  ownedPaths: Array<string | null | undefined>,
): boolean {
  const normalized = resolveDocumentRelativePath(rawPath, bucketName);
  if (!normalized) return false;
  if (!buildOwnedDocumentPathPattern(workerId).test(normalized)) return false;

  return ownedPaths.some((stored) => {
    if (!stored) return false;
    const storedNormalized = resolveDocumentRelativePath(stored, bucketName);
    return storedNormalized !== null && storedNormalized === normalized;
  });
}
