import { PatientChatIdsRepository, type ChatIdConflict } from '../infrastructure/PatientChatIdsRepository';
import { PatientChatRolesRepository } from '../infrastructure/PatientChatRolesRepository';
import type { PatientChatIdMap, PatientChatIdWriteMap } from '../domain/PatientChatId';
import { isExclusiveChatRole, toRoleCatalog } from '../domain/PatientChatRole';

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
 * O body trouxe papel que não existe no catálogo, ou que está desativado.
 *
 * Erro separado do 400 genérico de schema porque a causa é outra: o formato
 * está certo, o vocabulário é que não confere — e quem opera precisa saber que
 * o caminho é a tela de administração de papéis, não corrigir o texto.
 */
export class UnknownChatRoleError extends Error {
  constructor(public readonly roles: string[]) {
    super(`Unknown or inactive chat role(s): ${roles.join(', ')}`);
    this.name = 'UnknownChatRoleError';
  }
}

/**
 * PatientChatIdsService — grava os grupos de WhatsApp do paciente, por papel.
 *
 * Os papéis válidos e a exclusividade de cada um vêm do CATÁLOGO
 * (`patient_chat_roles`, migration 262), não de código. Ver
 * `domain/PatientChatRole.isExclusiveChatRole` — o ponto único da decisão.
 *
 * A trava de unicidade tem duas metades, e as duas são necessárias:
 *
 *   - NO BANCO: índice único parcial `idx_patient_chat_ids_exclusive_chat`
 *     (`WHERE is_exclusive`) — o mesmo grupo não entra duas vezes entre os
 *     papéis exclusivos, de nenhum paciente. É a metade dura: nem um script nem
 *     um psql à mão furam.
 *   - AQUI: a mesma regra, antes de bater na constraint, para devolver 409 com
 *     a LISTA DE CONFLITOS em vez de um erro de banco opaco — e para cobrir o
 *     caso misto (papel compartilhável tentando tomar um grupo que já é de um
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
  private readonly rolesRepo: PatientChatRolesRepository;

  constructor(repo?: PatientChatIdsRepository, rolesRepo?: PatientChatRolesRepository) {
    this.repo = repo ?? new PatientChatIdsRepository();
    this.rolesRepo = rolesRepo ?? new PatientChatRolesRepository();
  }

  async update(patientId: string, changes: PatientChatIdWriteMap): Promise<PatientChatIdMap> {
    const patient = await this.repo.findById(patientId);
    if (!patient) throw new PatientChatIdsNotFoundError(patientId);

    // Uma leitura só do catálogo, usada tanto para validar quanto para gravar:
    // ler duas vezes abriria uma janela em que a validação e a escrita
    // enxergariam políticas diferentes.
    const catalog = toRoleCatalog(await this.rolesRepo.listActive());

    const unknown = Object.keys(changes).filter(role => !catalog.has(role));
    if (unknown.length > 0) throw new UnknownChatRoleError(unknown);

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
            // um grupo compartilhável (o do plano de saúde, que nasce assim
            // porque são 27 pagadores para 236 pacientes) ainda assim não pode
            // ser a família de alguém.
            (taken.exclusive || isExclusiveChatRole(catalog, role)),
        ),
      );
      if (conflicts.length > 0) throw new ChatIdAlreadyLinkedError(conflicts);
    }

    return this.repo.applyChatIds(patientId, changes, catalog);
  }
}
