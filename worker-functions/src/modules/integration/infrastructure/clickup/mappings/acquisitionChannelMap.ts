import type { AcquisitionChannel } from '@modules/case';
import { recordUnmappedLabel } from '../helpers/unmappedLabelCounter';

/**
 * Translates ClickUp "Canales de Marketing" drop-down labels to canonical AcquisitionChannel.
 * Note: "Wahtsapp" is a typo in ClickUp (should be "WhatsApp") — preserved as-is.
 */
export const CLICKUP_TO_ACQUISITION_CHANNEL: Record<string, AcquisitionChannel> = {
  'Grupos de Wahtsapp':           'WHATSAPP_GROUPS',   // ClickUp: "Grupos de Wahtsapp" (sic — typo "Wahtsapp")
  'Facebook':                     'FACEBOOK',           // ClickUp: "Facebook"
  'Instagram':                    'INSTAGRAM',          // ClickUp: "Instagram"
  'Por un amigo/a':               'REFERRAL',           // ClickUp: "Por un amigo/a" (es)
  'Mail':                         'EMAIL',              // ClickUp: "Mail" (es)
  'Linkedin':                     'LINKEDIN',           // ClickUp: "Linkedin"
  'Centro Psicosocial Argentino': 'CPSA',               // ClickUp: "Centro Psicosocial Argentino" (es)
  'Universidad':                  'UNIVERSITY',         // ClickUp: "Universidad" (es)
  'Otra Institución':             'OTHER_INSTITUTION',  // ClickUp: "Otra Institución" (es)
};

export function mapClickUpAcquisitionChannel(label: string | null): AcquisitionChannel | null {
  if (!label) return null;
  const mapped = CLICKUP_TO_ACQUISITION_CHANNEL[label];
  if (mapped === undefined) {
    // Unknown ClickUp label — ops may have added or renamed an option. Log it so it can be mapped.
    // Task 1.5 — conta POR CAMPO (nunca por rótulo: seria a C1 do `lex` violada por acumulação).
    recordUnmappedLabel('Canales de Marketing');
    console.warn('[acquisitionChannelMap] Unknown ClickUp label:', { field: 'Canales de Marketing', label });
    return null;
  }
  return mapped;
}
