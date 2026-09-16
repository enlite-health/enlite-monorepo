/**
 * AnaCarePatientApi — porta para a API de PACIENTE do Ana Care (spec 003).
 *
 * Decisão do Gabriel (27/08): o dado do Ana Care vem por API, não por arquivo.
 * A API ainda não existe (a v2 de agencies só tem enfermeras); esta porta é o
 * contrato que a implementação real vai cumprir. Até lá, a implementação é
 * `AnaCarePatientApiUnavailable`, que faz a rodada fechar FAILED com
 * `anacare_patient_api_unavailable` — declarado, não disfarçado.
 *
 * O formato dos campos é opaco aqui (`fields`): quem traduz para o canônico é
 * `source_field_map(ANACARE)` — tabela, não código — para que a lista de
 * campos que o Javier mandar entre sem deploy.
 */

export interface AnaCarePatientRecord {
  /** id do paciente NO Ana Care — vira patient_identity_links.external_id e patients.ana_care_id. */
  readonly externalId: string;
  /** campos crus da resposta, por nome; valor `undefined` = campo não veio. */
  readonly fields: Readonly<Record<string, unknown>>;
}

export interface AnaCarePatientPage {
  readonly records: readonly AnaCarePatientRecord[];
  /** total declarado pela API (count), null se ela não informa. */
  readonly expectedCount: number | null;
}

export interface AnaCarePatientApi {
  /** Lê a coleção inteira (paginação interna). Lança AnaCarePatientApiUnavailableError se não há API. */
  fetchAllPatients(): Promise<AnaCarePatientPage>;
}

export class AnaCarePatientApiUnavailableError extends Error {
  constructor() {
    super('anacare_patient_api_unavailable');
    this.name = 'AnaCarePatientApiUnavailableError';
  }
}

/** Implementação de espera: a API de paciente do Ana Care ainda não existe. */
export class AnaCarePatientApiUnavailable implements AnaCarePatientApi {
  async fetchAllPatients(): Promise<AnaCarePatientPage> {
    throw new AnaCarePatientApiUnavailableError();
  }
}
