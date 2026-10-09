import { CloudTasksClient } from '@shared/events/CloudTasksClient';
import {
  AdmissionRealAdapterInTestError,
  type AdmissionReminderTasksPort,
} from '../application/ports/AdmissionMessagingPorts';
import type { AdmissionCalendarPort } from '../application/ports/AdmissionCalendarPort';
import { admissionCalendarService } from './AdmissionCalendarService';
import type { AdmissionWhatsAppSender } from './admissionTemplates';
import { FakeAdmissionCalendar } from './doubles/FakeAdmissionCalendar';
import { InMemoryAdmissionReminderTasks } from './doubles/InMemoryAdmissionReminderTasks';
import { RecordingAdmissionWhatsApp } from './doubles/RecordingAdmissionWhatsApp';
import { RealAdmissionReminderTasks } from './RealAdmissionReminderTasks';

export interface AdmissionExternalsEnv {
  NODE_ENV?: string;
  ADMISSION_EXTERNALS?: string;
}

export interface AdmissionExternals {
  mode: 'real' | 'fake';
  reminderTasks: AdmissionReminderTasksPort;
  whatsapp: AdmissionWhatsAppSender;
  /**
   * Google Calendar. Dublê SÓ com `ADMISSION_EXTERNALS=fake` explícito (a stack e2e da 049); `NODE_ENV=test` sozinho
   * mantém o adapter real, que sem credencial falha alto — o e2e do roster depende disso ("agenda inacessível → 500").
   */
  calendar: AdmissionCalendarPort;
}

export interface AdmissionExternalsDeps {
  /** O canal real é construído no boot da API (Twilio); a fábrica só o pede quando o modo é `real`. */
  realWhatsApp: () => AdmissionWhatsAppSender;
  /** Para teste: substitui o adapter real do agendador (que lança em NODE_ENV=test). */
  realReminderTasks?: () => AdmissionReminderTasksPort;
}

/**
 * Fábrica das fronteiras externas da admissão (spec 049, regra transversal 2): Twilio e Cloud Tasks.
 *
 *  - `NODE_ENV=test` OU `ADMISSION_EXTERNALS=fake` → dublês (nada sai da máquina).
 *  - `NODE_ENV=production` com `fake` → LANÇA (dublê em produção seria mensagem que nunca sai, sem erro).
 *  - `NODE_ENV=test` com `real` → LANÇA (trava de código: teste nunca toca canal real).
 *  - demais casos → adapters reais, construídos só aqui, sob demanda.
 *
 * Roda no boot, mas em teste NUNCA instancia adapter real (a stack do CI roda NODE_ENV=test): lançar no boot derrubaria a stack.
 */
export function createAdmissionExternals(env: AdmissionExternalsEnv, deps: AdmissionExternalsDeps): AdmissionExternals {
  const isTest = env.NODE_ENV === 'test';
  const wantsFake = isTest || env.ADMISSION_EXTERNALS === 'fake';

  if (env.NODE_ENV === 'production' && env.ADMISSION_EXTERNALS === 'fake') {
    throw new Error('createAdmissionExternals: ADMISSION_EXTERNALS=fake é proibido em produção');
  }
  if (isTest && env.ADMISSION_EXTERNALS === 'real') {
    throw new AdmissionRealAdapterInTestError('createAdmissionExternals(real)');
  }

  if (wantsFake) {
    return {
      mode: 'fake',
      reminderTasks: new InMemoryAdmissionReminderTasks(),
      whatsapp: new RecordingAdmissionWhatsApp(),
      calendar: env.ADMISSION_EXTERNALS === 'fake' ? new FakeAdmissionCalendar() : admissionCalendarService,
    };
  }
  return {
    mode: 'real',
    reminderTasks: deps.realReminderTasks ? deps.realReminderTasks() : new RealAdmissionReminderTasks(new CloudTasksClient()),
    whatsapp: deps.realWhatsApp(),
    calendar: admissionCalendarService,
  };
}
