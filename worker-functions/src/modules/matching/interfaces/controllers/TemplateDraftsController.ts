import { Request, Response } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { reportError } from '@shared/logging';
import {
  CATEGORIAS,
  IDIOMAS,
  Idioma,
  avisos,
  bloqueios,
  slugComPrefixo,
  validarRascunho,
} from '../../../notification/domain/templateDraftRules';
import { SubmitTemplateDraft, submissaoDeuCerto } from '../../../notification/application/SubmitTemplateDraft';
import { TwilioContentWriter } from '../../../notification/infrastructure/TwilioContentWriter';

/**
 * TemplateDraftsController — escrever e salvar a mensagem (spec 010, F2 passos 2.1 e 2.2).
 *
 *   GET    /api/admin/template-drafts             (staff) — os rascunhos
 *   POST   /api/admin/template-drafts             (admin) — cria
 *   PUT    /api/admin/template-drafts/:id         (admin) — edita, trava otimista
 *   DELETE /api/admin/template-drafts/:id         (admin) — arquiva (não apaga)
 *   POST   /api/admin/template-drafts/:id/submit  (admin) — ⚠️ IRREVERSÍVEL
 *   POST   /api/admin/template-drafts/:id/duplicate (admin) — duplicar e corrigir
 *
 * 🔒 REGISTRO — O PARECER DO `lex` NÃO FOI EMITIDO.
 *
 * A regra do CLAUDE.md exige o parecer ANTES de implementar ação que escreve
 * para fora do perímetro, e `submit` faz exatamente isso: cria Content na
 * Twilio e submete à Meta. O Gabriel determinou explicitamente, em 31/08/2026,
 * construir o fluxo inteiro sem o parecer. Está escrito aqui porque quem ler
 * este arquivo depois precisa saber que o portão foi contornado por decisão
 * dele, e não por descuido de quem escreveu.
 *
 * 🔒 A submissão sobe DESLIGADA: `TEMPLATE_SUBMISSION_ENABLED` precisa valer
 * 'true'. Neste repo merge = deploy, e a capacidade de escrever na Meta não
 * pode nascer ligada só porque alguém mergeou. Sem a flag, a rota responde 503
 * dizendo o motivo — nunca um silêncio que a tela leia como sucesso.
 *
 * ⚠️ `submit` é IRREVERSÍVEL: o nome do template fica queimado na WABA mesmo se
 * a Meta recusar. Por isso exige `confirmado: true` no corpo — confirmação
 * explícita é critério da própria spec, não zelo nosso.
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
  content_sid: string | null;
  submitted_at: string | null;
  submitted_by: string | null;
  submission_error: string | null;
  meta_approval_status: string | null;
  meta_approval_reason: string | null;
  meta_approval_detail: string | null;
  meta_approval_checked_at: string | null;
}

const CAMPOS = `d.id, d.slug, d.name, d.body, d.category, d.language, d.version,
                d.created_by, d.updated_by, d.created_at, d.updated_at,
                d.content_sid, d.submitted_at, d.submitted_by, d.submission_error`;

/**
 * 🔒 O estado da META vem de `message_templates`, NÃO daqui.
 *
 * `submitted_at` só responde "foi enviado?". O veredito da Meta vive na outra
 * tabela, preenchido pelo sync. Sem esta junção a tela dizia "esperando
 * autorización" PARA SEMPRE — inclusive com a mensagem aprovada há semanas.
 * Foi o Gabriel quem viu, na tela de produção, em 01/09/2026.
 *
 * LEFT JOIN por `content_sid`: o rascunho não submetido não tem par, e ausência
 * de linha lá é "ainda não foi", não erro.
 */
const CAMPOS_META = `t.meta_approval_status, t.meta_approval_reason,
                     t.meta_approval_detail, t.meta_approval_checked_at`;

