import { Request, Response } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { reportError } from '@shared/logging';
import {
  CATEGORIAS,
  IDIOMAS,
  Idioma,
  slugComPrefixo,
  validarRascunho,
} from '../../../notification/domain/templateDraftRules';

/**
 * TemplateDraftsController — escrever e salvar a mensagem (spec 010, F2 passos 2.1 e 2.2).
 *
 *   GET    /api/admin/template-drafts       (staff) — os rascunhos
 *   POST   /api/admin/template-drafts       (admin) — cria
 *   PUT    /api/admin/template-drafts/:id   (admin) — edita, com trava otimista
 *   DELETE /api/admin/template-drafts/:id   (admin) — arquiva (não apaga)
 *
 * 🔒 O QUE ESTE CONTROLLER NÃO FAZ, E POR QUÊ:
 *
 * Nada aqui fala com a Twilio nem com a Meta. Salvar é ato INTERNO — grava na
 * nossa tabela e para. Criar o Content na Twilio (2.3) e submeter à Meta (2.4)
 * são atos para fora do perímetro e dependem de parecer do `lex`, que ainda não
 * foi emitido. Por isso não existe rota de submissão, e não é esquecimento: uma
 * rota de submissão aqui furaria uma regra dura do projeto.
 *
 * A tela precisa dizer isso ao usuário com todas as letras — "salvo, ainda não
 * enviado para autorização" —, porque a diferença entre guardado e submetido é
 * exatamente o que a pessoa não consegue ver sozinha.
 *
 * ⚠️ NÃO é o `MessagingController.createTemplate` (`POST /api/admin/messaging/
 * templates`), que existe em produção e grava direto em `message_templates` sem
 * `content_sid` — produzindo template que nunca envia e que a própria listagem
 * esconde. Este controller escreve em tabela separada justamente para não
 * repetir aquilo: rascunho é rascunho até alguém decidir promovê-lo.
 *
 * Escrita exige `requireAdmin`, seguindo o precedente das mensagens por etapa
 * (parecer `lex` de 29/08, condição C7 — quem configura ≠ quem dispara).
 */

const BASE = {
  name: z.string().trim().min(1).max(200),
  body: z.string().min(1).max(4000), // o teto DURO é 1024; aqui é só para não aceitar um romance no payload — a régua de verdade é validarRascunho
  category: z.enum(CATEGORIAS),
  language: z.enum(IDIOMAS),
  slug: z.string().trim().min(1).max(120),
};

const CriarSchema = z.object(BASE);
const EditarSchema = z.object({ ...BASE, version: z.number().int().positive() });

interface DraftRow {
  id: string;
  slug: string;
  name: string;
  body: string;
  category: string;
  language: string;
  version: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

const CAMPOS = `id, slug, name, body, category, language, version,
                created_by, updated_by, created_at, updated_at`;

function paraApi(r: DraftRow): Record<string, unknown> {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    body: r.body,
    category: r.category,
    language: r.language,
    version: r.version,
    createdBy: r.created_by,
    updatedBy: r.updated_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    // Não é enfeite: a tela precisa poder dizer "guardado, NÃO submetido" sem
    // inferir de ausência. Enquanto a F2 2.3/2.4 não existir, é sempre 'draft'.
    status: 'draft',
  };
}

function actorDe(req: Request): string | null {
  return ((req as unknown as { user?: { uid?: string } }).user)?.uid ?? null;
}

export class TemplateDraftsController {
  private db: Pool;

  constructor(db?: Pool) {
    this.db = db ?? DatabaseConnection.getInstance().getPool();
  }

  async list(_req: Request, res: Response): Promise<void> {
    try {
      const r = await this.db.query<DraftRow>(
        `SELECT ${CAMPOS} FROM message_template_drafts
          WHERE archived_at IS NULL
          ORDER BY updated_at DESC`,
      );
      res.status(200).json({ success: true, data: { drafts: r.rows.map(paraApi) } });
    } catch (error: unknown) {
      const e = error instanceof Error ? error : new Error(String(error));
      reportError(e, { source: 'TemplateDraftsController:list' });
      res.status(500).json({ success: false, error: 'Failed to list template drafts' });
    }
  }

  async create(req: Request, res: Response): Promise<void> {
    const parsed = CriarSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Invalid body', details: parsed.error.flatten() });
      return;
    }

    const slug = slugComPrefixo(parsed.data.slug, parsed.data.language as Idioma);
    const entrada = { ...parsed.data, slug };

    const problemas = validarRascunho(entrada);
    if (problemas.length > 0) {
      res.status(422).json({ success: false, error: 'Draft rejected by platform rules', problemas });
      return;
    }

