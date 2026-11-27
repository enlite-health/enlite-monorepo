import type { Pool } from 'pg';
import { ENLITE_TENANT_ID } from '@modules/identity/permissions';
import { actorEffectiveCountries } from '@modules/identity/application/resolveCountryScope';
import type { AlertRecipient, AlertRecipientResolver } from '../application/ports/CoordinationAlertPorts';

/**
 * Quem recebe o alerta de presença (emenda 077 §5.4 [CTO 4]): staff ATIVO com a célula `presence_alert:receive` (só deste alerta) OU membro vivo
 * do Acesso Master (`iam.is_master_member`) — assim nunca há zero destinatários por falta de grupo. NÃO usa `patient_itinerary:update` (é do
 * recrutamento, "Sin cubrir"). Filtro em TS por `cells.includes(...)` (molde `UncoveredAlertRecipients`), para o scanner do catálogo enxergar o
 * consumidor da célula. Nenhum grupo é criado nem movido: dar a célula à Coordinación Clínica é ato da operação. Países por `actorEffectiveCountries`.
 */
export class PresenceAlertRecipients implements AlertRecipientResolver {
  constructor(private readonly db: Pool) {}

  async resolve(): Promise<AlertRecipient[]> {
    const staff = await this.db.query<{ uid: string; email: string | null; cells: string[] | null; master: boolean | null }>(
      `SELECT u.firebase_uid AS uid, u.email,
              iam.effective_permissions(u.firebase_uid, $1::uuid) AS cells,
              iam.is_master_member(u.firebase_uid) AS master
         FROM users u
        WHERE u.status = 'ACTIVE' AND u.is_active IS NOT FALSE
        ORDER BY u.firebase_uid`,
      [ENLITE_TENANT_ID],
    );
    const out: AlertRecipient[] = [];
    for (const s of staff.rows) {
      const cells = s.cells ?? [];
      const canReceive = cells.includes('presence_alert:receive') || s.master === true; // `cells.includes('x:y')` literal: o scanner do catálogo reconhece este formato
      if (!canReceive) continue;
      const countries = await actorEffectiveCountries(this.db, s.uid);
      if (countries.length === 0) continue;
      out.push({ uid: s.uid, email: s.email, countries: [...countries] });
    }
    return out;
  }
}
