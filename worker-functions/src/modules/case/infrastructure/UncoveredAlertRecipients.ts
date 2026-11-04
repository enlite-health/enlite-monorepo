import type { Pool } from 'pg';
import { ENLITE_TENANT_ID } from '@modules/identity/permissions';
import { actorEffectiveCountries } from '@modules/identity/application/resolveCountryScope';

export interface AlertRecipient {
  uid: string;
  email: string | null;
  /** Países cujos pacientes este destinatário pode ver (P10): grupos dele ∩ país do paciente. */
  countries: string[];
}

export interface ResolvedAlertRecipients {
  recipients: AlertRecipient[];
  /** Tinha a célula mas nenhum país concedido: não recebe (e fica contado, nunca em silêncio). */
  skippedNoCountry: number;
}

/**
 * Quem recebe o alerta diário "Sin cubrir" (spec 069, P9/P10): staff ATIVO com a célula `patient_itinerary:update` (a que resolve:
 * aloca, encerra, escolhe o substituto) OU membro vivo do Acesso Master (`iam.is_master_member`). Quem não pode agir não recebe — fila
 * morta é buraco negro. Filtro em TS por `cells.includes(...)` (molde `TherapeuticContactReminderRecipients`), o que deixa o scanner do
 * catálogo enxergar o consumidor da célula. Nenhum grupo é criado nem alterado: quem recebe é decisão da operação, ao dar a célula.
 * Países por `actorEffectiveCountries` (a mesma consulta do escopo de país da request).
 */
export class UncoveredAlertRecipients {
  async resolve(db: Pool): Promise<ResolvedAlertRecipients> {
    const staff = await db.query<{ uid: string; email: string | null; cells: string[] | null; master: boolean | null }>(
      `SELECT u.firebase_uid AS uid, u.email,
              iam.effective_permissions(u.firebase_uid, $1::uuid) AS cells,
              iam.is_master_member(u.firebase_uid) AS master
         FROM users u
        WHERE u.status = 'ACTIVE' AND u.is_active IS NOT FALSE
        ORDER BY u.firebase_uid`,
      [ENLITE_TENANT_ID],
    );

    const recipients: AlertRecipient[] = [];
    let skippedNoCountry = 0;
    for (const s of staff.rows) {
      const canAct = (s.cells ?? []).includes('patient_itinerary:update') || s.master === true;
      if (!canAct) continue;
      const countries = await actorEffectiveCountries(db, s.uid);
      if (countries.length === 0) {
        skippedNoCountry++;
        continue;
      }
      recipients.push({ uid: s.uid, email: s.email, countries: [...countries] });
    }
    return { recipients, skippedNoCountry };
  }
}
