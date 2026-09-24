import { Request, Response } from 'express';
import { DatabaseConnection } from '@shared/database/DatabaseConnection';
import { normalizeSchedule } from '../../infrastructure/scheduleNormalizer';
import { logger } from '@shared/logging';

/**
 * PublicVacancyController
 *
 * Endpoint público (sem auth) para leitura de dados não-sensíveis de uma vaga.
 * Usado pela página pública de vaga (landing page de candidatos).
 *
 * PII do paciente (nome, telefone, email, documento, etc.) nunca é exposta.
 * Localização é coarse: bairro + cidade + província — nunca rua, número,
 * complemento ou coordenadas.
 *
 * ── O que mudou em 25/08/2026, e por quê ───────────────────────────────────
 * O comentário anterior terminava assim: *"Diagnóstico (pathologies) é exposto sem nome
 * associado, necessário para o candidato qualificar a vaga."* Isso **documentava a infração
 * como decisão de produto**, e as três partes da frase não se sustentaram na medição:
 *
 *  1. **"sem nome associado" ≠ anonimizado.** `patients.diagnosis` é TEXTO LIVRE: medido em
 *     **156 valores distintos para 184 pacientes (85%)**, 146 com espaço, 37 acima de 60 chars,
 *     máximo 522. String quase única É identificador — e saía junto de `patient_zone`
 *     (bairro + cidade + província) e de `caso{N}-{M}`, que é estável e enumerável.
 *     Ley 25.326 art. 2 exige que o dado não possa associar-se a pessoa **determinável**.
 *  2. **"necessário para qualificar a vaga" não passa no teste de pertinência** do art. 4 inc. 1
 *     (*"adecuados, pertinentes y no excesivos"*): 522 caracteres de ficha clínica não são o
 *     mínimo para qualificar uma candidatura — um rótulo de catálogo fechado é.
 *  3. **"público" era mais amplo do que se supunha.** Esta rota não filtrava `status` nem
 *     `is_draft`: alcançava **388 vagas**, incluindo **101 rascunhos** e 149 em status não
 *     publicável — contra 189 no feed `/api/public/v1/jobs`.
 *
 * ⇒ `p.diagnosis` e `p.dependency_level` saíram do SELECT (os dois revelam estado de saúde), e
 * o WHERE ganhou as condições de publicidade. Ripple medido antes: o tipo `PublicVacancyDetail`
 * do `enlite-frontend` **não continha** nenhum dos dois — a tela nunca os usou.
 *
 * ⚠️ **O que esta mudança NÃO fecha, e está medido:** `talentum_description` é gerada a partir
 * do diagnóstico (`TalentumDescriptionService`) e **89 de 265 descrições contêm o diagnóstico
 * literal** (84 pacientes distintos) — piso, não teto, porque paráfrase não é contada. Remover
 * o campo esvazia a landing page, então é decisão de produto e está escalada. Enquanto ela não
 * vier, a guarda de fronteira desta rota cobre o que foi decidido, e a lacuna está NOMEADA aqui
 * em vez de silenciosa.
 */

/**
 * T066 (spec 027 Fase 6) — o slug tolera os dois formatos de `case_number`:
 *   - legado: "caso729-5568" (sem prefixo, separador "-")
 *   - novo:   "casoEN1234-01" / "casoEN1234#01" / "caso1234#01" (prefixo `EN`
 *     opcional — ver `caseNumberFormat.ts` — e separador "-" OU "#")
 * ⚠️ O ramo antigo continua casando sem alteração — URL já publicada não quebra.
 */
