/**
 * AnaCareMirrorProvider — implementação de WorkerMirrorProvider para AnaCare.
 *
 * Usa AnaCareClient (HTTP) + anaCareMapper (conversão de vocabulário) +
 * AnaCareTypeResolver (resolução de tipos via catálogo).
 *
 * upsert:
 *   externalId === null → POST createNurse (worker nunca sincronizado)
 *   externalId !== null → PATCH updateNurse (worker já existe no AnaCare)
 *
 *   Se o POST falhar com HTTP 400 por conflito de unicidade (telefono e/ou
 *   email já cadastrados em OUTRO registro AnaCare — comum quando o worker
 *   já existia lá antes do nosso mirror), tenta resolver por matching:
 *   procura, em toda a base AnaCare, um nurse cujo telefone normalizado E
 *   nome batam com os nossos. Só linka (PATCH no registro encontrado) se o
 *   match for único e em AMBOS os campos — telefone sozinho não é garantia
 *   suficiente (ver `.claude/docs` memória anacare-sync-falhas: email no
 *   AnaCare é gerado por eles, não é identificador confiável). Ambíguo ou
 *   sem match → propaga o erro original (mesmo comportamento de antes).
 *
 *   Achado um match, o link só acontece se o ana_care_id estiver LIVRE do nosso
 *   lado (`deps.isExternalIdClaimed`, obrigatória). Reivindicado — ou check
 *   indisponível — não escreve no AnaCare e lança AnaCareLinkBlockedError, que
 *   diz na mensagem qual dos dois casos ocorreu (a mensagem vira
 *   `workers.ana_care_sync_error`, a coluna por onde a fila é triada).
 *
 * deactivate: stub que faz PATCH com campo `status`.
 * TODO: confirmar campo e valor exato com AnaCare antes de usar em produção.
 *       Não é chamado no backfill v1.
 */

import type { WorkerMirrorProvider, WorkerMirrorUpsertResult } from '../../domain/WorkerMirrorProvider';
import type { WorkerMirrorRecord } from '../../domain/WorkerMirrorRecord';
import type { IAnaCareApiClient, AnaCareNurse, AnaCareNursePayload } from '../../domain/IAnaCareApiClient';
import { AnaCareTypeResolver } from './anaCareTypeResolver';
import { mapWorkerToAnaCarePayload } from './anaCareMapper';
import { toNationalAR } from '../../../../shared/utils/phoneNormalization';
import { AnaCareApiError } from './AnaCareClient';
import { logger } from '@shared/logging';

const TAG = '[AnaCareMirrorProvider]';

/** lowercase + trim + remove acentos + colapsa espaço, para comparação de nome tolerante */
function normalizeNameForMatch(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/** Campos de unicidade que o AnaCare recusa quando já pertencem a outro nurse. */
/**
 * `ana_care_id` → id numérico do nurse no Ana Care.
 *
 * ⚠️ 13 workers em produção carregam o id com o prefixo `A` do import antigo
 * (`A86118`, `A87583`…). `parseInt('A86118', 10)` é `NaN`, e o `NaN` vira
 * `throw` — o worker para de sincronizar PARA SEMPRE, calado do ponto de vista
 * de quem opera. O prefixo é ruído de importação, não identidade: o mesmo nurse
 * aparece como `A87583` num cadastro e `87583` no outro.
 *
 * Só dígitos são considerados. `null` quando não sobra dígito nenhum — aí é
 * externalId inválido de verdade, e quem chama continua lançando.
 */
export function toAnaCareNurseId(externalId: string): number | null {
  const digitos = externalId.replace(/\D/g, '');
  // Sem checar `NaN` depois: `parseInt` de uma string só-dígitos NÃO retorna
  // `NaN`, e o ramo morto só serviria para o arquivo marcar 100% com uma
  // condição que nenhum teste consegue exercitar.
  return digitos === '' ? null : Number.parseInt(digitos, 10);
}

const UNIQUE_FIELDS = ['telefono', 'email'] as const;
type UniqueField = (typeof UNIQUE_FIELDS)[number];

/**
 * Quais campos de unicidade o corpo do HTTP 400 acusa. Lista vazia = o 400 é
 * outra coisa (payload inválido, tipo inexistente...) e NÃO deve ser tratado
 * como conflito.
 */
function conflictingUniqueFields(body: string): UniqueField[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return [];
  }
  return UNIQUE_FIELDS.filter(f => Array.isArray(parsed[f]));
}

