/**
 * workerVacancyDeliveryStatusHelper.test.ts
 *
 * Cenários:
 *  1. WJA não existe (worker_id, job_posting_id) → { kind: 'not_found' }
 *  2. WJA existe + sem linha em messaging_outbox → { kind: 'ok', wjaStage, outbox: null }
 *  3. WJA existe + outbox sent/delivered (mais recente) → wjaStage + outbox mapeado
 */

import { getWorkerVacancyDeliveryStatus } from '../workerVacancyDeliveryStatusHelper';

function makeDb(queryImpl: (sql: string, params: unknown[]) => { rows: object[] }): { query: jest.Mock } {
  return { query: jest.fn().mockImplementation((sql: string, params: unknown[]) => Promise.resolve(queryImpl(sql, params))) };
}

const WORKER_ID = 'aaaa0000-0000-0000-0000-111111111111';
const VACANCY_ID = 'bbbb0000-0000-0000-0000-222222222222';

describe('getWorkerVacancyDeliveryStatus', () => {
  it('WJA não existe → kind=not_found (nunca consulta outbox)', async () => {
    const outboxQuery = jest.fn();
    const db = makeDb(sql => {
      if (sql.includes('worker_job_applications')) return { rows: [] };
      outboxQuery();
      return { rows: [] };
    });

    const result = await getWorkerVacancyDeliveryStatus(db as never, WORKER_ID, VACANCY_ID);

    expect(result).toEqual({ kind: 'not_found' });
    expect(outboxQuery).not.toHaveBeenCalled();
  });

  it('WJA existe, sem envio no outbox → wjaStage preenchido, outbox=null', async () => {
    const db = makeDb(sql => {
      if (sql.includes('worker_job_applications')) return { rows: [{ application_funnel_stage: 'REGISTERED' }] };
      return { rows: [] };
    });

    const result = await getWorkerVacancyDeliveryStatus(db as never, WORKER_ID, VACANCY_ID);

    expect(result).toEqual({ kind: 'ok', wjaStage: 'REGISTERED', outbox: null });
  });

  it('WJA=INVITED + outbox sent/delivered (mais recente) → mapeia colunas reais', async () => {
    const db = makeDb(sql => {
      if (sql.includes('worker_job_applications')) return { rows: [{ application_funnel_stage: 'INVITED' }] };
      if (sql.includes('messaging_outbox')) {
        return {
          rows: [
            {
              status: 'sent',
              delivery_status: 'delivered',
              twilio_sid: 'MMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
              channel: 'twilio',
              template_slug: 'vacancy_invite',
            },
          ],
        };
      }
      return { rows: [] };
    });

    const result = await getWorkerVacancyDeliveryStatus(db as never, WORKER_ID, VACANCY_ID);

    expect(result).toEqual({
      kind: 'ok',
      wjaStage: 'INVITED',
      outbox: {
        status: 'sent',
        deliveryStatus: 'delivered',
        twilioSid: 'MMxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        channel: 'twilio',
        templateSlug: 'vacancy_invite',
      },
    });
  });
});
