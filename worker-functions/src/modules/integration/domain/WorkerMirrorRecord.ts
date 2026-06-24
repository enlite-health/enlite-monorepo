/**
 * WorkerMirrorRecord — tipo NEUTRO que descreve um worker para espelhamento externo.
 *
 * Vocabulário agnóstico de fornecedor: sem campos em espanhol, sem enums específicos
 * do AnaCare. Providers externos (AnaCare, HubSpot, etc.) recebem este tipo e mapeiam
 * para o vocabulário da sua API.
 *
 * Campos opcionais = informação pode estar ausente (PII incompleta ou não aplicável).
 * Quem usa: BackfillWorkerMirrorUseCase → WorkerMirrorProvider.upsert().
 */
export interface WorkerMirrorAddress {
  /** Rua / logradouro completo */
  line: string | null;
  city: string | null;
  state: string | null;
  neighborhood: string | null;
  postalCode: string | null;
}

export interface WorkerMirrorRecord {
  /** UUID interno do worker no banco Enlite */
  workerId: string;

  firstName: string | null;
  lastName: string | null;

  /** Canônico UPPERCASE EN: 'MALE' | 'FEMALE' | null */
  sex: 'MALE' | 'FEMALE' | null;

  /** Email único do worker — campo obrigatório na maioria dos providers */
  email: string;

  /** Telefone normalizado (E.164 sem '+' em prod, formato livre) */
  phone: string | null;

  /** Data de nascimento ISO 8601: 'YYYY-MM-DD' */
  birthDate: string | null;

  /** Número de documento (CURP, DNI, CPF, etc.) */
  documentNumber: string | null;

  /** Endereço da área de atuação (worker_service_areas) */
  address: WorkerMirrorAddress;

  /** Profissão canônica: 'AT' | 'CUIDADOR' | null */
  profession: string | null;

  /** Ocupação complementar (campo livre) */
  occupation: string | null;

  /** Tipo de vínculo empregatício (campo livre) */
  employmentType: string | null;
}
