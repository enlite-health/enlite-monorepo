/**
 * informe-diario-092-seed.ts — massa SINTÉTICA do e2e de tela da aba "Informes diarios" (spec 092, T501).
 *
 * Semeia por SQL (psql do `abac-stack-helper`, o mesmo banco da API do e2e) o que o prestador mandaria pelo app: dois informes da guarda
 * de UM paciente — o recente com respostas (uma com AVISO IMEDIATO da planilha: GEN "1") e o texto-espião, o antigo enviado fora do
 * prazo. Nenhum texto clínico real: o relato é `NARRATIVA-ESPIA-092` (o espião que prova a redação). O catálogo (objetivos/atividades com
 * escala) vem das migrations 587/589 do próprio banco do e2e — nada é inventado aqui.
 *
 * Limpeza: apagar o paciente leva serviço, faixa e informes por CASCADE (o purge real, migration 590) — `cleanupTestPatient`.
 */
import { psql, scalar } from './abac-stack-helper';

export const ESPIA_092 = 'NARRATIVA-ESPIA-092';

export interface InformeDiarioSeed {
  recentReportId: string;
  oldReportId: string;
}

const BA = `'America/Argentina/Buenos_Aires'`;

/** Segunda-feira mais recente ESTRITAMENTE antes de hoje (data civil de Buenos Aires), deslocada `semanasAtras` semanas. */
function segundaAnterior(semanasAtras: number): string {
  return scalar(
    `SELECT to_char(d - (CASE WHEN extract(dow FROM d)::int = 1 THEN 7 ELSE ((extract(dow FROM d)::int + 6) % 7) END) - ${semanasAtras * 7}, 'YYYY-MM-DD')
       FROM (SELECT (now() AT TIME ZONE ${BA})::date AS d) x`,
  );
}

function catalogId(table: 'therapeutic_specific_objectives' | 'therapeutic_activities', scale: string): string {
  const id = scalar(`SELECT id FROM ${table} WHERE daily_scale_code = '${scale}' ORDER BY id LIMIT 1`);
  if (!id) throw new Error(`catálogo sem ${table} com escala ${scale} (migrations 587/589 não carregadas neste banco?)`);
  return id;
}

/** Faixa de segunda 08:00-10:00 do serviço + dois informes do prestador (`workerId`). */
export function seedInformesDiarios(serviceId: string, workerId: string): InformeDiarioSeed {
  const slotId = scalar(
    `INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, duration_minutes, valid, created_by, updated_by)
     VALUES ('${serviceId}', 1, '08:00', 120, '[2026-01-01,)'::daterange, 'e2e092', 'e2e092') RETURNING id`,
  );
  const insertReport = (onDate: string, narrative: string, submittedSql: string): string =>
    scalar(
      `INSERT INTO daily_reports (id, worker_id, slot_id, on_date, narrative, narrative_source, device_submitted_at, app_version)
       VALUES (gen_random_uuid(), '${workerId}', '${slotId}', '${onDate}', '${narrative}', 'TYPED', ${submittedSql}, '1.0.0') RETURNING id`,
    );
  const recent = segundaAnterior(0);
  const old = segundaAnterior(1);
  // Recente: enviado 2 h depois do fim da guarda (dentro do prazo). Antigo: 3 dias depois (fora do prazo de 24 h, DC-2).
  const recentReportId = insertReport(recent, `${ESPIA_092} relato sintético da guardia`, `('${recent}'::date + time '12:00') AT TIME ZONE ${BA}`);
  const oldReportId = insertReport(old, `${ESPIA_092} relato sintético anterior`, `('${old}'::date + 3 + time '12:00') AT TIME ZONE ${BA}`);

  const objGen = catalogId('therapeutic_specific_objectives', 'GEN');
  const objSn = catalogId('therapeutic_specific_objectives', 'SN');
  const actSn = catalogId('therapeutic_activities', 'SN');
  psql(
    `INSERT INTO daily_report_answers (report_id, objective_id, activity_id, scale_code, option_code) VALUES
       ('${recentReportId}', '${objGen}', NULL, 'GEN', '1'),
       ('${recentReportId}', NULL, '${actSn}', 'SN', 'si'),
       ('${oldReportId}', '${objSn}', NULL, 'SN', 'no')`,
  );
  return { recentReportId, oldReportId };
}