const DE = `FROM message_template_drafts d
            LEFT JOIN message_templates t ON UPPER(t.content_sid) = UPPER(d.content_sid)`;

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
    contentSid: r.content_sid,
    submittedAt: r.submitted_at,
    submittedBy: r.submitted_by,
    submissionError: r.submission_error,
    metaStatus: r.meta_approval_status,
    metaReason: r.meta_approval_reason,
    metaDetail: r.meta_approval_detail,
    metaCheckedAt: r.meta_approval_checked_at,
    /**
     * Três estados, e a diferença entre os dois últimos é o bug de 01/09:
     *   'draft'     — escrito, não enviado
     *   'submitted' — enviado, e a Meta AINDA não respondeu
     *   'decided'   — a Meta respondeu; `metaStatus` diz o quê
     * Antes, tudo que tinha `submitted_at` era 'submitted' para sempre.
     */
    status: !r.submitted_at ? 'draft' : (r.meta_approval_status ? 'decided' : 'submitted'),
  };
}

function actorDe(req: Request): string | null {
  return ((req as unknown as { user?: { uid?: string } }).user)?.uid ?? null;
}

export class TemplateDraftsController {
  private db: Pool;
  private submitter: SubmitTemplateDraft;

  constructor(db?: Pool, submitter?: SubmitTemplateDraft) {
    this.db = db ?? DatabaseConnection.getInstance().getPool();
    // Injetável para que o teste dubla o caso de uso e NUNCA toque a rede.
    this.submitter = submitter ?? new SubmitTemplateDraft(this.db, new TwilioContentWriter());
  }

