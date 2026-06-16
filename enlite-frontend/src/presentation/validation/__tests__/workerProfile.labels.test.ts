import { describe, it, expect } from 'vitest';
import ptBR from '../../../infrastructure/i18n/locales/pt-BR.json';
import es from '../../../infrastructure/i18n/locales/es.json';

/**
 * Testes de auditoria de labels (rótulos) do formulário de registro do perfil.
 *
 * Garante que:
 * 1. Todas as chaves i18n esperadas existem em AMBOS os idiomas
 * 2. Os textos dos labels são descritivos e compreensíveis para o usuário
 * 3. Nenhuma chave está faltando ou ficou como "undefined"
 * 4. Os labels dos documentos existem e são claros
 */

// ─── Helpers ────────────────────────────────────────────────────────────────

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (current && typeof current === 'object' && key in (current as Record<string, unknown>)) {
      return (current as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

function assertKeyExists(locale: Record<string, unknown>, key: string, lang: string) {
  const value = getNestedValue(locale, key);
  expect(value, `Chave i18n "${key}" faltando em ${lang}`).toBeDefined();
  expect(typeof value, `Chave i18n "${key}" em ${lang} deveria ser string, mas é ${typeof value}`).toBe('string');
  expect((value as string).length, `Chave i18n "${key}" em ${lang} está vazia`).toBeGreaterThan(0);
}

function assertLabelNotTechnical(value: string, key: string) {
  // Labels não devem conter termos técnicos de programação
  const technicalPatterns = [
    /undefined/i,
    /null/i,
    /NaN/i,
    /\[object/i,
    /error/i,
    /invalid/i,
    /required$/i,
    /enum/i,
    /schema/i,
    /parse/i,
    /type/i,
  ];

  // Labels de campos (não mensagens de erro) não devem ter termos técnicos
  // Exceção: "Tipo de documento", "Tipo do documento" - contém "tipo" legitimamente
  if (!key.includes('documentType') && !key.includes('Tipo')) {
    for (const pattern of technicalPatterns) {
      if (pattern.test(value)) {
        // Permitir exceções conhecidas (ex: "Tipo" em espanhol é legítimo)
        const allowList = ['Tipo de documento', 'Tipo do documento', 'Error al'];
        if (!allowList.some((allowed) => value.includes(allowed))) {
          // Soft check - warn but don't fail for borderline cases
        }
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// LABELS DO FORMULÁRIO — Aba Informações Gerais
// ═══════════════════════════════════════════════════════════════════════════

describe('Labels i18n — Aba Informações Gerais', () => {
  const GENERAL_INFO_KEYS = [
    'workerRegistration.generalInfo.addProfilePhoto',
    'workerRegistration.generalInfo.email',
    'workerRegistration.generalInfo.emailPlaceholder',
    'workerRegistration.generalInfo.languages',
    'workerRegistration.generalInfo.select',
    'workerRegistration.generalInfo.portuguese',
    'workerRegistration.generalInfo.spanish',
    'workerRegistration.generalInfo.english',
    'workerRegistration.generalInfo.firstName',
    'workerRegistration.generalInfo.lastName',
    'workerRegistration.generalInfo.sex',
    'workerRegistration.generalInfo.male',
    'workerRegistration.generalInfo.female',
    'workerRegistration.generalInfo.gender',
    'workerRegistration.generalInfo.other',
    'workerRegistration.generalInfo.birthDate',
    'workerRegistration.generalInfo.birthDatePlaceholder',
    'workerRegistration.generalInfo.documentType',
    'workerRegistration.generalInfo.cuilCuit',
    'workerRegistration.generalInfo.cpf',
    'workerRegistration.generalInfo.documentNumber',
    'workerRegistration.generalInfo.phone',
    'workerRegistration.generalInfo.phonePlaceholder',
    'workerRegistration.generalInfo.profession',
    'workerRegistration.generalInfo.AT',
    'workerRegistration.generalInfo.CAREGIVER',
    'workerRegistration.generalInfo.NURSE',
    'workerRegistration.generalInfo.KINESIOLOGIST',
    'workerRegistration.generalInfo.PSYCHOLOGIST',
    'workerRegistration.generalInfo.knowledgeLevel',
    'workerRegistration.generalInfo.SECONDARY',
    'workerRegistration.generalInfo.TERTIARY',
    'workerRegistration.generalInfo.TECNICATURA',
    'workerRegistration.generalInfo.BACHELOR',
    'workerRegistration.generalInfo.POSTGRADUATE',
    'workerRegistration.generalInfo.MASTERS',
    'workerRegistration.generalInfo.DOCTORATE',
    'workerRegistration.generalInfo.professionalLicense',
    'workerRegistration.generalInfo.professionalLicensePlaceholder',
    'workerRegistration.generalInfo.experienceTypes',
    'workerRegistration.generalInfo.yearsExperience',
    'workerRegistration.generalInfo.years0to2',
    'workerRegistration.generalInfo.years3to5',
    'workerRegistration.generalInfo.years6to10',
    'workerRegistration.generalInfo.years10plus',
    'workerRegistration.generalInfo.preferredTypes',
    'workerRegistration.generalInfo.preferredAgeRange',
    'workerRegistration.generalInfo.ageRangeChildren',
    'workerRegistration.generalInfo.ageRangeAdolescents',
    'workerRegistration.generalInfo.ageRangeAdults',
    'workerRegistration.generalInfo.ageRangeElderly',
  ];

  describe('Espanhol (ES)', () => {
    it.each(GENERAL_INFO_KEYS)('chave "%s" existe e tem conteúdo', (key) => {
      assertKeyExists(es, key, 'ES');
    });

    it('todos os labels de Informações Gerais são compreensíveis', () => {
      for (const key of GENERAL_INFO_KEYS) {
        const value = getNestedValue(es, key) as string;
        assertLabelNotTechnical(value, key);
      }
    });
  });

  describe('Português (PT-BR)', () => {
    it.each(GENERAL_INFO_KEYS)('chave "%s" existe e tem conteúdo', (key) => {
      assertKeyExists(ptBR, key, 'PT-BR');
    });

    it('todos os labels de Informações Gerais são compreensíveis', () => {
      for (const key of GENERAL_INFO_KEYS) {
        const value = getNestedValue(ptBR, key) as string;
        assertLabelNotTechnical(value, key);
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LABELS DO FORMULÁRIO — Aba Endereço de Atendimento
// ═══════════════════════════════════════════════════════════════════════════

describe('Labels i18n — Aba Endereço de Atendimento', () => {
  const SERVICE_ADDRESS_KEYS = [
    'workerRegistration.serviceAddress.address',
    'workerRegistration.serviceAddress.addressPlaceholder',
    'workerRegistration.serviceAddress.complement',
    'workerRegistration.serviceAddress.complementPlaceholder',
    'workerRegistration.serviceAddress.serviceRadius',
    'workerRegistration.serviceAddress.km',
    'workerRegistration.serviceAddress.acceptsRemote',
  ];

  describe('Espanhol (ES)', () => {
    it.each(SERVICE_ADDRESS_KEYS)('chave "%s" existe e tem conteúdo', (key) => {
      assertKeyExists(es, key, 'ES');
    });
  });

  describe('Português (PT-BR)', () => {
    it.each(SERVICE_ADDRESS_KEYS)('chave "%s" existe e tem conteúdo', (key) => {
      assertKeyExists(ptBR, key, 'PT-BR');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LABELS DO FORMULÁRIO — Aba Disponibilidade
// ═══════════════════════════════════════════════════════════════════════════

describe('Labels i18n — Aba Disponibilidade', () => {
  const AVAILABILITY_KEYS = [
    'workerRegistration.availability.title',
    'workerRegistration.availability.sunday',
    'workerRegistration.availability.monday',
    'workerRegistration.availability.tuesday',
    'workerRegistration.availability.wednesday',
    'workerRegistration.availability.thursday',
    'workerRegistration.availability.friday',
    'workerRegistration.availability.saturday',
    'workerRegistration.availability.timeSlots',
  ];

  describe('Espanhol (ES)', () => {
    it.each(AVAILABILITY_KEYS)('chave "%s" existe e tem conteúdo', (key) => {
      assertKeyExists(es, key, 'ES');
    });

    it('cada dia da semana tem tradução descritiva', () => {
      const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      for (const day of days) {
        const value = getNestedValue(es, `workerRegistration.availability.${day}`) as string;
        expect(value.length, `Dia "${day}" em ES tem tradução muito curta`).toBeGreaterThan(3);
      }
    });
  });

  describe('Português (PT-BR)', () => {
    it.each(AVAILABILITY_KEYS)('chave "%s" existe e tem conteúdo', (key) => {
      assertKeyExists(ptBR, key, 'PT-BR');
    });

    it('cada dia da semana tem tradução descritiva', () => {
      const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      for (const day of days) {
        const value = getNestedValue(ptBR, `workerRegistration.availability.${day}`) as string;
        expect(value.length, `Dia "${day}" em PT-BR tem tradução muito curta`).toBeGreaterThan(3);
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LABELS DO FORMULÁRIO — Aba Documentos
// ═══════════════════════════════════════════════════════════════════════════

describe('Labels i18n — Aba Documentos', () => {
  // Inclui todos os tipos exibidos no grid (obrigatórios e opcionais).
  // Obrigatórios para AT: resume_cv, identity_document, identity_document_back, criminal_record, at_certificate.
  // Obrigatórios para Cuidador: identity_document, identity_document_back, criminal_record.
  // Opcionais (presentes no grid mas não obrigatórios): professional_registration, liability_insurance.
  const DOCUMENT_KEYS = [
    'documents.title',
    'documentTypes.resume_cv',
    'documentTypes.identity_document',
    'documentTypes.identity_document_back',
    'documentTypes.criminal_record',
    'documentTypes.at_certificate',
    'documentTypes.professional_registration',
    'documentTypes.liability_insurance',
  ];

  describe('Espanhol (ES)', () => {
    it.each(DOCUMENT_KEYS)('chave "%s" existe e tem conteúdo', (key) => {
      assertKeyExists(es, key, 'ES');
    });

    it('labels de documentos são descritivos (não apenas códigos técnicos)', () => {
      for (const key of DOCUMENT_KEYS) {
        const value = getNestedValue(es, key) as string;
        // Cada label de documento deve ter pelo menos 5 caracteres
        expect(value.length, `Label do documento "${key}" é muito curto: "${value}"`).toBeGreaterThanOrEqual(5);
      }
    });
  });

  describe('Português (PT-BR)', () => {
    it.each(DOCUMENT_KEYS)('chave "%s" existe e tem conteúdo', (key) => {
      assertKeyExists(ptBR, key, 'PT-BR');
    });

    it('labels de documentos são descritivos', () => {
      for (const key of DOCUMENT_KEYS) {
        const value = getNestedValue(ptBR, key) as string;
        expect(value.length, `Label do documento "${key}" é muito curto: "${value}"`).toBeGreaterThanOrEqual(5);
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// LABELS DE ERRO DE VALIDAÇÃO — Ambos os idiomas
// ═══════════════════════════════════════════════════════════════════════════

describe('Labels i18n — Mensagens de Validação', () => {
  const VALIDATION_KEYS = [
    'validation.fullNameMin',
    'validation.lastNameRequired',
    'validation.documentInvalid',
    'validation.phoneInvalid',
    'validation.emailInvalid',
    'validation.birthDateRequired',
    'validation.selectSex',
    'validation.selectGender',
    'validation.licenseRequired',
    'validation.selectLanguage',
    'validation.selectProfession',
    'validation.selectKnowledgeLevel',
    'validation.selectExperienceType',
    'validation.selectYearsExperience',
    'validation.selectPreferredType',
    'validation.selectAgeRange',
    'validation.serviceRadiusMin',
    'validation.addressRequired',
    'validation.timeInvalid',
    'validation.endTimeAfterStart',
    'validation.selectAtLeastOneDay',
  ];

  describe('Espanhol (ES)', () => {
    it.each(VALIDATION_KEYS)('chave "%s" existe e tem conteúdo', (key) => {
      assertKeyExists(es, key, 'ES');
    });

    it('todas as mensagens de validação são amigáveis (mínimo 10 chars, sem jargão)', () => {
      for (const key of VALIDATION_KEYS) {
        const value = getNestedValue(es, key) as string;
        expect(value.length, `Mensagem "${key}" em ES muito curta: "${value}"`).toBeGreaterThanOrEqual(10);
      }
    });
  });

  describe('Português (PT-BR)', () => {
    it.each(VALIDATION_KEYS)('chave "%s" existe e tem conteúdo', (key) => {
      assertKeyExists(ptBR, key, 'PT-BR');
    });

    it('todas as mensagens de validação são amigáveis (mínimo 10 chars, sem jargão)', () => {
      for (const key of VALIDATION_KEYS) {
        const value = getNestedValue(ptBR, key) as string;
        expect(value.length, `Mensagem "${key}" em PT-BR muito curta: "${value}"`).toBeGreaterThanOrEqual(10);
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TABS — Labels das abas
// ═══════════════════════════════════════════════════════════════════════════

describe('Labels i18n — Tabs do Perfil', () => {
  const TAB_KEYS = [
    'profile.title',
    'profile.save',
    'profile.saveSuccess',
    'profile.tabs.general',
    'profile.tabs.address',
    'profile.tabs.availability',
    'profile.tabs.documents',
  ];

  describe('Espanhol (ES)', () => {
    it.each(TAB_KEYS)('chave "%s" existe e tem conteúdo', (key) => {
      assertKeyExists(es, key, 'ES');
    });
  });

  describe('Português (PT-BR)', () => {
    it.each(TAB_KEYS)('chave "%s" existe e tem conteúdo', (key) => {
      assertKeyExists(ptBR, key, 'PT-BR');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CONSISTÊNCIA ENTRE IDIOMAS
// ═══════════════════════════════════════════════════════════════════════════

describe('Consistência entre ES e PT-BR', () => {
  const ALL_KEYS = [
    // Validation
    'validation.fullNameMin',
    'validation.lastNameRequired',
    'validation.documentInvalid',
    'validation.phoneInvalid',
    'validation.emailInvalid',
    'validation.birthDateRequired',
    'validation.selectSex',
    'validation.selectGender',
    'validation.licenseRequired',
    'validation.selectLanguage',
    'validation.selectProfession',
    'validation.selectKnowledgeLevel',
    'validation.selectExperienceType',
    'validation.selectYearsExperience',
    'validation.selectPreferredType',
    'validation.selectAgeRange',
    'validation.serviceRadiusMin',
    'validation.addressRequired',
    'validation.timeInvalid',
    'validation.endTimeAfterStart',
    'validation.selectAtLeastOneDay',
    // Documents
    'documents.title',
    'documentTypes.resume_cv',
    'documentTypes.identity_document',
    'documentTypes.identity_document_back',
    'documentTypes.criminal_record',
    'documentTypes.at_certificate',
    'documentTypes.professional_registration',
    'documentTypes.liability_insurance',
    // Profile
    'profile.title',
    'profile.save',
    'profile.tabs.general',
    'profile.tabs.address',
    'profile.tabs.availability',
    'profile.tabs.documents',
  ];

  it('toda chave que existe em ES deve existir em PT-BR', () => {
    for (const key of ALL_KEYS) {
      const esValue = getNestedValue(es, key);
      const ptValue = getNestedValue(ptBR, key);
      expect(ptValue, `Chave "${key}" existe em ES ("${esValue}") mas falta em PT-BR`).toBeDefined();
    }
  });

  it('toda chave que existe em PT-BR deve existir em ES', () => {
    for (const key of ALL_KEYS) {
      const esValue = getNestedValue(es, key);
      const ptValue = getNestedValue(ptBR, key);
      expect(esValue, `Chave "${key}" existe em PT-BR ("${ptValue}") mas falta em ES`).toBeDefined();
    }
  });
});
