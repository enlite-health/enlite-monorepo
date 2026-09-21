export interface Worker {
  id: string;
  authUid: string;
  email: string;
  phone?: string;
  whatsappPhone?: string;
  lgpdConsentAt?: Date;
  
  firstName?: string;
  lastName?: string;
  sex?: string;
  gender?: string;
  birthDate?: Date;
  /**
   * Sinal explícito de estado da data de nascimento, calculado no repositório
   * sobre o valor DECIFRADO (`isValidIsoBirthDate`). Existe porque `birthDate`
   * sozinho é AMBÍGUO: uma string inválida vira `Invalid Date`, que o
   * `JSON.stringify` serializa como `null` — o mesmo `null` de "nunca
   * cadastrou". Sem este campo o front não consegue distinguir os dois casos
   * (spec 025, decisão do Gabriel 21/09, opção A). O valor inválido em si
   * NUNCA é devolvido — só o veredito.
   *
   * `ok` = ISO válida · `missing` = nunca gravou · `invalid` = gravou algo que
   * não é uma data ISO real (ex.: dado herdado do Defeito 1, quando o PUT não
   * validava em runtime).
   */
  birthDateStatus?: 'ok' | 'missing' | 'invalid';
  documentType?: string;
  documentNumber?: string;
  profilePhotoUrl?: string;
  
  languages?: string[];
  profession?: string;
  knowledgeLevel?: string;
  titleCertificate?: string;
  experienceTypes?: string[];
  yearsExperience?: string;
  preferredTypes?: string[];
  preferredAgeRange?: string[];
  
  // Extended demographic fields (collected in documents screen)
  sexualOrientation?: string;
  race?: string;
  religion?: string;
  weightKg?: number;
  heightCm?: number;
  hobbies?: string[];
  diagnosticPreferences?: string[];
  linkedinUrl?: string;
  
  currentStep: number;
  status: WorkerStatus;
  registrationCompleted: boolean;
  country: string;
  timezone: string;
  
  termsAcceptedAt?: Date;
  privacyAcceptedAt?: Date;
  
  createdAt: Date;
  updatedAt: Date;
}

export type WorkerStatus = 'REGISTERED' | 'INCOMPLETE_REGISTER' | 'DISABLED';

export interface CreateWorkerDTO {
  authUid: string;
  email: string;
  /** WhatsApp phone number (optional at registration, can be filled in Step 1) */
  phone?: string;
  /** Separate WhatsApp contact number provided at registration */
  whatsappPhone?: string;
  /** Whether user accepted LGPD consent at registration */
  lgpdOptIn?: boolean;
  country?: string;
  timezone?: string;
}

export interface UpdateWorkerStepDTO {
  workerId: string;
  step: number;
  status?: WorkerStatus;
}

export interface SaveQuizResponseDTO {
  workerId: string;
  responses: Array<{
    sectionId: string;
    questionId: string;
    answerId: string;
  }>;
}

export interface SavePersonalInfoDTO {
  workerId: string;
  firstName: string;
  lastName: string;
  sex: string;
  gender: string;
  birthDate: string;
  documentType: string;
  documentNumber: string;
  phone: string;
  profilePhotoUrl?: string;
  languages: string[];
  profession: string;
  knowledgeLevel: string;
  titleCertificate: string;
  experienceTypes: string[];
  yearsExperience: string;
  preferredTypes: string[];
  preferredAgeRange: string[];
  termsAccepted: boolean;
  privacyAccepted: boolean;
}

export interface SaveServiceAreaDTO {
  workerId: string;
  address: string;
  addressComplement?: string;
  serviceRadiusKm: number;
  lat: number;
  lng: number;
  city?: string;
  postalCode?: string;
  neighborhood?: string;
}

export interface SaveAvailabilityDTO {
  workerId: string;
  availability: Array<{
    dayOfWeek: number;
    startTime: string;
    endTime: string;
    crossesMidnight?: boolean;
  }>;
}
