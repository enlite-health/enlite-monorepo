import * as functions from 'firebase-functions';
import { PatientService } from './PatientService';
import {
  LEAD_SERVICE_TO_PROFESSION,
  type PublicLeadBody,
} from '../interfaces/validators/publicLeadSchema';
import { splitFullName } from '../domain/fullName';

/**
 * CreateLeadUseCase — turns a public web-form submission into a native patient
 * lead (origin='web_form', status='SOLICITANTE'). Task 1 of the patient app.
 *
 * Contract (decisão D2/D4/D7):
 *   - Enlite is the source of truth: no ClickUp round-trip. Uses the native
 *     write path (createNativePatient), never upsertFromClickUp.
 *   - Identidade (D249, 02/09): o formulário colhe o nome completo em UM campo
 *     e ele é OBRIGATÓRIO. A quem o nome pertence depende de quem preencheu.
 *   - requesterType='patient':     o nome, o telefone e o e-mail são do PACIENTE.
 *   - requesterType='responsible': tudo isso é do RESPONSÁVEL — vai para um
 *     `patient_responsibles` marcado `is_primary`, e o paciente nasce **sem
 *     nome** (`first_name` NULL, que a coluna aceita). Não se inventa nome de
 *     paciente a partir do nome de quem ligou por ele; a tela mostra "—" até
 *     alguém preencher a ficha.
 *
 * The contact-channel invariant of createNativePatient always holds here (we
 * always have both email and phone), so it should never throw; if it does, the
 * controller surfaces it as a clear 400.
 */

/**
 * Placeholder da era em que o formulário não colhia nome (até 02/09).
 * Nenhum lead NOVO nasce com ele — mas as 13 fichas que já existem em produção
 * carregam, e a listagem ainda precisa reconhecê-lo para desempatá-las pelo
 * e-mail mascarado (D228/D231). Re-exportado para não quebrar quem importa daqui.
 */
export { LEAD_PLACEHOLDER_FIRST_NAME } from '../domain/LeadContact';

export interface CreateLeadResult {
  id: string;
}

export class CreateLeadUseCase {
  constructor(private readonly patientService: PatientService) {}

  async execute(input: PublicLeadBody): Promise<CreateLeadResult> {
    const profession = LEAD_SERVICE_TO_PROFESSION[input.serviceType];
    const { firstName, lastName } = splitFullName(input.name);

    const isResponsible = input.requesterType === 'responsible';

    // "Para otra persona": o nome é de quem preencheu, não do paciente. O
    // paciente fica SEM nome — `null`, não placeholder: a tela precisa distinguir
    // "ainda não sabemos" de "chama-se Solicitante".
    const responsibles = isResponsible
      ? [
          {
            firstName,
            // `patient_responsibles.last_name` é NOT NULL: nome de um termo só
            // grava '', nunca null.
            lastName,
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
        firstName: isResponsible ? null : firstName,
        lastName: isResponsible ? null : lastName || null,
        // Patient's own WhatsApp only when the requester IS the patient.
        phoneWhatsapp: isResponsible ? null : input.phone,
        serviceType: [profession],
        // Country drives admission scheduling (timezone/holidays/calendar).
        country: input.country,
        // Explicit consent to be contacted (Ley 25.326 / LGPD) — guaranteed
        // true by publicLeadSchema (z.literal), enforced server-side.
        hasConsent: input.consent,
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
