import { PatientService, type CreateNativePatientInput } from './PatientService';
import type { DocumentType } from '../domain/enums/DocumentType';
import type { Profession } from '../../worker/domain/enums/Profession';

/**
 * Input for manual admin creation of a native patient (Fase 1 Task 2).
 * Mirrors the validated request body (createPatientSchema). Only firstName is
 * required; the admission team completes the rest later.
 */
export interface CreatePatientInput {
  firstName: string;
  lastName?: string;
  phoneWhatsapp?: string;
  contactEmail?: string;
  documentType?: DocumentType;
  documentNumber?: string;
  healthInsuranceName?: string;
  healthInsuranceMemberId?: string;
  serviceType?: Profession[];
}

/**
 * Thrown when the contact-channel invariant fails (no patient phone, no contact
 * email, no primary responsible channel). The controller maps this to a 400 —
 * it is a client input problem, not a server error.
 */
export class PatientContactValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PatientContactValidationError';
  }
}

function isContactValidationError(err: unknown): boolean {
  return err instanceof Error && err.message.startsWith('Validação de contato');
}

/**
 * CreatePatientUseCase — creates a patient manually from the admin panel.
 *
 * Health-insurance path: the operadora emails the patient over, the admission
 * team enters them by hand. Born native inside Enlite (origin='admin_manual'),
 * placed directly in status ADMISSION so the team can work the admission (the
 * kanban of Fase 2 will let them move it). Delegates the write + the
 * contact-channel invariant to PatientService.createNativePatient.
 *
 * Used by: AdminPatientsController.createPatient
 */
export class CreatePatientUseCase {
  private readonly patientService: PatientService;

  constructor(patientService?: PatientService) {
    this.patientService = patientService ?? new PatientService();
  }

  async execute(input: CreatePatientInput): Promise<{ id: string }> {
    // contactEmail is passed via opts (KMS-encrypted into contact_email_encrypted),
    // NOT inside the native input. Everything else maps straight through.
    const nativeInput: CreateNativePatientInput = {
      firstName: input.firstName,
      lastName: input.lastName,
      phoneWhatsapp: input.phoneWhatsapp ?? null,
      documentType: input.documentType ?? null,
      documentNumber: input.documentNumber ?? null,
      healthInsuranceName: input.healthInsuranceName ?? null,
      healthInsuranceMemberId: input.healthInsuranceMemberId ?? null,
      serviceType: input.serviceType ?? null,
    };

    try {
      const { id } = await this.patientService.createNativePatient(nativeInput, {
        origin: 'admin_manual',
        status: 'ADMISSION',
        contactEmail: input.contactEmail,
      });
      return { id };
    } catch (err) {
      if (isContactValidationError(err)) {
        throw new PatientContactValidationError((err as Error).message);
      }
      throw err;
    }
  }
}
