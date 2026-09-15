/**
 * RegisterImageConsentUseCase — POST /patients/:id/image-consents.
 *
 * Decisão 14/09 (D335): registrar é OPCIONAL, `documentId` é opcional. As únicas travas que
 * restam são as do BANCO (nunca do use case): `pic_rep_coerente` (REPRESENTATIVE exige
 * `responsibleId`) e `uq_patient_image_consents_vigente` (1 vigente por paciente) — mapeadas para
 * HTTP aqui, não reimplementadas em JS.
 */
import {
  PatientImageConsentRepository,
  isVigenteUniqueViolation,
  isForeignKeyViolation,
  isCheckViolation,
  type RegisterImageConsentInput,
} from '../infrastructure/PatientImageConsentRepository';
import { inPatientTransaction } from './patientTransaction';

export class ImageConsentAlreadyActiveError extends Error {
  readonly code = 'IMAGE_CONSENT_ALREADY_ACTIVE';
  constructor() {
    super('Já existe um consentimento de imagem vigente para este paciente');
    this.name = 'ImageConsentAlreadyActiveError';
  }
}

export class ImageConsentReferenceNotFoundError extends Error {
  readonly code = 'IMAGE_CONSENT_REFERENCE_NOT_FOUND';
  constructor() {
    super('responsibleId ou documentId não pertence a este paciente');
    this.name = 'ImageConsentReferenceNotFoundError';
  }
}

export class RepresentativeRequiredError extends Error {
  readonly code = 'REPRESENTATIVE_REQUIRED';
  constructor() {
    super('consenterKind=REPRESENTATIVE exige responsibleId');
    this.name = 'RepresentativeRequiredError';
  }
}

export class RegisterImageConsentUseCase {
  constructor(private readonly repo: PatientImageConsentRepository = new PatientImageConsentRepository()) {}

  async execute(patientId: string, input: RegisterImageConsentInput, actorUid: string): Promise<{ id: string }> {
    try {
      return await inPatientTransaction((client) => this.repo.register(patientId, input, actorUid, client));
    } catch (err) {
      if (isVigenteUniqueViolation(err)) throw new ImageConsentAlreadyActiveError();
      if (isCheckViolation(err)) throw new RepresentativeRequiredError();
      if (isForeignKeyViolation(err)) throw new ImageConsentReferenceNotFoundError();
      throw err;
    }
  }
}
