import { Pool } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { IMessagingService } from '../domain/IMessagingService';
import { Result } from '@shared/utils/Result';
import { logger } from '@shared/logging';

const TEMPLATE_SLUG = 'complete_register_ofc';

// Intervalo entre envios para evitar bloqueio de número pelo WhatsApp/Twilio.
// Padrão: 1500ms. Sobreposto pela variável de ambiente BULK_DISPATCH_DELAY_MS.
const DEFAULT_DELAY_MS = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Workers com encuadre que ainda têm documentos ou perfil incompletos
const INCOMPLETE_WORKERS_QUERY = `
  SELECT DISTINCT
    w.id,
    w.phone,
    w.status,
    w.profession,
    w.preferred_age_range,
    w.preferred_types,
    w.experience_types,
    wd.documents_status,
    CASE WHEN wd.resume_cv_url IS NULL THEN 'SIM' ELSE 'não' END AS falta_curriculo,
    CASE WHEN wd.identity_document_url IS NULL THEN 'SIM' ELSE 'não' END AS falta_rg_cpf,
    CASE WHEN wd.criminal_record_url IS NULL THEN 'SIM' ELSE 'não' END AS falta_antecedentes,
    CASE WHEN wd.professional_registration_url IS NULL THEN 'SIM' ELSE 'não' END AS falta_registro_prof,
    CASE WHEN wd.liability_insurance_url IS NULL THEN 'SIM' ELSE 'não' END AS falta_seguro,
    CASE WHEN w.sex_encrypted IS NULL THEN 'SIM' ELSE 'não' END AS falta_sexo,
    CASE WHEN w.first_name_encrypted IS NULL THEN 'SIM' ELSE 'não' END AS falta_nome,
    CASE WHEN w.profession IS NULL OR w.profession = '' THEN 'SIM' ELSE 'não' END AS falta_profissao,
    CASE WHEN w.preferred_age_range IS NULL OR w.preferred_age_range = '' THEN 'SIM' ELSE 'não' END AS falta_age_range,
    CASE WHEN w.preferred_types IS NULL OR w.preferred_types = '{}' THEN 'SIM' ELSE 'não' END AS falta_preferred_types,
    CASE WHEN w.experience_types IS NULL OR w.experience_types = '{}' THEN 'SIM' ELSE 'não' END AS falta_experience_types
  FROM workers w
  INNER JOIN encuadres e ON e.worker_id = w.id
  LEFT JOIN worker_documents wd ON wd.worker_id = w.id
  WHERE
    w.email NOT LIKE '%@enlite.import'
    AND w.phone IS NOT NULL
    AND w.phone <> ''
    AND (
      wd.documents_status IS NULL
      OR wd.documents_status NOT IN ('submitted', 'under_review', 'approved')
      OR w.sex_encrypted IS NULL
      OR w.first_name_encrypted IS NULL
      OR w.profession IS NULL OR w.profession = ''
      OR w.preferred_age_range IS NULL OR w.preferred_age_range = ''
      OR w.preferred_types IS NULL OR w.preferred_types = '{}'
      OR w.experience_types IS NULL OR w.experience_types = '{}'
    )
  ORDER BY w.id
`;

export interface BulkDispatchDetail {
  workerId: string;
  phone: string;
  status: 'sent' | 'error';
  twilioSid?: string;
  error?: string;
}

export interface BulkDispatchResult {
  batchId: string;
  total: number;
  sent: number;
  errors: number;
  dryRun: boolean;
  details: BulkDispatchDetail[];
}

export interface BulkDispatchOptions {
  /** Se true, executa a query mas não chama o Twilio nem grava logs. */
  dryRun?: boolean;
  /** Limita o envio aos primeiros N workers (útil para testes pontuais). */
  limit?: number;
}

export class BulkDispatchIncompleteWorkersUseCase {
  constructor(
    private readonly db: Pool,
    private readonly messaging: IMessagingService,
  ) {}

  async execute(triggeredBy: string, opts: BulkDispatchOptions = {}): Promise<Result<BulkDispatchResult>> {
    const { dryRun = false, limit } = opts;
    const batchId = uuidv4();
    const batchLogger = logger.child({ batchId, triggeredBy });

    batchLogger.info('BulkDispatch iniciado');

    // 1. Busca workers com cadastro incompleto
    let rows: Array<{ id: string; phone: string }>;
    try {
      const queryResult = await this.db.query<{ id: string; phone: string }>(
        INCOMPLETE_WORKERS_QUERY,
      );
      rows = queryResult.rows;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return Result.fail<BulkDispatchResult>(
        `Erro ao consultar workers incompletos: ${msg}`,
      );
    }

    // Aplica limite se informado
    if (limit && limit > 0) {
      rows = rows.slice(0, limit);
    }

    batchLogger.info({ total: rows.length, dryRun }, 'Workers elegíveis para dispatch');

    // Dry-run: retorna quem receberia sem chamar Twilio nem gravar logs
    if (dryRun) {
      const details: BulkDispatchDetail[] = rows.map(row => ({
        workerId: row.id,
        phone: row.phone,
        status: 'sent' as const,
      }));
      return Result.ok<BulkDispatchResult>({
        batchId,
        total: rows.length,
        sent: 0,
        errors: 0,
        dryRun: true,
        details,
      });
    }

    const details: BulkDispatchDetail[] = [];
    const delayMs = parseInt(process.env.BULK_DISPATCH_DELAY_MS ?? '', 10) || DEFAULT_DELAY_MS;

    // 2. Dispara mensagem para cada worker e persiste o log
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];

      // Aguarda delay entre envios (não aplica antes do primeiro)
      if (i > 0) await sleep(delayMs);

      const sendResult = await this.messaging.sendWhatsApp({
        to: row.phone,
        templateSlug: TEMPLATE_SLUG,
      });

      const detail: BulkDispatchDetail = {
        workerId: row.id,
        phone: row.phone,
        status: sendResult.isSuccess ? 'sent' : 'error',
        twilioSid: sendResult.isSuccess ? sendResult.getValue()!.externalId : undefined,
        error: sendResult.isFailure ? sendResult.error : undefined,
      };

      details.push(detail);

      // 3. Persiste log — falhas de log são non-blocking
      await this.db
        .query(
          `INSERT INTO whatsapp_bulk_dispatch_logs
             (worker_id, triggered_by, phone, template_slug, status, twilio_sid, error_message, batch_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            row.id,
            triggeredBy,
            row.phone,
            TEMPLATE_SLUG,
            detail.status,
            detail.twilioSid ?? null,
            detail.error ?? null,
            batchId,
          ],
        )
        .catch((err: Error) => {
          batchLogger.warn({ workerId: row.id, error: err.message }, 'Falha ao gravar log de dispatch');
        });
    }

    const sent = details.filter(d => d.status === 'sent').length;

    batchLogger.info({ sent, errors: rows.length - sent }, 'BulkDispatch concluído');

    return Result.ok<BulkDispatchResult>({
      batchId,
      total: rows.length,
      sent,
      errors: rows.length - sent,
      dryRun: false,
      details,
    });
  }
}
