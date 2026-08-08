import { PatientChatIdsRepository, type ChatIdConflict } from '../infrastructure/PatientChatIdsRepository';
import type { PatientChatIdMap, PatientChatIdWriteMap } from '../domain/PatientChatId';
import { isExclusiveChatRole } from '../domain/PatientChatRole';

/** O paciente pedido não existe (ou está soft-deleted). */
export class PatientChatIdsNotFoundError extends Error {
  constructor(patientId: string) {
    super(`Patient not found: ${patientId}`);
    this.name = 'PatientChatIdsNotFoundError';
  }
}

/** Um dos chat_ids já está preso a outro paciente, num papel exclusivo. */
export class ChatIdAlreadyLinkedError extends Error {
  constructor(public readonly conflicts: ChatIdConflict[]) {
    super(`Chat id already linked to another patient: ${conflicts.map(c => c.chatId).join(', ')}`);
    this.name = 'ChatIdAlreadyLinkedError';
  }
}

/**
 * PatientChatIdsService — grava os grupos de WhatsApp do paciente, por papel.
 *
 * A trava de unicidade tem duas metades, e as duas são necessárias:
 *
 *   - NO BANCO: índice único parcial `idx_patient_chat_ids_exclusive_chat`
 *     (`WHERE is_exclusive`) — o mesmo grupo não entra duas vezes entre os
 *     papéis exclusivos, de nenhum paciente. É a metade dura: nem um script nem
 *     um psql à mão furam.
 *   - AQUI: a mesma regra, antes de bater na constraint, para devolver 409 com
 *     a LISTA DE CONFLITOS em vez de um erro de banco opaco — e para cobrir o
 *     caso misto (papel não-exclusivo tentando tomar um grupo que já é de um
 *     papel exclusivo alheio), que o índice parcial sozinho não vê.
 *
 * Ceiling honesto (ponytail): entre a leitura e a escrita há uma janela em que
 * duas gravações simultâneas passariam pela checagem daqui. O índice do banco
 * segura o caso exclusivo×exclusivo (vira 23505 → 409 no controller); o caso
 * misto perderia a corrida. Não vale um lock de tabela — é uma tela de admin
 * operada por uma pessoa por vez, e a próxima leitura mostra o resultado.
 */
export class PatientChatIdsService {
  private readonly repo: PatientChatIdsRepository;

  constructor(repo?: PatientChatIdsRepository) {
    this.repo = repo ?? new PatientChatIdsRepository();
  }

  async update(patientId: string, changes: PatientChatIdWriteMap): Promise<PatientChatIdMap> {
    const patient = await this.repo.findById(patientId);
    if (!patient) throw new PatientChatIdsNotFoundError(patientId);

    const wanted = Object.entries(changes).filter(
      (entry): entry is [string, string] => entry[1] !== null,
    );

    if (wanted.length > 0) {
      const linked = await this.repo.findLinkedElsewhere(patientId);
      const conflicts = linked.filter(taken =>
        wanted.some(
          ([role, chatId]) =>
            chatId === taken.chatId &&
            // Basta UM dos dois lados ser exclusivo para o vínculo ser proibido:
            // um grupo compartilhável (ex.: o do plano de saúde, se o Marcel
            // disser que é um por plano) ainda assim não pode ser a família de
            // alguém. Hoje os três papéis são exclusivos, então isto vale para
            // tudo — e continua correto no dia em que um deixar de ser.
            (taken.exclusive || isExclusiveChatRole(role)),
        ),
      );
      if (conflicts.length > 0) throw new ChatIdAlreadyLinkedError(conflicts);
    }

    return this.repo.applyChatIds(patientId, changes);
  }
}
