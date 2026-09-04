/**
 * toLocalUri — reescreve o HOST de uma URI canônica da OMS para o host local configurado, sem
 * tocar em mais nada do caminho. Ver __tests__/rewrite-host.test.ts para o porquê: a API do
 * CID-11 devolve `@id`/`child[]`/`parent[]` como `http://id.who.int/...` mesmo quando servida
 * pelo NOSSO container local — seguir isso ao pé da letra faz o crawler sair do perímetro e
 * tomar HTTP 401 da API real da OMS (medido na F0).
 *
 * Único lugar do ingestor que decide para onde uma requisição HTTP realmente vai.
 */
const PATH_MARKER = '/icd/release/11/';

export class InvalidCanonicalUriError extends Error {
  constructor(rejected: string) {
    super(`URI da OMS sem o marcador "${PATH_MARKER}" esperado: "${rejected}"`);
    this.name = 'InvalidCanonicalUriError';
  }
}

export function toLocalUri(canonicalUri: string, localBase: string): string {
  const uriMarkerIdx = canonicalUri.indexOf(PATH_MARKER);
  if (uriMarkerIdx === -1) throw new InvalidCanonicalUriError(canonicalUri);

  const baseMarkerIdx = localBase.indexOf(PATH_MARKER);
  if (baseMarkerIdx === -1) throw new InvalidCanonicalUriError(localBase);

  const localHost = localBase.slice(0, baseMarkerIdx);
  return localHost + canonicalUri.slice(uriMarkerIdx);
}
