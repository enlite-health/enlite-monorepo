import { describe, it, expect, beforeAll } from 'vitest';
import i18n from '../../../infrastructure/i18n/config';
import { generalInfoSchema } from '../workerRegistrationSchemas';

describe('generalInfoSchema - New Fields Validation', () => {
  beforeAll(() => {
    // Ensure default language is set for consistent test results
    i18n.changeLanguage('es');
  });
  const baseValidData = {
    profilePhoto: null,
    fullName: 'John Doe',
    lastName: 'Silva',
    cpf: '12345678901',
    phone: '+5511999999999',
    email: 'john@example.com',
    birthDate: '1990-01-01',
    sex: 'male',
    gender: 'male',
    documentType: 'CPF',
    professionalLicense: 'CRM-12345',
    languages: ['pt'],
    profession: 'PSYCHOLOGIST',
    knowledgeLevel: 'BACHELOR',
    experienceTypes: ['adicciones'],
    yearsExperience: '3_5',
    preferredTypes: ['adicciones'],
    preferredAgeRange: ['adults'],
  };

  describe('lastName field', () => {
    it('should accept valid lastName', () => {
      const result = generalInfoSchema.safeParse(baseValidData);
      expect(result.success).toBe(true);
    });

    it('should reject empty lastName', () => {
      const invalidData = { ...baseValidData, lastName: '' };
      const result = generalInfoSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain('El apellido es obligatorio');
      }
    });
  });

  describe('sex field', () => {
    it('should accept male', () => {
      const data = { ...baseValidData, sex: 'male' };
      const result = generalInfoSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('should accept female', () => {
      const data = { ...baseValidData, sex: 'female' };
      const result = generalInfoSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('should reject invalid sex value', () => {
      const invalidData = { ...baseValidData, sex: 'invalid' };
      const result = generalInfoSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
    });
  });

  describe('gender field', () => {
    it('should accept male', () => {
      const data = { ...baseValidData, gender: 'male' };
      const result = generalInfoSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('should accept female', () => {
      const data = { ...baseValidData, gender: 'female' };
      const result = generalInfoSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('should accept other', () => {
      const data = { ...baseValidData, gender: 'other' };
      const result = generalInfoSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('should reject invalid gender value', () => {
      const invalidData = { ...baseValidData, gender: 'invalid' };
      const result = generalInfoSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
    });
  });

  describe('documentType field', () => {
    it('should accept CPF', () => {
      const data = { ...baseValidData, documentType: 'CPF' };
      const result = generalInfoSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('should accept RG', () => {
      const data = { ...baseValidData, documentType: 'RG' };
      const result = generalInfoSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('should accept CNH', () => {
      const data = { ...baseValidData, documentType: 'CNH' };
      const result = generalInfoSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('should reject empty documentType', () => {
      const invalidData = { ...baseValidData, documentType: '' };
      const result = generalInfoSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain('Invalid enum value');
      }
    });
  });

  describe('languages field', () => {
    it('should accept single language', () => {
      const data = { ...baseValidData, languages: ['pt'] };
      const result = generalInfoSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('should accept multiple languages', () => {
      const data = { ...baseValidData, languages: ['pt', 'es', 'en'] };
      const result = generalInfoSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('should reject empty languages array', () => {
      const invalidData = { ...baseValidData, languages: [] };
      const result = generalInfoSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain('Seleccione al menos un idioma');
      }
    });
  });

  describe('profession field', () => {
    it('should accept CAREGIVER', () => {
      const data = { ...baseValidData, profession: 'CAREGIVER' };
      const result = generalInfoSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('should accept NURSE', () => {
      const data = { ...baseValidData, profession: 'NURSE' };
      const result = generalInfoSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('should accept PSYCHOLOGIST', () => {
      const data = { ...baseValidData, profession: 'PSYCHOLOGIST' };
      const result = generalInfoSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('should reject empty profession', () => {
      const invalidData = { ...baseValidData, profession: '' };
      const result = generalInfoSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain('Por favor, seleccione la profesión');
      }
    });
  });

  describe('knowledgeLevel field', () => {
    it('should accept BACHELOR', () => {
      const data = { ...baseValidData, knowledgeLevel: 'BACHELOR' };
      const result = generalInfoSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('should accept SECONDARY', () => {
      const data = { ...baseValidData, knowledgeLevel: 'SECONDARY' };
      const result = generalInfoSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('should accept MASTERS', () => {
      const data = { ...baseValidData, knowledgeLevel: 'MASTERS' };
      const result = generalInfoSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('should reject empty knowledgeLevel', () => {
      const invalidData = { ...baseValidData, knowledgeLevel: '' };
      const result = generalInfoSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain('Por favor, seleccione el nivel de estudios');
      }
    });
  });

  describe('experienceTypes field', () => {
    it('should accept single experience type', () => {
      const data = { ...baseValidData, experienceTypes: ['adicciones'] };
      const result = generalInfoSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('should accept multiple experience types', () => {
      const data = { ...baseValidData, experienceTypes: ['adicciones', 'psicosis', 'trastorno_depresivo'] };
      const result = generalInfoSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('should reject empty experienceTypes array', () => {
      const invalidData = { ...baseValidData, experienceTypes: [] };
      const result = generalInfoSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain('Seleccione al menos un tipo de experiencia');
      }
    });
  });

  describe('yearsExperience field', () => {
    it('should accept 0_2', () => {
      const data = { ...baseValidData, yearsExperience: '0_2' };
      const result = generalInfoSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('should accept 3_5', () => {
      const data = { ...baseValidData, yearsExperience: '3_5' };
      const result = generalInfoSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('should accept 10_plus', () => {
      const data = { ...baseValidData, yearsExperience: '10_plus' };
      const result = generalInfoSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('should reject empty yearsExperience', () => {
      const invalidData = { ...baseValidData, yearsExperience: '' };
      const result = generalInfoSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain('Por favor, seleccione los años de experiencia');
      }
    });
  });

  describe('preferredTypes field', () => {
    it('should accept single preferred type', () => {
      const data = { ...baseValidData, preferredTypes: ['adicciones'] };
      const result = generalInfoSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('should accept multiple preferred types', () => {
      const data = { ...baseValidData, preferredTypes: ['adicciones', 'psicosis'] };
      const result = generalInfoSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('should reject empty preferredTypes array', () => {
      const invalidData = { ...baseValidData, preferredTypes: [] };
      const result = generalInfoSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain('Seleccione al menos un tipo preferido');
      }
    });
  });

  describe('preferredAgeRange field', () => {
    it('should accept children', () => {
      const data = { ...baseValidData, preferredAgeRange: ['children'] };
      const result = generalInfoSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('should accept adolescents', () => {
      const data = { ...baseValidData, preferredAgeRange: ['adolescents'] };
      const result = generalInfoSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('should accept adults', () => {
      const data = { ...baseValidData, preferredAgeRange: ['adults'] };
      const result = generalInfoSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('should accept elderly', () => {
      const data = { ...baseValidData, preferredAgeRange: ['elderly'] };
      const result = generalInfoSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('should reject empty preferredAgeRange', () => {
      const invalidData = { ...baseValidData, preferredAgeRange: [] };
      const result = generalInfoSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain('Por favor, seleccione el rango de edad preferido');
      }
    });
  });

  describe('Complete validation with all new fields', () => {
    it('should validate complete data with all fields filled correctly', () => {
      const completeData = {
        profilePhoto: 'data:image/png;base64,abc123',
        fullName: 'Alberto Marquez',
        lastName: 'Marquez',
        cpf: '12345678901',
        phone: '+5511999999999',
        email: 'alberto@example.com',
        birthDate: '1980-03-18',
        sex: 'male',
        gender: 'male',
        documentType: 'CPF',
        professionalLicense: 'Licenciado em psicologia',
        languages: ['pt', 'es'],
        profession: 'PSYCHOLOGIST',
        knowledgeLevel: 'MASTERS',
        experienceTypes: ['adicciones', 'psicosis'],
        yearsExperience: '10_plus',
        preferredTypes: ['adicciones'],
        preferredAgeRange: ['elderly'],
      };

      const result = generalInfoSchema.safeParse(completeData);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.lastName).toBe('Marquez');
        expect(result.data.sex).toBe('male');
        expect(result.data.gender).toBe('male');
        expect(result.data.documentType).toBe('CPF');
        expect(result.data.languages).toHaveLength(2);
        expect(result.data.profession).toBe('PSYCHOLOGIST');
        expect(result.data.knowledgeLevel).toBe('MASTERS');
        expect(result.data.experienceTypes).toHaveLength(2);
        expect(result.data.yearsExperience).toBe('10_plus');
        expect(result.data.preferredTypes).toHaveLength(1);
        expect(result.data.preferredAgeRange).toEqual(['elderly']);
      }
    });

    it('should reject data missing any required field', () => {
      const requiredFields = [
        'lastName', 'sex', 'gender', 'documentType', 'languages',
        'profession', 'knowledgeLevel', 'experienceTypes',
        'yearsExperience', 'preferredTypes', 'preferredAgeRange'
      ];

      requiredFields.forEach(field => {
        const incompleteData = { ...baseValidData, [field]: field.includes('Types') || field === 'languages' || field === 'preferredAgeRange' ? [] : '' };
        const result = generalInfoSchema.safeParse(incompleteData);
        expect(result.success).toBe(false);
      });
    });
  });
});
