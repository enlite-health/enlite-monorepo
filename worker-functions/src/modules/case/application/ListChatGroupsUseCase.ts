import { PeriskopeChatReadService } from '@modules/notification';
import { PatientChatIdsRepository } from '../infrastructure/PatientChatIdsRepository';
import { normalizeForMatch } from './rankChatCandidates';

/** Quantos grupos devolver por página. */
export const DEFAULT_GROUP_PAGE_SIZE = 50;
export const MAX_GROUP_PAGE_SIZE = 200;

/** Um grupo da org, com o que a tela precisa para a pessoa decidir. */
export interface ChatGroupListItem {
  chatId: string;
  chatName: string | null;
  memberCount: number | null;
  /** De qual número conectado o grupo veio. Responde "por que não vejo o meu?". */
  orgPhone: string | null;
  /**
   * Quantos PACIENTES já usam este grupo, em qualquer papel.
   *
   * ⚠️ Não é aviso, é informação — e o que ela significa depende do papel. Num
   * papel COMPARTILHADO (o grupo de gestión por pagador), 40 é o esperado. Num
   * EXCLUSIVO, qualquer número maior que zero significa que gravar dará 409.
   * Quem sabe o papel é a tela; aqui só se devolve o número.
   */
  linkedPatientCount: number;
}

export interface ListChatGroupsInput {
  /** Filtro por NOME do grupo, sem acento e sem caixa. Vazio = todos. */
  search?: string;
  limit?: number;
  offset?: number;
}

export type ListChatGroupsOutput =
  | {
      ok: true;
      groups: ChatGroupListItem[];
      /** Total DEPOIS do filtro de busca — é o que a paginação da tela usa. */
      total: number;
      limit: number;
      offset: number;
      hasMore: boolean;
      /** A varredura do Periskope parou no limite: a lista está incompleta. */
      listTruncated: boolean;
    }
  | { ok: false; reason: 'periskope_unavailable' };

/**
 * ListChatGroupsUseCase — TODOS os grupos da org, com busca por nome.
 *
 * POR QUE EXISTE, e por que não é o mesmo que `chat-candidates`. Aquele ranqueia
 * por semelhança com o NOME DO PACIENTE e descarta quem pontua zero — o que é
 * certo para os grupos nomeados pelo paciente ("Flia. Pérez"), e **estruturalmente
 * inútil** para os que não são. O grupo de gestión chama-se
 * `Gestión: EnLite <> DAS`: semelhança zero com qualquer paciente, logo ele
 * NUNCA aparecia como candidato. Sem esta lista, o papel compartilhado é
 * invinculável na prática, por mais que o resto exista.
 *
 * Ranquear por paciente serve a "qual destes é o grupo DELE?".
 * Esta lista serve a "qual é o grupo da OBRA SOCIAL dele?" — pergunta diferente,
 * ferramenta diferente.
 *
 * SÓ LEITURA: `GET /chats` no Periskope e um `SELECT` no nosso banco. Nada aqui
 * escreve, nem no Periskope nem em `patient_chat_ids`.
 *
 * Nunca loga nome de grupo — nome de grupo carrega nome de paciente (PII,
 * Ley 25.326). Só contagens.
 */
export class ListChatGroupsUseCase {
  constructor(
    private readonly periskope: PeriskopeChatReadService = new PeriskopeChatReadService(),
    private readonly repo: PatientChatIdsRepository = new PatientChatIdsRepository(),
  ) {}

  async execute(input: ListChatGroupsInput = {}): Promise<ListChatGroupsOutput> {
    const listed = await this.periskope.listGroupChats();
    if (listed === null) return { ok: false, reason: 'periskope_unavailable' };

    const limit = clamp(input.limit ?? DEFAULT_GROUP_PAGE_SIZE, 1, MAX_GROUP_PAGE_SIZE);
    const offset = Math.max(0, input.offset ?? 0);

    // Busca por NOME, normalizada dos dois lados: quem digita "gestion" tem de
    // achar "Gestión", e quem digita "DAS" tem de achar em qualquer caixa.
    const term = normalizeForMatch(input.search ?? '');
    const filtered = term
      ? listed.groups.filter(g => normalizeForMatch(g.chatName ?? '').includes(term))
      : listed.groups;

    // Ordem estável e previsível: por nome. Sem isto, a página 2 pode repetir
    // ou pular grupos quando o Periskope devolver a lista em outra ordem.
    const ordered = [...filtered].sort((a, b) =>
      (a.chatName ?? a.chatId).localeCompare(b.chatName ?? b.chatId),
    );

    const page = ordered.slice(offset, offset + limit);

    // A contagem de uso é buscada SÓ para a página — perguntar pelos 775 a cada
    // tecla digitada seria varrer a tabela inteira para mostrar 50 linhas.
    const usage = await this.repo.countPatientsByChatIds(page.map(g => g.chatId));

    return {
      ok: true,
      groups: page.map(g => ({
        chatId: g.chatId,
        chatName: g.chatName,
        memberCount: g.memberCount,
        orgPhone: g.orgPhone,
        linkedPatientCount: usage[g.chatId] ?? 0,
      })),
      total: ordered.length,
      limit,
      offset,
      hasMore: offset + page.length < ordered.length,
      listTruncated: listed.truncated,
    };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
