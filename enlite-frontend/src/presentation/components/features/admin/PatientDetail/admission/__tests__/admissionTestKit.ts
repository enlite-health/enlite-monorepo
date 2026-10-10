/**
 * Kit dos testes da aba Admissão (spec 049, F7): reaproveita o `t` real em es (o texto es-AR é o contrato) e o
 * `setCells` da aba Documentos; reuniões sintéticas (e-mails `@example.test`, nenhum dado real).
 */
import type {
  AdmissionAppointment,
  AdmissionHost,
  MessageSealView,
} from '@infrastructure/http/AdminAdmissionApiService';

export { tEs, i18nMock, setCells } from '../../documents/__tests__/documentsTestKit';

const none: MessageSealView = { seal: 'none', attempt: null, canResend: false };

/** Relógio fixo dos testes: 12/10/2026 15:00 UTC. */
export const NOW = new Date('2026-10-12T15:00:00.000Z');

export function appt(overrides: Partial<AdmissionAppointment> = {}): AdmissionAppointment {
  return {
    id: 'a1',
    admissionCode: 'ADM-0001',
    createdVia: 'panel',
    country: 'AR',
    hostEmail: 'ana@example.test',
    slotStart: '2026-10-13T15:00:00.000Z',
    slotEnd: '2026-10-13T16:00:00.000Z',
    status: 'booked',
    meetLink: 'https://meet.google.com/abc-defg-hij',
    seals: {
      confirmation: { seal: 'delivered', attempt: 0, canResend: false },
      reminder: { seal: 'scheduled', attempt: null, canResend: false },
      import: null,
      document: null,
    },
    ...overrides,
  };
}

export function sealed(over: Partial<AdmissionAppointment['seals']>): AdmissionAppointment['seals'] {
  return { confirmation: none, reminder: none, import: null, document: null, ...over };
}

export function host(overrides: Partial<AdmissionHost> = {}): AdmissionHost {
  return { email: 'ana@example.test', displayName: 'Ana Prueba', linked: true, linkState: 'linked', ...overrides };
}