    try {
      // Colisão com template VIVO é checada aqui e não por FK: a mensagem "já
      // existe uma mensagem com esse nome" é melhor do que um 23505 opaco, e a
      // pessoa precisa saber QUAL das duas coisas colidiu.
      const vivo = await this.db.query(
        `SELECT 1 FROM message_templates WHERE slug = $1 LIMIT 1`, [slug],
      );
      if ((vivo.rowCount ?? 0) > 0) {
        res.status(409).json({ success: false, error: 'slug_em_uso_por_template_vivo', slug });
        return;
      }

      const actor = actorDe(req);
      const r = await this.db.query<DraftRow>(
        `INSERT INTO message_template_drafts (slug, name, body, category, language, created_by, updated_by)
              VALUES ($1, $2, $3, $4, $5, $6, $6)
           RETURNING ${CAMPOS}`,
        [slug, entrada.name, entrada.body, entrada.category, entrada.language, actor],
      );
      res.status(201).json({ success: true, data: { draft: paraApi(r.rows[0]) } });
    } catch (error: unknown) {
      const e = error instanceof Error ? error : new Error(String(error));
      // 23505 = unique_violation: outro rascunho vivo já usa o slug.
      if ((error as { code?: string })?.code === '23505') {
        res.status(409).json({ success: false, error: 'slug_em_uso_por_rascunho', slug });
        return;
      }
      reportError(e, { source: 'TemplateDraftsController:create' });
      res.status(500).json({ success: false, error: 'Failed to create template draft' });
    }
  }

  async update(req: Request, res: Response): Promise<void> {
    const id = req.params.id;
    const parsed = EditarSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ success: false, error: 'Invalid body', details: parsed.error.flatten() });
      return;
    }

    const slug = slugComPrefixo(parsed.data.slug, parsed.data.language as Idioma);
    const { version, ...resto } = parsed.data;
    const entrada = { ...resto, slug };

    const problemas = validarRascunho(entrada);
    if (problemas.length > 0) {
      res.status(422).json({ success: false, error: 'Draft rejected by platform rules', problemas });
      return;
    }

    try {
      const actor = actorDe(req);
      const r = await this.db.query<DraftRow>(
        `UPDATE message_template_drafts
            SET slug = $1, name = $2, body = $3, category = $4, language = $5,
                updated_by = $6, updated_at = now(), version = version + 1
          WHERE id = $7 AND version = $8 AND archived_at IS NULL
      RETURNING ${CAMPOS}`,
        [slug, entrada.name, entrada.body, entrada.category, entrada.language, actor, id, version],
      );

      // rowCount 0 é ambíguo por si só, e tratá-lo como sucesso é o defeito que
      // o `FunnelStageMessagesController.update` tem hoje (200 sem gravar). Aqui
      // a ambiguidade é RESOLVIDA com uma segunda pergunta, não presumida.
      if ((r.rowCount ?? 0) === 0) {
        const existe = await this.db.query<{ version: number }>(
          `SELECT version FROM message_template_drafts WHERE id = $1 AND archived_at IS NULL`, [id],
        );
        if ((existe.rowCount ?? 0) === 0) {
          res.status(404).json({ success: false, error: 'draft_nao_encontrado' });
          return;
        }
        res.status(409).json({
          success: false,
          error: 'versao_desatualizada',
          versaoAtual: existe.rows[0].version,
        });
        return;
      }

      res.status(200).json({ success: true, data: { draft: paraApi(r.rows[0]) } });
    } catch (error: unknown) {
      const e = error instanceof Error ? error : new Error(String(error));
      if ((error as { code?: string })?.code === '23505') {
        res.status(409).json({ success: false, error: 'slug_em_uso_por_rascunho', slug });
        return;
      }
      reportError(e, { source: 'TemplateDraftsController:update' });
      res.status(500).json({ success: false, error: 'Failed to update template draft' });
    }
  }

  async archive(req: Request, res: Response): Promise<void> {
    try {
      const r = await this.db.query(
        `UPDATE message_template_drafts
            SET archived_at = now(), updated_by = $2, updated_at = now()
          WHERE id = $1 AND archived_at IS NULL`,
        [req.params.id, actorDe(req)],
      );
      if ((r.rowCount ?? 0) === 0) {
        res.status(404).json({ success: false, error: 'draft_nao_encontrado' });
        return;
      }
      res.status(200).json({ success: true });
    } catch (error: unknown) {
      const e = error instanceof Error ? error : new Error(String(error));
      reportError(e, { source: 'TemplateDraftsController:archive' });
      res.status(500).json({ success: false, error: 'Failed to archive template draft' });
    }
  }
}
