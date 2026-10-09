import type { AdmissionCalendarService } from '../../infrastructure/AdmissionCalendarService';

/**
 * O que o agendamento de admissão usa do Google Calendar. `AdmissionCalendarService` (real) satisfaz por estrutura;
 * o dublê `FakeAdmissionCalendar` entra pela fábrica `createAdmissionExternals` (`ADMISSION_EXTERNALS=fake`).
 */
export type AdmissionCalendarPort = Pick<
  AdmissionCalendarService,
  'getCalendarTimezone' | 'getBusyIntervals' | 'getFreeBusyByCalendar' | 'createEventWithMeet' | 'deleteEvent'
>;
