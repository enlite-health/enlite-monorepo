import { Pool } from 'pg';
import { logger } from '@shared/logging';
import { TwilioContentWriter } from '../infrastructure/TwilioContentWriter';
import { Idioma, bloqueios, idiomaTwilio, paraTwilio, validarRascunho, Problema } from '../domain/templateDraftRules';

/**
 * SubmitTemplateDraft — o ato irreversível (spec 010, F2 passos 2.3 e 2.4).
 *
 * 🔒 REGISTRO: o parecer do `lex` NÃO foi emitido. A regra do CLAUDE.md exige o
 * parecer ANTES de implementar ação que escreve para fora do perímetro. O
 * Gabriel determinou explicitamente, em 31/08/2026, construir sem ele. Fica
 * escrito no código porque é o código que sobrevive à conversa.
 *
 * A ORDEM importa, e ela não é arbitrária:
 *
 *   1. valida de novo   — nunca submeter o que não passaria; a validação do
 *                         save pode ter ficado velha se as regras mudaram;
 *   2. cria o Content   — REVERSÍVEL (dá para apagar na Twilio);
 *   3. grava o SID JÁ   — antes de submeter. Se o passo 4 falhar, o SID está
 *                         guardado e a retentativa NÃO cria um Content órfão;
 *   4. submete à Meta   — IRREVERSÍVEL: o nome fica queimado na WABA;
 *   5. promove          — insere em `message_templates` para o catálogo passar
 *                         a enxergar, e o sync de estado da Meta preencher.
 *
 * Inverter 3 e 4 é o defeito clássico: submete, falha ao gravar, e a pessoa
 * reclica — criando um segundo Content e queimando um segundo nome.
 */

export type FalhaSubmissao =
  | { tipo: 'nao_encontrado' }
  | { tipo: 'ja_submetido'; contentSid: string }
  | { tipo: 'regras'; problemas: Problema[] }
  | { tipo: 'indisponivel'; motivo: 'flag_desligada' | 'sem_credencial' }
  | { tipo: 'twilio'; mensagem: string };

export interface SucessoSubmissao {
  contentSid: string;
  slug: string;
  bodyTwilio: string;
  variaveis: string[];
}

interface DraftRow {
  id: string;
  slug: string;
  name: string;
  body: string;
  category: string;
  language: string;
  content_sid: string | null;
}

export class SubmitTemplateDraft {
  constructor(
    private readonly db: Pool,
    private readonly writer: TwilioContentWriter,
  ) {}

  async execute(id: string, actorUid: string | null): Promise<SucessoSubmissao | FalhaSubmissao> {
    const r = await this.db.query<DraftRow>(
      `SELECT id, slug, name, body, category, language, content_sid
         FROM message_template_drafts
        WHERE id = $1 AND archived_at IS NULL`,
      [id],
    );
    if ((r.rowCount ?? 0) === 0) return { tipo: 'nao_encontrado' };
    const d = r.rows[0];

    // Já submetido não é erro do sistema: é um clique repetido, e a resposta
    // certa é dizer QUAL Content já existe, não criar outro.
    if (d.content_sid) return { tipo: 'ja_submetido', contentSid: d.content_sid };

    const problemas = validarRascunho({
      slug: d.slug, name: d.name, body: d.body, category: d.category, language: d.language,
    });
    // 🔒 SÓ BLOQUEIO PARA A SUBMISSÃO. Aviso (AR-01/MKT-02) não trava: a decisão
    // de mandar sem cláusula de baja é de quem escreve, e ela já foi tomada na
    // tela — o `confirmado: true` do controller é o registro dessa escolha.
    // Travar aqui contrariaria em silêncio o que a tela prometeu.
    const impedem = bloqueios(problemas);
    if (impedem.length > 0) return { tipo: 'regras', problemas: impedem };

    const indisponivel = this.writer.indisponivel;
    if (indisponivel) return { tipo: 'indisponivel', motivo: indisponivel };

    const { body: bodyTwilio, variaveis } = paraTwilio(d.body);

    let contentSid: string;
    try {
      const criado = await this.writer.criarContent({
        friendlyName: d.slug,
        // ⚠️ `es-AR` → `es_AR`. A Twilio recusa o hífen com 92004 — medido.
        language: idiomaTwilio(d.language),
        body: bodyTwilio,
        variaveis,
      });
      contentSid = criado.sid;
    } catch (err: unknown) {
      return this.registrarFalha(d.id, err, 'criar_content');
    }

    // 3 — grava ANTES de submeter. Se o 4 falhar, a retentativa encontra o SID
    // e não cria Content novo.
    await this.db.query(
      `UPDATE message_template_drafts
          SET content_sid = $2, submission_error = NULL, updated_at = now()
        WHERE id = $1`,
      [d.id, contentSid],
    );

    try {
      await this.writer.submeterParaAprovacao(contentSid, d.slug, d.category);
    } catch (err: unknown) {
      return this.registrarFalha(d.id, err, 'submeter');
    }

    await this.db.query(
      `UPDATE message_template_drafts
          SET submitted_at = now(), submitted_by = $2, submission_error = NULL, updated_at = now()
        WHERE id = $1`,
      [d.id, actorUid],
    );

    // 5 — a ponte. Sem isto o rascunho vira um Content na Twilio que o nosso
    // catálogo não conhece, e a pessoa nunca veria o estado da Meta para a
    // mensagem que ela própria escreveu.
    await this.db.query(
      `INSERT INTO message_templates (slug, name, body, category, is_active, content_sid, body_twilio)
            VALUES ($1, $2, $3, $4, true, $5, $6)
       ON CONFLICT (slug) DO UPDATE
          SET content_sid = EXCLUDED.content_sid,
              body_twilio = EXCLUDED.body_twilio,
              updated_at  = now()`,
      [d.slug, d.name, d.body, d.category, contentSid, bodyTwilio],
    );

    logger.info({ msg: 'template_draft_submetido', draftId: d.id, contentSid, slug: d.slug });
    return { contentSid, slug: d.slug, bodyTwilio, variaveis };
  }

  /**
   * Guarda o motivo da falha no próprio rascunho.
   *
   * Sem isto a pessoa só veria um botão que não funciona — e "não funciona" é a
   * pior mensagem de erro possível, porque não diz se é a rede, a credencial,
   * ou o texto.
   */
  private async registrarFalha(id: string, err: unknown, passo: string): Promise<FalhaSubmissao> {
    const e = err instanceof Error ? err : new Error(String(err));
    logger.warn({ msg: 'template_draft_submissao_falhou', draftId: id, passo, erro: e.message });
    await this.db.query(
      `UPDATE message_template_drafts SET submission_error = $2, updated_at = now() WHERE id = $1`,
      [id, `${passo}: ${e.message}`],
    );
    return { tipo: 'twilio', mensagem: e.message };
  }
}

/** Guarda de tipo — deixa o controller distinguir sem `as`. */
export function submissaoDeuCerto(r: SucessoSubmissao | FalhaSubmissao): r is SucessoSubmissao {
  return (r as SucessoSubmissao).contentSid !== undefined && (r as { tipo?: string }).tipo === undefined;
}

export type { Idioma };
