import { useTranslation } from 'react-i18next';
import { ENV } from '@infrastructure/config/env';
import type { LeadSchedulingProvider, LeadSchedulingProps } from './LeadSchedulingProvider';

/** Fallback placeholder used when VITE_ADMISSION_BOOKING_URL is not configured. */
const PLACEHOLDER_BOOKING_URL = 'https://calendar.google.com/calendar/appointments/PLACEHOLDER';

/**
 * GoogleAppointmentEmbed — 'embed' impl of LeadSchedulingProvider (D8).
 * Renders the Google Appointment Schedule for the admission interview as an
 * iframe. URL comes from VITE_ADMISSION_BOOKING_URL; when unset it falls back
 * to a visible placeholder + a configure-URL warning so the flow is testable
 * before ops provides the real link.
 */
function GoogleAppointmentEmbedComponent(_props: LeadSchedulingProps): JSX.Element {
  const { t } = useTranslation();
  const configuredUrl = ENV.ADMISSION_BOOKING_URL;
  const bookingUrl = configuredUrl || PLACEHOLDER_BOOKING_URL;
  const isPlaceholder = !configuredUrl;

  return (
    <div className="flex flex-col gap-3">
      {isPlaceholder && (
        <div
          data-testid="lead-scheduling-warning"
          className="rounded-[10px] border-2 border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800"
        >
          {t('admission.scheduling.configureWarning')}
        </div>
      )}
      <div className="w-full overflow-hidden rounded-[10px] border-2 border-[#D9D9D9]">
        <iframe
          data-testid="lead-scheduling-iframe"
          title={t('admission.scheduling.iframeTitle')}
          src={bookingUrl}
          className="h-[600px] w-full border-0"
          loading="lazy"
        />
      </div>
    </div>
  );
}

export const GoogleAppointmentEmbed: LeadSchedulingProvider = {
  mode: 'embed',
  Component: GoogleAppointmentEmbedComponent,
};