  async list(_req: Request, res: Response): Promise<void> {
    try {
      const r = await this.db.query<DraftRow>(
        `SELECT ${CAMPOS}, ${CAMPOS_META} ${DE}
          WHERE d.archived_at IS NULL
          ORDER BY d.updated_at DESC`,
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
    if (bloqueios(problemas).length > 0) {
      res.status(422).json({ success: false, error: 'Draft rejected by platform rules', problemas });
      return;
    }
    const avisosDaRegra = avisos(problemas);

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
           RETURNING ${CAMPOS.replace(/\bd\./g, '')}, NULL::text AS meta_approval_status,
                     NULL::text AS meta_approval_reason, NULL::text AS meta_approval_detail,
                     NULL::timestamptz AS meta_approval_checked_at`,
        [slug, entrada.name, entrada.body, entrada.category, entrada.language, actor],
      );
      res.status(201).json({ success: true, data: { draft: paraApi(r.rows[0]), avisos: avisosDaRegra } });
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
    if (bloqueios(problemas).length > 0) {
      res.status(422).json({ success: false, error: 'Draft rejected by platform rules', problemas });
      return;
    }
    const avisosDaRegra = avisos(problemas);

    try {
      const actor = actorDe(req);
      const r = await this.db.query<DraftRow>(
        `UPDATE message_template_drafts
            SET slug = $1, name = $2, body = $3, category = $4, language = $5,
                updated_by = $6, updated_at = now(), version = version + 1
          WHERE id = $7 AND version = $8 AND archived_at IS NULL AND content_sid IS NULL
      RETURNING ${CAMPOS.replace(/\bd\./g, '')}, NULL::text AS meta_approval_status,
                NULL::text AS meta_approval_reason, NULL::text AS meta_approval_detail,
                NULL::timestamptz AS meta_approval_checked_at`,
        [slug, entrada.name, entrada.body, entrada.category, entrada.language, actor, id, version],
      );

      // rowCount 0 é ambíguo por si só, e tratá-lo como sucesso é o defeito que
      // o `FunnelStageMessagesController.update` tem hoje (200 sem gravar). Aqui
      // a ambiguidade é RESOLVIDA com uma segunda pergunta, não presumida.
      if ((r.rowCount ?? 0) === 0) {
        const existe = await this.db.query<{ version: number; content_sid: string | null }>(
          `SELECT version, content_sid FROM message_template_drafts WHERE id = $1 AND archived_at IS NULL`, [id],
        );
        if ((existe.rowCount ?? 0) === 0) {
          res.status(404).json({ success: false, error: 'draft_nao_encontrado' });
          return;
        }
        // Já submetido não se edita: o texto que foi para a Meta não pode ser
        // reescrito por baixo. A spec pede "duplicar e corrigir" no lugar.
        if (existe.rows[0].content_sid) {
          res.status(409).json({ success: false, error: 'ja_submetido_use_duplicar' });
          return;
        }
        res.status(409).json({
          success: false,
          error: 'versao_desatualizada',
          versaoAtual: existe.rows[0].version,
        });
        return;
      }

      res.status(200).json({ success: true, data: { draft: paraApi(r.rows[0]), avisos: avisosDaRegra } });
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

  /**
   * ⚠️ IRREVERSÍVEL — cria o Content na Twilio e submete à Meta.
   *
   * Exige `confirmado: true`. Não é burocracia: o nome do template fica queimado
   * na WABA mesmo se a Meta recusar, e um clique acidental não tem desfazer.
   */
  async submit(req: Request, res: Response): Promise<void> {
    const confirmado = (req.body ?? {}) as { confirmado?: unknown };
    if (confirmado.confirmado !== true) {
      res.status(400).json({ success: false, error: 'confirmacao_obrigatoria' });
      return;
    }

    try {
      const r = await this.submitter.execute(req.params.id, actorDe(req));
      if (submissaoDeuCerto(r)) {
        res.status(200).json({ success: true, data: { submission: r } });
        return;
      }
      switch (r.tipo) {
        case 'nao_encontrado':
          res.status(404).json({ success: false, error: 'draft_nao_encontrado' });
          return;
        case 'ja_submetido':
          res.status(409).json({ success: false, error: 'ja_submetido', contentSid: r.contentSid });
          return;
        case 'regras':
          res.status(422).json({ success: false, error: 'Draft rejected by platform rules', problemas: r.problemas });
          return;
        case 'indisponivel':
          // 503 e NÃO 500: a submissão desligada é um estado configurado, não um
          // defeito. E a tela precisa dizer QUAL dos dois motivos é.
          res.status(503).json({ success: false, error: 'submissao_indisponivel', motivo: r.motivo });
          return;
        default:
          res.status(502).json({ success: false, error: 'twilio_falhou', mensagem: r.mensagem });
          return;
      }
    } catch (error: unknown) {
      const e = error instanceof Error ? error : new Error(String(error));
      reportError(e, { source: 'TemplateDraftsController:submit' });
      res.status(500).json({ success: false, error: 'Failed to submit template draft' });
    }
  }

  /**
   * Duplicar e corrigir — o caminho que a spec pede no lugar de editar o que já
   * foi submetido. O clone nasce SEM `content_sid`: é rascunho de novo.
   */
  async duplicate(req: Request, res: Response): Promise<void> {
    try {
      const origem = await this.db.query<DraftRow>(
        `SELECT ${CAMPOS}, ${CAMPOS_META} ${DE} WHERE d.id = $1`, [req.params.id],
      );
      if ((origem.rowCount ?? 0) === 0) {
        res.status(404).json({ success: false, error: 'draft_nao_encontrado' });
        return;
      }
      const d = origem.rows[0];

      // Sufixo numerado até achar um livre. Sem isto, duplicar duas vezes bate
      // no índice único e a pessoa recebe um 409 que não explica nada.
      const usados = await this.db.query<{ slug: string }>(
        `SELECT slug FROM message_template_drafts WHERE slug LIKE $1 AND archived_at IS NULL
          UNION SELECT slug FROM message_templates WHERE slug LIKE $1`,
        [`${d.slug}%`],
      );
      const ocupados = new Set(usados.rows.map((x) => x.slug));
      let n = 2;
      while (ocupados.has(`${d.slug}_v${n}`)) n += 1;
      const novoSlug = `${d.slug}_v${n}`;

      const actor = actorDe(req);
      const r = await this.db.query<DraftRow>(
        `INSERT INTO message_template_drafts (slug, name, body, category, language, created_by, updated_by)
              VALUES ($1, $2, $3, $4, $5, $6, $6)
           RETURNING ${CAMPOS.replace(/\bd\./g, '')}, NULL::text AS meta_approval_status,
                     NULL::text AS meta_approval_reason, NULL::text AS meta_approval_detail,
                     NULL::timestamptz AS meta_approval_checked_at`,
        [novoSlug, d.name, d.body, d.category, d.language, actor],
      );
      res.status(201).json({ success: true, data: { draft: paraApi(r.rows[0]) } });
    } catch (error: unknown) {
      const e = error instanceof Error ? error : new Error(String(error));
      reportError(e, { source: 'TemplateDraftsController:duplicate' });
      res.status(500).json({ success: false, error: 'Failed to duplicate template draft' });
    }
  }
}
