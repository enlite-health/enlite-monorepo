/**
 * AiPromptRepository — acesso a `ai_prompts` (migration 485, spec 029 T007).
 *
 * Mesmo padrão dos vizinhos de `integration/infrastructure` (`PatientReadRepository`,
 * `AxonicoLancamentoRepository`): `pg` puro, sem ORM, getter lazy memoizado para o Pool
 * (`DatabaseConnection.getInstance().getPool()`), sem receber Pool no construtor.
 *
 * `updateBody` aceita `client?: PoolClient` opcional (mesmo desenho de
 * `PatientDeviceTypeRepository.purgeForPatient`) para participar da MESMA transação do caso de
 * uso que grava a trilha de auditoria (T010, `UpdateAiPromptUseCase`) — `data-model.md` §"Regras
 * de escrita" exige que escrita de conteúdo e evento de auditoria sejam atômicos.
 *
 * Lock otimista: o UPDATE exige a `version` que o cliente leu (`WHERE slug = $x AND version =
 * $y`). `rowCount === 0` é ambíguo por si só — slug pode não existir, ou a versão pode ter
 * divergido — e por isso é resolvido com uma segunda consulta, nunca presumido. Mesmo padrão de
 * `TemplateDraftsController.update` (molde citado por `data-model.md`: migration 298).
 */
import type { Pool, PoolClient } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import type { AiPromptSlug } from '../domain/AiPromptSlug';

export interface AiPrompt {
  slug: AiPromptSlug;
  body: string;
  version: number;
  isActive: boolean;
  createdBy: string | null;
  updatedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export type UpdateAiPromptOutcome =
  | { outcome: 'updated'; prompt: AiPrompt }
  | { outcome: 'not_found' }
  | { outcome: 'conflict'; currentVersion: number; updatedBy: string | null };

interface AiPromptRow {
  slug: AiPromptSlug;
  body: string;
  version: number;
  is_active: boolean;
  created_by: string | null;
  updated_by: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

const toIso = (v: string | Date): string => (v instanceof Date ? v.toISOString() : v);

function toEntity(row: AiPromptRow): AiPrompt {
  return {
    slug: row.slug,
    body: row.body,
    version: row.version,
    isActive: row.is_active,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

const SELECT_COLUMNS = 'slug, body, version, is_active, created_by, updated_by, created_at, updated_at';

export class AiPromptRepository {
  private poolMemo?: Pool;

  private get pool(): Pool {
    this.poolMemo ??= DatabaseConnection.getInstance().getPool();
    return this.poolMemo;
  }

  /**
   * Leitura de ADMINISTRAÇÃO: devolve a linha mesmo desativada (`is_active = false`).
   * É o que a tela de edição precisa — um prompt desligado tem de continuar visível e
   * editável, senão não haveria como religá-lo.
   *
   * ⚠️ Quem vai MANDAR o conteúdo ao modelo deve usar `findActiveBySlug`, não este.
   */
  async findBySlug(slug: AiPromptSlug): Promise<AiPrompt | null> {
    const res = await this.pool.query<AiPromptRow>(
      `SELECT ${SELECT_COLUMNS} FROM ai_prompts WHERE slug = $1`,
      [slug],
    );
    return res.rows[0] ? toEntity(res.rows[0]) : null;
  }

  /**
   * Leitura de SERVIÇO: devolve `null` quando a linha não existe **ou** está desativada.
   * É o que dá efeito real à coluna `is_active` — sem isto, desmarcar um prompt não o
   * desliga, e o texto continua indo ao modelo em silêncio.
   *
   * Mesma convenção do irmão `MessageTemplateRepository.findBySlug`.
   */
  async findActiveBySlug(slug: AiPromptSlug): Promise<AiPrompt | null> {
    const res = await this.pool.query<AiPromptRow>(
      `SELECT ${SELECT_COLUMNS} FROM ai_prompts WHERE slug = $1 AND is_active = true`,
      [slug],
    );
    return res.rows[0] ? toEntity(res.rows[0]) : null;
  }

  /** Os três prompts do catálogo fechado (`AI_PROMPT_SLUGS`), ordenados por slug — determinístico. */
  async listAll(): Promise<AiPrompt[]> {
    const res = await this.pool.query<AiPromptRow>(
      `SELECT ${SELECT_COLUMNS} FROM ai_prompts ORDER BY slug`,
    );
    return res.rows.map(toEntity);
  }

  /**
   * Grava conteúdo novo, exigindo `expectedVersion` (regra 1 de "Regras de escrita",
   * `data-model.md`). Divergência devolve `{outcome:'conflict'}` com a versão atual e quem
   * gravou por último — **não grava**. Slug sem linha devolve `{outcome:'not_found'}`.
   *
   * NÃO escreve na trilha de auditoria — isso é do caso de uso (T010), que chama este método e
   * `AiPromptAuditRepository.logEvent` na MESMA transação (passando `client`).
   */
  async updateBody(
    slug: AiPromptSlug,
    body: string,
    expectedVersion: number,
    actor: string,
    client?: PoolClient,
  ): Promise<UpdateAiPromptOutcome> {
    const exec = client ?? this.pool;

    const res = await exec.query<AiPromptRow>(
      `UPDATE ai_prompts
          SET body = $1, version = version + 1, updated_by = $2, updated_at = now()
        WHERE slug = $3 AND version = $4
        RETURNING ${SELECT_COLUMNS}`,
      [body, actor, slug, expectedVersion],
    );

    if ((res.rowCount ?? 0) > 0) {
      return { outcome: 'updated', prompt: toEntity(res.rows[0]) };
    }

    // rowCount 0 é ambíguo: slug inexistente OU versão divergente. Resolvido com uma segunda
    // pergunta, nunca presumido (mesmo raciocínio de `TemplateDraftsController.update`).
    const atual = await exec.query<{ version: number; updated_by: string | null }>(
      'SELECT version, updated_by FROM ai_prompts WHERE slug = $1',
      [slug],
    );
    if ((atual.rowCount ?? 0) === 0) {
      return { outcome: 'not_found' };
    }
    return {
      outcome: 'conflict',
      currentVersion: atual.rows[0].version,
      updatedBy: atual.rows[0].updated_by,
    };
  }
}