const SLUG_REGEX = /^caso(?:EN)?(\d+)[-#](\d+)$/i;

/** Só para o log distinto do T066 — "começa com caso" mas não casou o SLUG_REGEX. */
const LOOKS_LIKE_SLUG = /^caso/i;

/**
 * Uma vaga só é pública se está publicável. Antes, qualquer `job_posting` não-deletada
 * respondia — inclusive rascunho. Mesma lista do feed (`PublicJobsQueryBuilder`), porque
 * duas definições de "público" divergem em silêncio (D179).
 *
 * ⚠️ Consequência deliberada: link antigo para vaga já fechada passa a devolver **404** em vez
 * de renderizar a vaga. É a resposta certa — vaga fechada não é conteúdo público —, e é
 * visível para quem clicar, não silenciosa.
 */
const STATUS_PUBLICAVEL = ['ACTIVE', 'SEARCHING', 'SEARCHING_REPLACEMENT', 'RAPID_RESPONSE'];

export class PublicVacancyController {
  private readonly db = DatabaseConnection.getInstance().getPool();

  async getById(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;

      const slugMatch = SLUG_REGEX.exec(id);
      const isSlug = !!slugMatch;

      // T066: distingue "vaga não existe" (404 intencional) de "slug com formato
      // desconhecido" (nem "casoNNN-MM" legado, nem "casoEN NNN[-#]MM" novo) — sem
      // isso, os dois 404 são idênticos e ninguém percebe o slug mal formado.
      // `id` não é PII: é parâmetro de rota de link público (case/vacancy number).
      if (!isSlug && LOOKS_LIKE_SLUG.test(id)) {
        logger.warn({ msg: '[PublicVacancyController] slug-like id não casou nenhum formato conhecido', id });
      }

      const params: (string | number | string[])[] = isSlug
        ? [Number(slugMatch![1]), Number(slugMatch![2])]
        : [id];
      // O placeholder da lista de status vem DEPOIS dos parâmetros de identificação, cujo
      // número muda entre slug (2) e uuid (1) — por isso é calculado, não chumbado.
      const statusParam = `$${params.length + 1}`;
      params.push(STATUS_PUBLICAVEL);
      const identificacao = isSlug
        ? 'jp.case_number = $1 AND jp.vacancy_number = $2'
        : 'jp.id = $1';
      const whereClause =
        `${identificacao} AND jp.deleted_at IS NULL ` +
        `AND jp.is_draft = false AND jp.status = ANY(${statusParam}::text[])`;

      const result = await this.db.query(
        `
        SELECT
          jp.id,
          jp.case_number,
          jp.vacancy_number,
          jp.title,
          jp.status,
          -- ATENCAO: as duas colunas clinicas do paciente NAO entram aqui -- as duas revelam
          -- estado de saude e esta rota e aberta. Os nomes delas estao no cabecalho do arquivo,
          -- e NAO se repetem nesta string de proposito: a guarda do teste procura o nome da
          -- coluna no SQL, e um comentario que a cite reprova o arquivo consertado.
          -- service_type FICA: e profissao buscada (AT / CAREGIVER / PSYCHOLOGIST), nao saude.
          -- (sem crases aqui: este SQL vive dentro de um template literal, e crase o encerra.)
          p.service_type AS service_type,
          jp.required_professions,
          jp.required_sex,
          jp.age_range_min,
          jp.age_range_max,
          jp.worker_attributes,
          jp.schedule,
          jp.schedule_days_hours,
          jp.salary_text,
          jp.talentum_description,
          jp.talentum_whatsapp_url,
          jp.country,
          jp.created_at,
          COALESCE(
            NULLIF(CONCAT_WS(', ',
              COALESCE(pa.neighborhood, p.zone_neighborhood),
              pa.city,
              pa.state
            ), ''),
            jp.inferred_zone
          ) AS patient_zone
        FROM job_postings jp
        LEFT JOIN patients p ON jp.patient_id = p.id
        LEFT JOIN patient_addresses pa ON jp.patient_address_id = pa.id
        WHERE ${whereClause}
        `,
        params,
      );

      if (result.rows.length === 0) {
        res.status(404).json({ success: false, error: 'Vacancy not found' });
        return;
      }

      const row = result.rows[0];

      // ── Lista de PERMISSÃO, não de bloqueio ────────────────────────────────
      // Antes: `res.json({ data: row })` devolvia a linha CRUA do banco. Com isso, o que a rota
      // expõe era decidido pelo SELECT e por mais nada — bastava alguém acrescentar uma coluna
      // (para um filtro, um log, um join novo) e ela ia ao ar sem ninguém decidir. Foi assim que
      // `diagnosis` e `dependency_level` estavam saindo.
      //
      // Uma lista de BLOQUEIO ("apague `diagnosis` da linha") não resolveria: ela protege contra
      // as colunas que alguém lembrou, e a próxima passa. É a mesma escolha da C5 do parecer do
      // `lex` sobre o `asIndexable` — permitir o conhecido, não proibir o lembrado.
      const data = {
        id:                     row.id,
        case_number:            row.case_number,
        vacancy_number:         row.vacancy_number,
        title:                  row.title,
        status:                 row.status,
        service_type:           row.service_type,
        required_professions:   row.required_professions,
        required_sex:           row.required_sex,
        age_range_min:          row.age_range_min,
        age_range_max:          row.age_range_max,
        worker_attributes:      row.worker_attributes,
        schedule:               normalizeSchedule(row.schedule),
        schedule_days_hours:    row.schedule_days_hours,
        salary_text:            row.salary_text,
        talentum_description:   row.talentum_description,
        talentum_whatsapp_url:  row.talentum_whatsapp_url,
        patient_zone:           row.patient_zone,
        country:                row.country,
        created_at:             row.created_at,
      };

      res.status(200).json({ success: true, data });
    } catch (error: unknown) {
      console.error('[PublicVacancyController] Error fetching vacancy:', error);
      res.status(500).json({ success: false, error: 'Failed to fetch vacancy' });
    }
  }
}