/** true se o corpo HTTP 400 indica conflito de unicidade em telefone e/ou email */
function isUniqueFieldConflict(body: string): boolean {
  return conflictingUniqueFields(body).length > 0;
}

export interface AnaCareMirrorProviderDeps {
  /**
   * Diz se um ana_care_id já está gravado em OUTRO worker nosso. Só é chamado
   * quando um match por telefone+nome é encontrado (ver findExistingByPhoneAndName)
   * — sem isso, um `d65e1378` que casa com a nurse do `81f4add0` (provável
   * duplicata de cadastro — mesmo telefone, mesma profissão) tentaria linkar e
   * bateria numa constraint de unicidade DEPOIS de já ter mandado o PATCH pro
   * AnaCare (achado real em prod, 11/08).
   *
   * OBRIGATÓRIA de propósito: este é um guard FAIL-CLOSED, e dependência
   * opcional com default permissivo transforma "esqueci de injetar" em
   * "silenciosamente inseguro" — sem erro de compilação, sem log, sem sintoma
   * até o dado já estar escrito no parceiro externo. Quem não tem acesso à
   * tabela `workers` (testes) passa um stub EXPLÍCITO.
   */
  isExternalIdClaimed: (externalId: string) => Promise<boolean>;
}

/** Por que o link no AnaCare foi bloqueado (chega até `workers.ana_care_sync_error`). */
export type AnaCareLinkBlockedReason = 'claimed' | 'checker_unavailable';

/**
 * Erro de BLOQUEIO do link — distinto do 400 de conflito que veio do AnaCare.
 *
 * Existe porque quem tria a fila lê `workers.ana_care_sync_error`: propagar o
 * erro original faria a coluna dizer "telefone/email duplicado no AnaCare",
 * escondendo a causa real (id já reivindicado do NOSSO lado, ou check
 * indisponível). O erro original é preservado em `cause` E embutido na
 * mensagem — a coluna guarda só `message`.
 */
export class AnaCareLinkBlockedError extends Error {
  readonly reason: AnaCareLinkBlockedReason;
  readonly anaCareId: string;

  constructor(reason: AnaCareLinkBlockedReason, anaCareId: string, cause: Error) {
    const causeMsg = cause.message;
    const detail = reason === 'claimed'
      ? `ana_care_id ${anaCareId} já pertence a OUTRO worker nosso (provável duplicata de cadastro — precisa de merge/revisão manual)`
      : `não foi possível verificar se ana_care_id ${anaCareId} já pertence a outro worker nosso (checker indisponível — NÃO é duplicata confirmada)`;
    super(`${TAG} link bloqueado: ${detail}. Conflito original do AnaCare: ${causeMsg}`, { cause });
    this.name = 'AnaCareLinkBlockedError';
    this.reason = reason;
    this.anaCareId = anaCareId;
  }
}

export class AnaCareMirrorProvider implements WorkerMirrorProvider {
  readonly name = 'anacare';

  private readonly client: IAnaCareApiClient;
  private readonly typeResolver: AnaCareTypeResolver;
  private readonly isExternalIdClaimed: (externalId: string) => Promise<boolean>;

  constructor(client: IAnaCareApiClient, deps: AnaCareMirrorProviderDeps) {
    this.client = client;
    this.typeResolver = new AnaCareTypeResolver(client);
    this.isExternalIdClaimed = deps.isExternalIdClaimed;
  }

