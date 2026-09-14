/**
 * Guard against issuing a signed READ url for an arbitrary file path.
 *
 * `getViewSignedUrl` on both the worker self-service and the admin routes
 * takes a `filePath` straight from the request body and, before this guard
 * existed, signed it unconditionally — so any authenticated caller could
 * read ANY worker's document (or, for the admin route, any path at all,
 * including one that never belonged to `:id`) just by naming its path.
 *
 * `resolveDocumentRelativePath` normalizes a client-supplied path/URL to the
 * relative GCS object path, rejecting anything that isn't a plain relative
 * path inside THIS bucket (path traversal, absolute filesystem path, or an
 * absolute URL to a different host/bucket). `assertDocumentPathBelongsToWorker`
 * then requires that normalized path to exactly match one of the worker's
 * OWN stored document paths — never trusting the path's shape alone.
 */

const ABSOLUTE_URL_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

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

  if (
    path.length === 0 ||
    path.startsWith('/') ||
    path.startsWith('\\') ||
    path.includes('..') ||
    path.includes('\\') ||
    path.includes('//')
  ) {
    return null;
  }

  return path;
}

export function assertDocumentPathBelongsToWorker(
  rawPath: unknown,
  bucketName: string,
  ownedPaths: Array<string | null | undefined>,
): boolean {
  const normalized = resolveDocumentRelativePath(rawPath, bucketName);
  if (!normalized) return false;

  return ownedPaths.some((stored) => {
    if (!stored) return false;
    const storedNormalized = resolveDocumentRelativePath(stored, bucketName);
    return storedNormalized !== null && storedNormalized === normalized;
  });
}
