/**
 * Terminology — o resultado de busca no catálogo CID-11 (spec 016 F3).
 *
 * REQ-21 (`2026-08-26a#REQ-21`): só `{ uri, title }` — nunca `code`/`chapter`/`release` chegam
 * ao cliente. O servidor já aplica essa fronteira em `AdminTerminologySearchController`; este
 * tipo existe para que NENHUM componente de tela consiga sequer DECLARAR uma variável com o
 * código — a forma não permite.
 */
export interface TerminologyCandidate {
  readonly uri: string;
  readonly title: string;
}
