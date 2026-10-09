import pino from 'pino';
import type { Pool } from 'pg';
import { AdmissionMessagingService, type AdmissionLogger } from '../../application/AdmissionMessagingService';
import { AdmissionMessageContent } from '../AdmissionMessageContent';
import { InMemoryAdmissionReminderTasks } from './InMemoryAdmissionReminderTasks';
import { InMemoryAdmissionStore } from './InMemoryAdmissionStore';
import { RecordingAdmissionWhatsApp } from './RecordingAdmissionWhatsApp';

/**
 * Kit de teste de UNIDADE da mensageria de admissão: dublês das fronteiras + um banco falso que só sabe responder às
 * duas leituras do conteúdo (paciente e reunião). Nada daqui toca canal real. Dados sintéticos.
 */
export interface FakePatient {
  phone_whatsapp: string | null;
  first_name: string | null;
  has_consent: boolean | null;
  is_test: boolean | null;
}

export interface FakeAppointment {
  patient_id: string;
  country: string;
  host_display_name: string | null;
  slot_start: Date;
  meet_link: string | null;
  status: string;
}

export const KIT_PHONE = '+5491100000000';
export const KIT_FIRST_NAME = 'Carla';

export function fakeDb(opts: { patient: FakePatient | null; appointment?: FakeAppointment | null }): Pool {
  const query = async (sql: string): Promise<{ rows: unknown[] }> => {
    if (sql.includes('FROM patients')) return { rows: opts.patient ? [opts.patient] : [] };
    if (sql.includes('FROM admission_appointments')) return { rows: opts.appointment ? [opts.appointment] : [] };
    return { rows: [] };
  };
  return { query } as unknown as Pool;
}

/** Logger pino REAL escrevendo num buffer: a asserção é sobre a saída de verdade. */
export function capturingLogger(): { log: AdmissionLogger; output: () => string } {
  const chunks: string[] = [];
  const log = pino({ messageKey: 'message' }, { write: (s: string) => void chunks.push(s) });
  return { log: log as unknown as AdmissionLogger, output: () => chunks.join('') };
}

export function buildAdmissionKit(opts: {
  patient?: FakePatient | null;
  appointment?: FakeAppointment | null;
  now?: () => Date;
}) {
  const patient: FakePatient | null =
    opts.patient === undefined
      ? { phone_whatsapp: KIT_PHONE, first_name: KIT_FIRST_NAME, has_consent: true, is_test: false }
      : opts.patient;
  const db = fakeDb({ patient, appointment: opts.appointment });
  const store = new InMemoryAdmissionStore();
  const whatsapp = new RecordingAdmissionWhatsApp();
  const tasks = new InMemoryAdmissionReminderTasks();
  const content = new AdmissionMessageContent(db);
  const logs = capturingLogger();
  const messaging = new AdmissionMessagingService(store, store, whatsapp, content, logs.log, opts.now);
  return { db, store, whatsapp, tasks, content, messaging, logs };
}