  async upsert(
    record: WorkerMirrorRecord,
    externalId: string | null,
  ): Promise<WorkerMirrorUpsertResult> {
    // Resolve tipos via catálogo (pode retornar campos vazios se não encontrado).
    // Prefere occupation (enum canônico AT/CUIDADOR/AMBOS) sobre profession (texto
    // livre, frequentemente NULL) para maximizar o match com o catálogo AnaCare.
    const resolvedTypes = await this.typeResolver.resolve(
      record.occupation ?? record.profession,
      record.employmentType,
    );

    if (externalId !== null) {
      // PATCH — worker já existe no AnaCare
      const id = toAnaCareNurseId(externalId);
      if (id === null) {
        throw new Error(
          `${TAG} upsert: invalid externalId (no digits): ${externalId}`,
        );
      }

      const payload = mapWorkerToAnaCarePayload(record, resolvedTypes);
      // A API aceita PATCH com todos os campos — mandamos o payload completo.
      try {
        const updated = await this.client.updateNurse(id, payload);
        logger.info({ msg: `${TAG} updated nurse`, anaCareId: updated.id });
        return { externalId: String(updated.id) };
      } catch (err) {
        // CONFLITO DE UNICIDADE NO PATCH — worker JÁ LINKADO, então não há o que
        // resolver por matching: o registro certo é este. O que colide é um campo
        // (telefone e/ou email) que hoje pertence a OUTRO nurse.
        //
        // Isto passou a acontecer quando o espelho começou a mandar o telefone em
        // formato NACIONAL (#196): o valor entrou no mesmo espaço dos 692 registros
        // já nacionais do AnaCare, e a unicidade deles — que com `+549…` nunca
        // disparava — passou a disparar. Medido em produção (11/08): 9 PATCH/24h
        // falhando assim. Como o evento não tem retry, o worker parava de
        // sincronizar de vez — regressão em quem antes funcionava.
        //
        // Decisão: o campo em conflito é DESCARTADO e o resto do cadastro segue
        // sincronizando. Perder a atualização de um telefone que já está duplicado
        // lá é muito menos grave do que congelar nome, endereço e tipo do worker.
        // A duplicata do lado deles é problema de dado, e some do nosso caminho
        // quando for resolvida — sem exigir deploy nosso.
        if (!(err instanceof AnaCareApiError) || err.status !== 400) throw err;
        const conflicting = conflictingUniqueFields(err.body);
        if (conflicting.length === 0) throw err;

        // Partial<>: `email` é obrigatório em AnaCareNursePayload e pode ser um dos
        // campos removidos aqui. (O `tsc` não acusa: `delete obj[k]` com `k` de tipo
        // união não dispara TS2790 como `delete obj.email` dispararia — o tipo certo
        // é escolha nossa, não imposição do compilador.)
        const retryPayload: Partial<AnaCareNursePayload> = { ...payload };
        for (const field of conflicting) delete retryPayload[field];

        // PII-SAFETY: só NOMES de campo e ids — nunca o telefone/email em conflito.
        logger.warn({
          msg: `${TAG} PATCH com conflito de unicidade — reenviando SEM os campos em conflito`,
          workerId: record.workerId,
          anaCareId: id,
          conflictingFields: conflicting,
        });

        const updated = await this.client.updateNurse(id, retryPayload);
        logger.info({
          msg: `${TAG} updated nurse (campos em conflito preservados no AnaCare)`,
          workerId: record.workerId,
          anaCareId: updated.id,
          skippedFields: conflicting,
        });
        return { externalId: String(updated.id) };
      }
    }

    // POST — criar nova enfermera
    const payload = mapWorkerToAnaCarePayload(record, resolvedTypes);
    try {
      const created = await this.client.createNurse(payload);
      logger.info({ msg: `${TAG} created nurse`, anaCareId: created.id });
      return { externalId: String(created.id) };
    } catch (err) {
      if (err instanceof AnaCareApiError && err.status === 400 && isUniqueFieldConflict(err.body)) {
        const match = await this.findExistingByPhoneAndName(payload).catch((matchErr: unknown) => {
          logger.warn({
            msg: `${TAG} match attempt failed — falling back to original conflict error`,
            error: matchErr instanceof Error ? matchErr.message : String(matchErr),
          });
          return null;
        });
        if (match) {
          // Antes de escrever no AnaCare, confirma que esse ana_care_id está
          // LIVRE no nosso lado. Sem isso: acha o match certo, manda o PATCH
          // de verdade pro AnaCare, e só DEPOIS descobre (constraint de
          // unicidade) que outro worker nosso já é dono desse id — geralmente
          // duplicata de cadastro (mesma pessoa, dois workerId). Nesse caso
          // não é um match errado, é um conflito que precisa de revisão
          // humana (merge de conta) — não linkamos no escuro.
          const externalIdCandidate = String(match.id);
          let claimed: boolean;
          try {
            claimed = await this.isExternalIdClaimed(externalIdCandidate);
          } catch (checkErr: unknown) {
            // Fail-closed, mas com log HONESTO: aqui NÃO há duplicata provada —
            // o que houve foi o check não responder. Dizer "já pertence a outro
            // worker" mandaria o operador caçar uma duplicata inexistente.
            logger.error({
              msg: `${TAG} checker de ana_care_id INDISPONÍVEL — não linka (fail-closed). NÃO é duplicata confirmada: é a verificação que falhou`,
              anaCareId: match.id,
              error: checkErr instanceof Error ? checkErr.message : String(checkErr),
            });
            throw new AnaCareLinkBlockedError('checker_unavailable', externalIdCandidate, err);
          }

          if (claimed) {
            logger.warn({
              msg: `${TAG} match por telefone+nome encontrado, mas ana_care_id já pertence a OUTRO worker nosso — provável duplicata de cadastro, não linka (revisão manual)`,
              anaCareId: match.id,
            });
            throw new AnaCareLinkBlockedError('claimed', externalIdCandidate, err);
          }

          // Não reenviamos email: o registro encontrado tem um email PRÓPRIO
          // (gerado pelo AnaCare) que colidiu no POST — reenviar o nosso
          // causaria o mesmo 400 de novo no PATCH.
          const { email: _email, ...linkPayload } = payload;
          const updated = await this.client.updateNurse(match.id, linkPayload);
          logger.info({
            msg: `${TAG} linked existing nurse via phone+name match (conflito de unicidade resolvido)`,
            anaCareId: updated.id,
          });
          return { externalId: String(updated.id) };
        }
      }
      throw err;
    }
  }

