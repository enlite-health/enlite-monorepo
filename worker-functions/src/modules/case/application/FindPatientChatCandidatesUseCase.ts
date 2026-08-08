import { PeriskopeChatReadService } from '@modules/notification';
import { PatientChatIdsRepository } from '../infrastructure/PatientChatIdsRepository';
import { rankChatCandidates, type ChatCandidate } from './rankChatCandidates';
import { PatientChatIdsNotFoundError } from './PatientChatIdsService';

/** Quantos candidatos devolver por padrão. */
export const DEFAULT_CANDIDATE_LIMIT = 10;

export type FindPatientChatCandidatesOutput =
  | {
      ok: true;
      candidates: ChatCandidate[];
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
 * SÓ LEITURA: nada aqui escreve no paciente nem no Periskope. Quem é família e
 * quem é prestador é escolha do humano na tela seguinte — este caso de uso
 * automatiza a BUSCA, nunca a ATRIBUIÇÃO (é o desenho aceito na call: "fica
 * humano na escolha, automático na busca").
 *
 * Nunca loga nome de paciente nem de grupo (PII, Ley 25.326).
 */
export class FindPatientChatCandidatesUseCase {
  constructor(
    private readonly repo: PatientChatIdsRepository = new PatientChatIdsRepository(),
    private readonly periskope: PeriskopeChatReadService = new PeriskopeChatReadService(),
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

    return {
      ok: true,
      candidates: rankChatCandidates({ patientName, groups, linkedElsewhere, limit }),
      totalGroups: groups.length,
      groupListTruncated: truncated,
    };
  }
}
