import { Request, Response } from 'express';
import { Pool } from 'pg';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { reportError } from '@shared/logging';
import { evaluateTemplateEligibility } from '../../../notification/application/StageTemplateEligibility';

/**
 * TemplateCatalogController — o catálogo de plantillas (spec 010, F1).
 *
 *   GET /api/admin/template-catalog  (staff) — o que existe e em que pé está
 *
 * F1 é ESPELHO: só leitura. Criar, editar e submeter é F2, e a F2 depende de
 * parecer do `lex` porque escreve para fora do perímetro. Não há rota de escrita
 * aqui, e o teste de rota trava isso.
 *
 * ⚠️ NÃO confundir com `MessagingController.createTemplate`
 * (`POST /api/admin/messaging/templates`), que existe em produção e é defeito
 * conhecido: grava linha SEM `content_sid` — template que nunca envia — e a
 * própria listagem dele esconde essas linhas por padrão
 * (`requireContentSid = req.query.includeUnlinked !== 'true'`). Aquilo não é
 * base para nada; está reportado à parte e fora do escopo desta spec.
 *
 * Duas informações que a tela mostra SEPARADAS, porque são perguntas
 * independentes e confundi-las foi o que fez alguém esperar a Meta para
 * descobrir no fim que a mensagem não servia:
 *   - a Meta autorizou?          → `metaStatus`, vindo da Meta (10 estados)
 *   - nós sabemos usar isso?     → `eligible`, regra NOSSA (StageTemplateEligibility)
 * Um template pode estar APPROVED e ser inelegível — é o caso dos posicionais.
 */

interface CatalogRow {
  slug: string;
  name: string;
  language: string | null;
  base_name: string | null;
  body: string | null;
  body_twilio: string | null;
  category: string | null;
  is_active: boolean;
  content_sid: string | null;
  meta_approval_status: string | null;
  meta_approval_reason: string | null;
  meta_approval_detail: string | null;
  meta_approval_checked_at: string | null;
  used_in_stages: string[] | null;
  is_draft: boolean;
}

export class TemplateCatalogController {
  private db: Pool;

  constructor(db?: Pool) {
    this.db = db ?? DatabaseConnection.getInstance().getPool();
  }

