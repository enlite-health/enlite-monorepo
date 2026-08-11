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

/** true se o corpo HTTP 400 indica conflito de unicidade em telefone e/ou email */
function isUniqueFieldConflict(body: string): boolean {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return false;
  }
  return Array.isArray(parsed.telefono) || Array.isArray(parsed.email);
}

export interface AnaCareMirrorProviderDeps {
  /**
   * Diz se um ana_care_id já está gravado em OUTRO worker nosso. Só é chamado
   * quando um match por telefone+nome é encontrado (ver findExistingByPhoneAndName)
   * — sem isso, um `d65e1378` que casa com a nurse do `81f4add0` (provável
   * duplicata de cadastro — mesmo telefone, mesma profissão) tentaria linkar e
   * bateria numa constraint de unicidade DEPOIS de já ter mandado o PATCH pro
   * AnaCare (achado real em prod, 11/08). Se ausente (ex: testes), assume que
   * nada está reivindicado — o provider não tem acesso à tabela `workers` por
   * padrão, quem injeta é o factory de produção.
   */
  isExternalIdClaimed?: (externalId: string) => Promise<boolean>;
}

export class AnaCareMirrorProvider implements WorkerMirrorProvider {
  readonly name = 'anacare';

  private readonly client: IAnaCareApiClient;
  private readonly typeResolver: AnaCareTypeResolver;
  private readonly isExternalIdClaimed?: (externalId: string) => Promise<boolean>;

  constructor(client: IAnaCareApiClient, deps: AnaCareMirrorProviderDeps = {}) {
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
      const id = parseInt(externalId, 10);
      if (isNaN(id)) {
        throw new Error(
          `${TAG} upsert: invalid externalId (not a number): ${externalId}`,
        );
      }

      const payload = mapWorkerToAnaCarePayload(record, resolvedTypes);
      // Para PATCH, email não é enviado se já existe (evitar conflito de unicidade)
      // A API aceita PATCH com todos os campos — mantemos o payload completo.
      const updated = await this.client.updateNurse(id, payload);
      logger.info({ msg: `${TAG} updated nurse`, anaCareId: updated.id });
      return { externalId: String(updated.id) };
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
          const claimed = this.isExternalIdClaimed
            ? await this.isExternalIdClaimed(String(match.id)).catch(() => true) // incerto → conservador
            : false;

          if (claimed) {
            logger.warn({
              msg: `${TAG} match por telefone+nome encontrado, mas ana_care_id já pertence a OUTRO worker nosso — provável duplicata de cadastro, não linka (revisão manual)`,
              anaCareId: match.id,
            });
          } else {
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
    const id = parseInt(externalId, 10);
    if (isNaN(id)) {
      throw new Error(
        `${TAG} deactivate: invalid externalId (not a number): ${externalId}`,
      );
    }
    // TODO: confirmar campo/valor de desativação com AnaCare antes de usar em produção.
    // A documentação v2 não especifica endpoint de desativação — pode ser PATCH status.
    await this.client.updateNurse(id, { /* status: 'INACTIVE' */ } as Record<string, unknown>);
    logger.info({ msg: `${TAG} deactivate called (stub — confirm field with AnaCare)`, anaCareId: id });
  }
}
