import { PeriskopeChatReadService } from '@modules/notification';
import { PatientChatIdsRepository } from '../infrastructure/PatientChatIdsRepository';
import { PatientChatRolesRepository } from '../infrastructure/PatientChatRolesRepository';
import {
  rankChatCandidates,
  orderCandidatesForRole,
  type ChatCandidate,
} from './rankChatCandidates';
import { PatientChatIdsNotFoundError } from './PatientChatIdsService';

/** Quantos candidatos devolver por padrão. */
export const DEFAULT_CANDIDATE_LIMIT = 10;

export type FindPatientChatCandidatesOutput =
  | {
      ok: true;
      candidates: ChatCandidate[];
      /**
       * Papel -> os MESMOS `chatId`s de `candidates`, na ordem daquele papel.
       *
       * Só a ORDEM muda entre um papel e outro; nenhum candidato entra ou sai —
       * por isso vai como lista de ids e não como lista de objetos repetida N
       * vezes. A tela usa isto para o seletor de "família" abrir no grupo da
       * família e o de "prestadores" no dos prestadores, em vez de os dois
       * abrirem no mesmo primeiro colocado (o empate que o desempate resolve).
       */
      candidatesByRole: Record<string, string[]>;
      totalGroups: number;
      /**
       * `true` = a lista de grupos do Periskope veio INCOMPLETA. Sobe até a tela
       * de propósito: sem isso, o operador lê "nenhum candidato" quando a
       * verdade é "a lista foi cortada antes de chegar no grupo dele".
       */
      groupListTruncated: boolean;
    }
  /** Não deu para consultar o Periskope (sem credencial, rede, HTTP). */
  | { ok: false; reason: 'periskope_unavailable' }
  /** O paciente não tem nome no cadastro — não há por onde ranquear. */
  | { ok: false; reason: 'patient_has_no_name' };

/**
 * FindPatientChatCandidatesUseCase — dado um paciente, devolve os grupos do
 * Periskope mais parecidos com o nome dele, já marcando quais já estão presos a
 * outro paciente.
 *
 * SÓ LEITURA: nada aqui escreve no paciente nem no Periskope. Qual grupo é da
 * família, dos prestadores ou do plano de saúde é escolha do humano na tela
 * seguinte — este caso de uso automatiza a BUSCA, nunca a ATRIBUIÇÃO (é o
 * desenho aceito na call: "fica humano na escolha, automático na busca").
 *
 * Nunca loga nome de paciente nem de grupo (PII, Ley 25.326).
 */
export class FindPatientChatCandidatesUseCase {
  constructor(
    private readonly repo: PatientChatIdsRepository = new PatientChatIdsRepository(),
    private readonly periskope: PeriskopeChatReadService = new PeriskopeChatReadService(),
    private readonly rolesRepo: PatientChatRolesRepository = new PatientChatRolesRepository(),
  ) {}

  async execute(
    patientId: string,
    limit: number = DEFAULT_CANDIDATE_LIMIT,
  ): Promise<FindPatientChatCandidatesOutput> {
    const patient = await this.repo.findById(patientId);
    if (!patient) throw new PatientChatIdsNotFoundError(patientId);

    const patientName = [patient.firstName, patient.lastName].filter(Boolean).join(' ').trim();
    if (!patientName) return { ok: false, reason: 'patient_has_no_name' };

    const listed = await this.periskope.listGroupChats();
    if (listed === null) return { ok: false, reason: 'periskope_unavailable' };
    const { groups, truncated } = listed;

    const linkedElsewhere = new Set(
      (await this.repo.findLinkedElsewhere(patientId)).map(c => c.chatId),
    );

    const candidates = rankChatCandidates({ patientName, groups, linkedElsewhere, limit });

    // O catálogo entra SÓ para desempatar a ordem por papel. Se a leitura
    // falhasse, o certo seria devolver a lista sem `candidatesByRole` — mas ela
    // não pode falhar sem o resto já ter falhado (é o mesmo pool que leu o
    // paciente), então não há caminho de degradação a inventar aqui.
    const roles = await this.rolesRepo.listActive();

    return {
      ok: true,
      candidates,
      candidatesByRole: Object.fromEntries(
        roles.map(role => [
          role.code,
          orderCandidatesForRole(candidates, role, roles).map(c => c.chatId),
        ]),
      ),
      totalGroups: groups.length,
      groupListTruncated: truncated,
    };
  }
}