  async list(_req: Request, res: Response): Promise<void> {
    try {
      const r = await this.db.query<CatalogRow>(
        `SELECT t.slug, t.name, t.body, t.body_twilio, t.category, t.is_active, t.content_sid,
                t.language,
                -- COALESCE, e nao t.base_name cru: linha criada pelo sync a partir
                -- do Console da Twilio nasce com base_name NULL, e caindo em slug
                -- ela vira um grupo de UM. Nunca pareia errado, so nao pareia.
                -- Deixar NULL faria todas elas colapsarem num unico grupo "null",
                -- juntando mensagens que nao tem relacao nenhuma.
                COALESCE(t.base_name, t.slug) AS base_name,
                t.meta_approval_status, t.meta_approval_reason, t.meta_approval_detail,
                t.meta_approval_checked_at,
                -- "usado em" é LEITURA nesta tela: onde a mensagem é usada se
                -- decide em /admin/mensajes-por-etapa. Aqui existe só para que
                -- ninguém arquive uma mensagem que está no ar sem ver isso.
                COALESCE(
                  (SELECT array_agg(m.stage ORDER BY m.stage)
                     FROM funnel_stage_messages m
                    WHERE m.template_slug = t.slug AND m.enabled = true),
                  ARRAY[]::text[]
                ) AS used_in_stages,
                false AS is_draft
           FROM message_templates t

         UNION ALL

         /*
          * OS RASCUNHOS. O desenho poe o rascunho como LINHA do catalogo
          * ("Sin texto todavia - borrador de Ana, 30/08"), e a razao e que a
          * pergunta desta tela e "o que existe e em que pe esta" -- um rascunho
          * e uma dessas coisas. Antes de eles aparecerem aqui, o unico caminho
          * para um rascunho salvo era a lista no pe da tela de registrar: dado
          * gravado que o catalogo nao enxergava.
          *
          * A GUARDA CONTRA A LINHA DUPLA. Um rascunho submetido ganha
          * content_sid, e o sync seguinte cria a linha correspondente em
          * message_templates. Sem o NOT EXISTS a mesma mensagem apareceria
          * duas vezes -- uma como rascunho, outra como template -- e a tela
          * afirmaria dois cadastros onde ha um.
          *
          * O body entra nas DUAS colunas de texto de proposito: um rascunho
          * ainda nao tem texto aprovado pela Meta, e o que existe e o que a
          * pessoa escreveu. Nao e a mesma coisa que body_twilio de um template
          * vivo, mas e a unica verdade disponivel -- e a tela marca a linha
          * como rascunho, entao ninguem le aquilo como "aprovado".
          */
         SELECT d.slug, d.name, d.body, d.body AS body_twilio, d.category,
                true AS is_active, d.content_sid, d.language,
                COALESCE(d.base_name, d.slug) AS base_name,
                NULL::text AS meta_approval_status, NULL::text AS meta_approval_reason,
                NULL::text AS meta_approval_detail, NULL::timestamptz AS meta_approval_checked_at,
                -- Rascunho nao esta pendurado em etapa nenhuma: nao tem slug
                -- vivo para funnel_stage_messages apontar.
                ARRAY[]::text[] AS used_in_stages,
                true AS is_draft
           FROM message_template_drafts d
          WHERE d.archived_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM message_templates x
               WHERE d.content_sid IS NOT NULL
                 AND UPPER(x.content_sid) = UPPER(d.content_sid)
            )

          ORDER BY slug`,
      );

      res.status(200).json({
        success: true,
        data: {
          templates: r.rows.map((t) => {
            const e = evaluateTemplateEligibility(t);
            return {
              slug: t.slug,
              name: t.name,
              // `null` é "idioma não registrado", e a tela diz isso — nunca vira
              // es-AR por omissão. Ver o cabeçalho da migration 300.
              language: t.language,
              baseName: t.base_name,
              // `bodyTwilio` é o texto que a Meta aprovou — o único que a tela
              // mostra. `body` é contrato de ENVIO (nomes das variáveis) e
              // divergiu do aprovado em 12 de 27 templates numa conferência de
              // 31/08. Mostrar `body` já pôs um sentinela na tela como se fosse
              // mensagem; a tela não o exibe, e por isso não precisa de filtro
              // reconhecendo literais.
              bodyTwilio: t.body_twilio,
              category: t.category,
              isActive: t.is_active,
              contentSid: t.content_sid,
              metaStatus: t.meta_approval_status,
              metaReason: t.meta_approval_reason,
              metaDetail: t.meta_approval_detail,
              metaCheckedAt: t.meta_approval_checked_at,
              eligible: e.eligible,
              ineligibleReason: e.reason,
              placeholders: e.placeholders,
              usedInStages: t.used_in_stages ?? [],
              /*
               * 🔒 A TELA PRECISA SABER QUE É RASCUNHO, e não pode deduzir por
               * `metaStatus === null`. `null` já significa outra coisa —
               * "nunca perguntamos à Meta" — e é o estado de templates VIVOS
               * que o sync trouxe sem verificação. Fundir os dois faria um
               * rascunho aparecer como template não verificado, e a pessoa
               * concluiria que uma mensagem inexistente está no ar.
               */
              isDraft: t.is_draft === true,
            };
          }),
        },
      });
    } catch (error: unknown) {
      const e = error instanceof Error ? error : new Error(String(error));
      reportError(e, { source: 'TemplateCatalogController:list' });
      res.status(500).json({ success: false, error: 'Failed to list template catalog' });
    }
  }
}
