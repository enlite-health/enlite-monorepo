import { CloudTasksClient } from '@shared/events/CloudTasksClient';
import {
  AdmissionRealAdapterInTestError,
  type AdmissionReminderTasksPort,
} from '../application/ports/AdmissionMessagingPorts';
import type { AdmissionCalendarPort } from '../application/ports/AdmissionCalendarPort';
import { admissionCalendarService } from './AdmissionCalendarService';
import type { AdmissionWhatsAppSender } from './admissionTemplates';
import { FakeAdmissionCalendar } from './doubles/FakeAdmissionCalendar';
import { UnavailableAdmissionCalendar } from './doubles/UnavailableAdmissionCalendar';
import { InMemoryAdmissionReminderTasks } from './doubles/InMemoryAdmissionReminderTasks';
import { RecordingAdmissionWhatsApp } from './doubles/RecordingAdmissionWhatsApp';
import { RealAdmissionReminderTasks } from './RealAdmissionReminderTasks';
import type { TactiqMcpPort, TactiqOAuthPort } from '../application/ports/TactiqPorts';
import { FakeTactiqMcp, FakeTactiqOAuth } from './doubles/FakeTactiq';
import { TactiqMcpClient } from './tactiq/TactiqMcpClient';
import { TactiqOAuthClient } from './tactiq/TactiqOAuthClient';
import type { ChromeReportPort } from '../application/ports/ChromeReportPort';
import { FakeChromeReport } from './doubles/FakeChromeReport';
import { GoogleChromeManagementClient } from './GoogleChromeManagementClient';
import type { MeetConferencePort } from '../application/ports/MeetConferencePort';
import { FakeMeetConference } from './doubles/FakeMeetConference';
import { GoogleMeetConferenceClient } from './GoogleMeetConferenceClient';
import type { AdmissionSummaryPort, RehearsalVaultPort, TranscriptVaultPort } from '../application/ports/AdmissionImportPorts';
import { InMemoryTranscriptVault } from './doubles/InMemoryTranscriptVault';
import { FakeAdmissionSummaryGenerator } from './doubles/FakeAdmissionSummaryGenerator';
import { ENQUADRE_VAULT_BUCKET_ENV, GcsTranscriptVault, REHEARSAL_BUCKET_ENV } from './GcsTranscriptVault';
import { VertexAdmissionSummaryGenerator } from './VertexAdmissionSummaryGenerator';
import { ENQUADRE_SUMMARY_PROFILE } from './enquadreSummaryProfile';
import { assertEnquadreSummaryShape } from '../application/enquadreSummaryGate';
import { validEnquadreSummaryJson } from './doubles/enquadreSummaryFixtures';

export interface AdmissionExternalsEnv {
  NODE_ENV?: string;
  ADMISSION_EXTERNALS?: string;
  /** Marcador explícito de stage (`stage`); a prd não o define. */
  ENLITE_DEPLOY_ENV?: string;
  /** Só em modo dublê: `unavailable` troca o Calendar dublê por um que FALHA de propósito (stack do e2e, docker-compose.test.yml). */
  ADMISSION_CALENDAR_DOUBLE?: string;
}

export interface AdmissionExternals {
  mode: 'real' | 'fake';
  reminderTasks: AdmissionReminderTasksPort;
  whatsapp: AdmissionWhatsAppSender;
  /**
   * Google Calendar. Em teste é SEMPRE dublê (R-17, spec 050): `FakeAdmissionCalendar` (sempre livre), ou
   * `UnavailableAdmissionCalendar` (falha de propósito) com `ADMISSION_CALENDAR_DOUBLE=unavailable` — o e2e do roster
   * depende de "agenda inacessível → 500". `ADMISSION_EXTERNALS=fake` explícito sempre dá o `Fake` (a stack e2e da 049).
   */
  calendar: AdmissionCalendarPort;
  /** Tactiq (spec 049 F4): OAuth e MCP. Dublês em `fake`; os adapters reais LANÇAM no construtor com NODE_ENV=test. */
  tactiq: { oauth: TactiqOAuthPort; mcp: TactiqMcpPort };
  /** Meet REST API (spec 049 F5): fim real da call. Dublê em `fake`; o adapter real LANÇA no construtor com NODE_ENV=test. */
  meet: MeetConferencePort;
  /** Relatório do Chrome (spec 050 F15). Dublê em `fake`; o real NÃO tem rede até a F18 (rejeita `not_released`) e LANÇA no construtor com NODE_ENV=test. */
  chrome: ChromeReportPort;
  /** Cofre da transcrição (spec 049 F6): só cria. Em `fake`, em memória com a mesma semântica; o real LANÇA no construtor com NODE_ENV=test. */
  vault: TranscriptVaultPort;
  /** Bucket de ENSAIO (spec 050 R-29): a mesma porta, outro destino (`ADMISSION_REHEARSAL_BUCKET`). Escolhido pelo `realm`, nunca por `if` no serviço. */
  rehearsalVault: RehearsalVaultPort;
  /** Resumo da admissão via Vertex (F6). Dublê em `fake`; o real LANÇA no construtor com NODE_ENV=test. */
  summary: AdmissionSummaryPort;
  /**
   * Cofre da transcrição do ENQUADRE (spec 052, D506): a mesma `GcsTranscriptVault`, outro bucket (`ENQUADRE_TRANSCRIPT_VAULT_BUCKET`).
   * Se a env for a do cofre da admissão, a instância se declara não configurada (`not_configured`): nunca grava no cofre errado.
   */
  enquadreVault: TranscriptVaultPort;
  /** Resumo do ENQUADRE: o MESMO gerador, com o perfil do enquadre (prompt em arquivo, convocados, gate próprio). Dublê em `fake`. */
  enquadreSummary: AdmissionSummaryPort;
}

