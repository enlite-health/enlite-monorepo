import { useTranslation } from 'react-i18next';
import type { LeadSchedulingProvider, LeadSchedulingProps } from './LeadSchedulingProvider';

/**
 * NativeSlotFinderProvider — 'native' impl of LeadSchedulingProvider (D8). STUB.
 *
 * Target behavior (NOT implemented yet): the backend uses domain-wide
 * delegation (enlite@enlite.health) to read the calendars of whoever owns the
 * admission interview, computes free slots for `leadId`'s case, renders them
 * as pickable options, and books the chosen event server-side — no third-party
 * iframe.
 *
 * TODO(native scheduling):
 *   1. Backend endpoint: GET /api/public/v1/leads/:id/slots (DWD enlite@,
 *      GoogleCalendarService.freeSlots over the admission owners' calendars).
 *   2. Backend endpoint: POST /api/public/v1/leads/:id/book (creates the event).
 *   3. Replace the body below with the slot list + confirm UI, keyed off leadId.
 * Ship by implementing the above and setting VITE_LEAD_SCHEDULING_MODE=native.
 */
function NativeSlotFinderComponent({ leadId }: LeadSchedulingProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <div
      data-testid="lead-scheduling-native-stub"
      className="rounded-[10px] border-2 border-dashed border-[#D9D9D9] bg-[#FAFAFA] px-4 py-6 text-center text-sm text-[#737373]"
      data-lead-id={leadId ?? ''}
    >
      {t('admission.scheduling.nativeNotImplemented')}
    </div>
  );
}

export const NativeSlotFinderProvider: LeadSchedulingProvider = {
  mode: 'native',
  Component: NativeSlotFinderComponent,
};
