import type { ComponentType } from 'react';
import { ENV } from '@infrastructure/config/env';
import { GoogleAppointmentEmbed } from './GoogleAppointmentEmbed';
import { NativeSlotFinderProvider } from './NativeSlotFinderProvider';

/**
 * LeadSchedulingProvider (decisão D8) — abstraction over the scheduling step
 * shown after a lead is created. Two implementations behind one contract:
 *
 *   - 'embed'  (now):    GoogleAppointmentEmbed — a Google Appointment Schedule
 *                        iframe (URL configurable via VITE_ADMISSION_BOOKING_URL).
 *                        Zero backend.
 *   - 'native' (future): NativeSlotFinderProvider — backend reads the admission
 *                        owners' calendars via DWD (enlite@enlite.health),
 *                        computes free slots and books the event. STUB for now.
 *
 * Switching impls is a config flag (VITE_LEAD_SCHEDULING_MODE) — NOT a rewrite
 * of the page. To ship 'native': implement NativeSlotFinderProvider's Component
 * against the future backend endpoint and set the env var to 'native'.
 */

export type LeadSchedulingMode = 'embed' | 'native';

/** Props passed to whichever scheduling UI is rendered. */
export interface LeadSchedulingProps {
  /**
   * The created lead's patient id. Unused by the embed impl; the future native
   * impl scopes the proposed slots / booking to this case.
   */
  leadId?: string;
}

export interface LeadSchedulingProvider {
  readonly mode: LeadSchedulingMode;
  /** The React component that renders the scheduling UI. */
  readonly Component: ComponentType<LeadSchedulingProps>;
}

const PROVIDERS: Record<LeadSchedulingMode, LeadSchedulingProvider> = {
  embed: GoogleAppointmentEmbed,
  native: NativeSlotFinderProvider,
};

/** Resolves the active provider from VITE_LEAD_SCHEDULING_MODE (default 'embed'). */
export function resolveLeadSchedulingProvider(): LeadSchedulingProvider {
  const mode = ENV.LEAD_SCHEDULING_MODE;
  return PROVIDERS[mode] ?? PROVIDERS.embed;
}
