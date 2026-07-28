import * as functions from 'firebase-functions';
import { PatientService } from './PatientService';
import {
  LEAD_SERVICE_TO_PROFESSION,
  type PublicLeadBody,
} from '../interfaces/validators/publicLeadSchema';

/**
 * CreateLeadUseCase — turns a public web-form submission into a native patient
 * lead (origin='web_form', status='SOLICITANTE'). Task 1 of the patient app.
 *
 * Contract (decisão D2/D4/D7):
 *   - Enlite is the source of truth: no ClickUp round-trip. Uses the native
 *     write path (createNativePatient), never upsertFromClickUp.
 *   - Minimal identity: a lead may have no name → firstName falls back to the
 *     safe placeholder 'Solicitante'.
 *   - requesterType='patient':     contact is the patient's own
 *     (phone_whatsapp + contact_email).
 *   - requesterType='responsible': contact lives on a primary
 *     patient_responsible (phone + email); the patient row carries no phone,
 *     since the number/email belong to the family member who filled the form.
 *
 * The contact-channel invariant of createNativePatient always holds here (we
 * always have both email and phone), so it should never throw; if it does, the
 * controller surfaces it as a clear 400.
 */

/** Placeholder used when the form omits the optional name. */
export const LEAD_PLACEHOLDER_FIRST_NAME = 'Solicitante';

export interface CreateLeadResult {
  id: string;
}

export class CreateLeadUseCase {
  constructor(private readonly patientService: PatientService) {}

  async execute(input: PublicLeadBody): Promise<CreateLeadResult> {
    const profession = LEAD_SERVICE_TO_PROFESSION[input.serviceType];
    const providedName = input.name?.trim();

    const isResponsible = input.requesterType === 'responsible';

    // For a responsible, the patient identity is unknown (the family member
    // filled the form); the optional name belongs to the responsible. For a
    // patient, the optional name is the patient's own.
    const patientFirstName = isResponsible
      ? LEAD_PLACEHOLDER_FIRST_NAME
      : providedName || LEAD_PLACEHOLDER_FIRST_NAME;

    const responsibles = isResponsible
      ? [
          {
            firstName: providedName || LEAD_PLACEHOLDER_FIRST_NAME,
            lastName: '',
            phone: input.phone,
            email: input.email,
            isPrimary: true,
            displayOrder: 1,
            source: 'web_form',
          },
        ]
      : undefined;

    const result = await this.patientService.createNativePatient(
      {
        firstName: patientFirstName,
        lastName: null,
        // Patient's own WhatsApp only when the requester IS the patient.
        phoneWhatsapp: isResponsible ? null : input.phone,
        serviceType: [profession],
        responsibles,
      },
      {
        origin: 'web_form',
        status: 'SOLICITANTE',
        // Patient's own contact email only when the requester IS the patient.
        contactEmail: isResponsible ? undefined : input.email,
      },
    );

    functions.logger.info('create_lead.completed', {
      patientId: result.id,
      requesterType: input.requesterType,
      serviceType: profession,
    });

    return { id: result.id };
  }
}