export interface AdmissionExternalsDeps {
  /** O canal real é construído no boot da API (Twilio); a fábrica só o pede quando o modo é `real`. */
  realWhatsApp: () => AdmissionWhatsAppSender;
  /** Para teste: substitui o adapter real do agendador (que lança em NODE_ENV=test). */
  realReminderTasks?: () => AdmissionReminderTasksPort;
}

function testCalendar(env: AdmissionExternalsEnv): AdmissionCalendarPort {
  if (env.ADMISSION_EXTERNALS !== 'fake' && env.ADMISSION_CALENDAR_DOUBLE === 'unavailable') return new UnavailableAdmissionCalendar();
  return new FakeAdmissionCalendar();
}

/**
 * Fábrica das fronteiras externas da admissão (spec 049, regra transversal 2): Twilio, Cloud Tasks, Calendar, Tactiq, Meet, cofre e Vertex.
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

  // A stage roda NODE_ENV=production; o dublê só é aceito com o marcador explícito de stage (teste nunca toca canal real).
  // Sem o marcador (prd), `fake` em production continua proibido.
  if (env.NODE_ENV === 'production' && env.ADMISSION_EXTERNALS === 'fake' && env.ENLITE_DEPLOY_ENV !== 'stage') {
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
      calendar: testCalendar(env),
      tactiq: { oauth: new FakeTactiqOAuth(), mcp: new FakeTactiqMcp() },
      meet: new FakeMeetConference(),
      chrome: new FakeChromeReport(),
      vault: new InMemoryTranscriptVault(),
      rehearsalVault: new InMemoryTranscriptVault(),
      summary: new FakeAdmissionSummaryGenerator(),
      enquadreVault: new InMemoryTranscriptVault(),
      enquadreSummary: new FakeAdmissionSummaryGenerator({ structured: () => validEnquadreSummaryJson(), assertShape: assertEnquadreSummaryShape }),
    };
  }
  return {
    mode: 'real',
    reminderTasks: deps.realReminderTasks ? deps.realReminderTasks() : new RealAdmissionReminderTasks(new CloudTasksClient()),
    whatsapp: deps.realWhatsApp(),
    calendar: admissionCalendarService,
    tactiq: { oauth: new TactiqOAuthClient(env as NodeJS.ProcessEnv), mcp: new TactiqMcpClient(env as NodeJS.ProcessEnv) },
    meet: new GoogleMeetConferenceClient(env as NodeJS.ProcessEnv),
    chrome: new GoogleChromeManagementClient(env as NodeJS.ProcessEnv),
    vault: new GcsTranscriptVault({ env: env as NodeJS.ProcessEnv }),
    rehearsalVault: new GcsTranscriptVault({ env: env as NodeJS.ProcessEnv, bucketEnv: REHEARSAL_BUCKET_ENV }),
    summary: new VertexAdmissionSummaryGenerator(env as NodeJS.ProcessEnv),
    enquadreVault: new GcsTranscriptVault({ env: env as NodeJS.ProcessEnv, bucketEnv: ENQUADRE_VAULT_BUCKET_ENV }),
    enquadreSummary: new VertexAdmissionSummaryGenerator(env as NodeJS.ProcessEnv, { profile: ENQUADRE_SUMMARY_PROFILE }),
  };
}
