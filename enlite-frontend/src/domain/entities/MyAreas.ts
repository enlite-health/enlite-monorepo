/**
 * Áreas da pessoa logada — contrato de `GET /v1/me/areas` (design §3, DF-5).
 * `entryRoute = null`: a área existe mas ainda não tem tela, então não é navegável.
 */
export interface AreaEntry {
  area: string;
  role: string;
  entryRoute: string | null;
}

export interface MyAreasResponse {
  areas: AreaEntry[];
  /** O servidor regravou o claim `areas`/`pid`: a web renova o ID token antes de navegar. */
  tokenRefreshRequired: boolean;
}
