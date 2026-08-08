import {
  PatientChatIdsRepository,
  type ChatMapFilter,
  type PatientChatMapRow,
} from '../infrastructure/PatientChatIdsRepository';

/** Página default. Cobre a base inteira hoje (357 pacientes) numa rodada. */
export const DEFAULT_CHAT_MAP_LIMIT = 500;
/** Teto duro por página. */
export const MAX_CHAT_MAP_LIMIT = 1000;

export interface GetPatientChatMapInput {
  /** Recorte. Default 'linked' (o mapa pronto para cruzar). */
  filter?: ChatMapFilter;
  /** Direção REVERSA: dado um chat_id do Periskope, de quem ele é e em que papel. */
  chatId?: string;
  limit?: number;
  offset?: number;
}

export interface GetPatientChatMapResult {
  patients: PatientChatMapRow[];
  /** Total que casa com o recorte, ignorando a paginação. */
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

/**
 * GetPatientChatMapUseCase — a ponte de três pontas, em massa:
 * Postgres (`patientId`) ↔ ClickUp (`clickupTaskId`) ↔ Periskope (chat IDs).
 *
 * ⚠️ MUDANÇA DE CONTRATO na migration 261: cada linha traz `chatIds` (mapa
 * papel → chat_id, papéis em MAIÚSCULO) no lugar dos antigos `familyChatId` /
 * `providersChatId`, e `matchedRole` passa a ser 'FAMILY'/'PROVIDERS'/... em vez
 * de 'family'/'providers'. Diferente do detalhe do paciente, aqui NÃO há alias
 * legado: este payload é lido por agente (capability MCP `patient.chat.map`), e
 * duas grafias do mesmo fato num payload de LLM é convite a erro. O corte é
 * seguro porque a base está zerada — nenhum consumidor tem dado real ainda.
 *
 * Existe porque a auditoria de informes (Candela) processa a BASE INTEIRA de uma
 * vez, não um paciente por vez, e consome principalmente a direção reversa: ela
 * parte das conversas do Periskope e precisa saber de qual paciente cada chat é.
 *
 * ⚠️ PII-SAFE POR CONSTRUÇÃO: o payload só carrega identificadores. Nome,
 * telefone e documento não são selecionados em lugar nenhum deste caminho —
 * a auditoria conta informes, não precisa saber quem é a pessoa (Ley 25.326).
 *
 * Só leitura; nunca escreve.
 */
export class GetPatientChatMapUseCase {
  constructor(private readonly repo: PatientChatIdsRepository = new PatientChatIdsRepository()) {}

  async execute(input: GetPatientChatMapInput = {}): Promise<GetPatientChatMapResult> {
    const limit = clamp(input.limit ?? DEFAULT_CHAT_MAP_LIMIT, 1, MAX_CHAT_MAP_LIMIT);
    const offset = Math.max(0, Math.trunc(input.offset ?? 0));

    // Direção reversa: a busca é por chave única, então paginação não se aplica.
    if (input.chatId) {
      const patients = await this.repo.findByChatId(input.chatId);
      return { patients, total: patients.length, limit, offset: 0, hasMore: false };
    }

    const { rows, total } = await this.repo.findChatMap({
      filter: input.filter ?? 'linked',
      limit,
      offset,
    });

    return { patients: rows, total, limit, offset, hasMore: offset + rows.length < total };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), min), max);
}