  /**
   * Procura, em toda a base AnaCare (paginação completa), um nurse cujo
   * telefone normalizado E nome batam com o payload. Retorna null se não
   * achar exatamente 1 candidato em AMBOS os critérios — nunca linka no
   * escuro. `payload.telefono` já vem normalizado (toNationalAR) pelo mapper.
   */
  private async findExistingByPhoneAndName(
    payload: AnaCareNursePayload,
  ): Promise<AnaCareNurse | null> {
    if (!payload.telefono) return null;

    const targetName = normalizeNameForMatch(`${payload.nombre} ${payload.apellidos}`);
    const phoneMatches: AnaCareNurse[] = [];

    let page = 1;
    for (;;) {
      const res = await this.client.listNurses(page);
      for (const nurse of res.results) {
        if (toNationalAR(nurse.telefono ?? '') === payload.telefono) {
          phoneMatches.push(nurse);
        }
      }
      if (!res.next) break;
      page += 1;
    }

    if (phoneMatches.length !== 1) return null; // 0 ou ambíguo → não linka

    const [match] = phoneMatches;
    const matchName = normalizeNameForMatch(`${match.nombre} ${match.apellidos}`);
    if (matchName !== targetName) return null; // telefone bate, nome não → não confia

    return match;
  }

  /**
   * Desativa worker no AnaCare.
   *
   * TODO: confirmar com AnaCare o campo e valor corretos para desativação.
   *       O campo `status` e o valor abaixo são PLACEHOLDERS — a API AnaCare v2
   *       não documenta explicitamente o endpoint de desativação.
   *       NÃO é chamado no backfill v1.
   */
  async deactivate(externalId: string): Promise<void> {
    const id = toAnaCareNurseId(externalId);
    if (id === null) {
      throw new Error(
        `${TAG} deactivate: invalid externalId (no digits): ${externalId}`,
      );
    }
    // TODO: confirmar campo/valor de desativação com AnaCare antes de usar em produção.
    // A documentação v2 não especifica endpoint de desativação — pode ser PATCH status.
    await this.client.updateNurse(id, { /* status: 'INACTIVE' */ } as Record<string, unknown>);
    logger.info({ msg: `${TAG} deactivate called (stub — confirm field with AnaCare)`, anaCareId: id });
  }
}
