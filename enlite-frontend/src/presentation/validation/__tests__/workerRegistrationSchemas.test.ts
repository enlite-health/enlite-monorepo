import { describe, it, expect, beforeAll } from 'vitest';
import i18n from '../../../infrastructure/i18n/config';
import {
  generalInfoSchema,
  serviceAddressSchema,
  timeSlotSchema,
  dayAvailabilitySchema,
  availabilitySchema,
  workerRegistrationSchema,
} from '../workerRegistrationSchemas';

describe('workerRegistrationSchemas', () => {
  beforeAll(() => {
    i18n.changeLanguage('es');
  });
  describe('generalInfoSchema', () => {
    it('should validate correct general info data with all fields', () => {
      const validData = {
        profilePhoto: 'data:image/png;base64,abc123',
        fullName: 'John Doe Silva',
        lastName: 'Silva',
        cpf: '12345678901',
        phone: '+5511999999999',
        email: 'john@example.com',
        birthDate: '01/01/1990',
        sex: 'male',
        gender: 'male',
        documentType: 'CPF',
        professionalLicense: 'CRM-12345',
        languages: ['pt', 'es'],
        profession: 'PSYCHOLOGIST',
        knowledgeLevel: 'MASTERS',
        experienceTypes: ['adicciones', 'psicosis'],
        yearsExperience: '3_5',
        preferredTypes: ['adicciones'],
        preferredAgeRange: ['adults'],
      };

      const result = generalInfoSchema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it('should accept null profilePhoto', () => {
      const validData = {
        profilePhoto: null,
        fullName: 'John Doe',
        lastName: 'Doe',
        cpf: '12345678901',
        phone: '+5511999999999',
        email: 'john@example.com',
        birthDate: '01/01/1990',
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

      const result = generalInfoSchema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it('should reject fullName shorter than 3 characters', () => {
      const invalidData = {
        fullName: 'Jo',
        lastName: 'Doe',
        cpf: '12345678901',
        phone: '+5511999999999',
        email: 'john@example.com',
        birthDate: '01/01/1990',
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

      const result = generalInfoSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain('al menos 3 caracteres');
      }
    });

    it('should reject invalid CPF length (too short)', () => {
      const invalidData = {
        fullName: 'John Doe',
        lastName: 'Doe',
        cpf: '123456789',
        phone: '+5511999999999',
        email: 'john@example.com',
        birthDate: '01/01/1990',
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

      const result = generalInfoSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain('Documento inválido');
      }
    });

    it('should reject invalid CPF length (too long)', () => {
      const invalidData = {
        fullName: 'John Doe',
        lastName: 'Doe',
        cpf: '123456789012345',
        phone: '+5511999999999',
        email: 'john@example.com',
        birthDate: '01/01/1990',
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

      const result = generalInfoSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain('Documento inválido');
      }
    });

    it('should reject invalid phone length (too short)', () => {
      const invalidData = {
        fullName: 'John Doe',
        lastName: 'Doe',
        cpf: '12345678901',
        phone: '123456789',
        email: 'john@example.com',
        birthDate: '01/01/1990',
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

      const result = generalInfoSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain('Teléfono inválido');
      }
    });

    it('should reject invalid phone length (too long)', () => {
      const invalidData = {
        fullName: 'John Doe',
        lastName: 'Doe',
        cpf: '12345678901',
        phone: '+55119999999999999',
        email: 'john@example.com',
        birthDate: '01/01/1990',
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

      const result = generalInfoSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain('Teléfono inválido');
      }
    });

    it('should reject invalid email format', () => {
      const invalidData = {
        fullName: 'John Doe',
        lastName: 'Doe',
        cpf: '12345678901',
        phone: '+5511999999999',
        email: 'invalid-email',
        birthDate: '01/01/1990',
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

      const result = generalInfoSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain('Correo electrónico inválido');
      }
    });

    it('should reject empty birthDate', () => {
      const invalidData = {
        fullName: 'John Doe',
        lastName: 'Doe',
        cpf: '12345678901',
        phone: '+5511999999999',
        email: 'john@example.com',
        birthDate: '',
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

      const result = generalInfoSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain('La fecha de nacimiento es obligatoria');
      }
    });

    it('should reject empty professionalLicense', () => {
      const invalidData = {
        fullName: 'John Doe',
        lastName: 'Doe',
        cpf: '12345678901',
        phone: '+5511999999999',
        email: 'john@example.com',
        birthDate: '01/01/1990',
        sex: 'male',
        gender: 'male',
        documentType: 'CPF',
        professionalLicense: '',
        languages: ['pt'],
        profession: 'PSYCHOLOGIST',
        knowledgeLevel: 'BACHELOR',
        experienceTypes: ['adicciones'],
        yearsExperience: '3_5',
        preferredTypes: ['adicciones'],
        preferredAgeRange: ['adults'],
      };

      const result = generalInfoSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain('El registro profesional es obligatorio');
      }
    });
  });

  describe('serviceAddressSchema', () => {
    it('should validate correct service address data', () => {
      const validData = {
        serviceRadius: 15,
        address: 'Rua Example, 123',
        complement: 'Apto 45',
        acceptsRemoteService: true,
      };

      const result = serviceAddressSchema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it('should accept missing complement', () => {
      const validData = {
        serviceRadius: 10,
        address: 'Rua Example, 123',
        acceptsRemoteService: false,
      };

      const result = serviceAddressSchema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it('should reject serviceRadius less than 1', () => {
      const invalidData = {
        serviceRadius: 0,
        address: 'Rua Example, 123',
        acceptsRemoteService: false,
      };

      const result = serviceAddressSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain('El radio de atención debe ser al menos 1 km');
      }
    });

    it('should reject empty address', () => {
      const invalidData = {
        serviceRadius: 10,
        address: '',
        acceptsRemoteService: false,
      };

      const result = serviceAddressSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain('La dirección es obligatoria');
      }
    });

    it('should accept acceptsRemoteService as true', () => {
      const validData = {
        serviceRadius: 10,
        address: 'Rua Example, 123',
        acceptsRemoteService: true,
      };

      const result = serviceAddressSchema.safeParse(validData);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.acceptsRemoteService).toBe(true);
      }
    });

    it('should accept acceptsRemoteService as false', () => {
      const validData = {
        serviceRadius: 10,
        address: 'Rua Example, 123',
        acceptsRemoteService: false,
      };

      const result = serviceAddressSchema.safeParse(validData);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.acceptsRemoteService).toBe(false);
      }
    });
  });

  describe('timeSlotSchema', () => {
    it('should validate correct time slot', () => {
      const validData = {
        startTime: '09:00',
        endTime: '17:00',
      };

      const result = timeSlotSchema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it('should accept single digit hours', () => {
      const validData = {
        startTime: '9:00',
        endTime: '17:00',
      };

      const result = timeSlotSchema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it('should accept 24-hour format', () => {
      const validData = {
        startTime: '08:30',
        endTime: '23:45',
      };

      const result = timeSlotSchema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it('should reject invalid time format', () => {
      const invalidData = {
        startTime: '25:00',
        endTime: '17:00',
      };

      const result = timeSlotSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain('Horario inválido');
      }
    });

    it('should reject invalid minutes', () => {
      const invalidData = {
        startTime: '09:60',
        endTime: '17:00',
      };

      const result = timeSlotSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
    });

    it('should reject endTime before startTime', () => {
      const invalidData = {
        startTime: '17:00',
        endTime: '09:00',
      };

      const result = timeSlotSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain('después del horario de inicio');
      }
    });

    it('should reject equal start and end times', () => {
      const invalidData = {
        startTime: '09:00',
        endTime: '09:00',
      };

      const result = timeSlotSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
    });

    it('should validate time slots across midnight boundary', () => {
      const validData = {
        startTime: '22:00',
        endTime: '23:59',
      };

      const result = timeSlotSchema.safeParse(validData);
      expect(result.success).toBe(true);
    });
  });

  describe('dayAvailabilitySchema', () => {
    it('should validate correct day availability', () => {
      const validData = {
        day: 'Segunda',
        enabled: true,
        timeSlots: [
          { startTime: '09:00', endTime: '12:00' },
          { startTime: '14:00', endTime: '18:00' },
        ],
      };

      const result = dayAvailabilitySchema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it('should accept disabled day with no time slots', () => {
      const validData = {
        day: 'Domingo',
        enabled: false,
        timeSlots: [],
      };

      const result = dayAvailabilitySchema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it('should accept enabled day with empty time slots', () => {
      const validData = {
        day: 'Sábado',
        enabled: true,
        timeSlots: [],
      };

      const result = dayAvailabilitySchema.safeParse(validData);
      expect(result.success).toBe(true);
    });
  });

  describe('availabilitySchema', () => {
    it('should validate correct availability with at least one enabled day', () => {
      const validData = {
        schedule: [
          { day: 'Domingo', enabled: false, timeSlots: [] },
          { day: 'Segunda', enabled: true, timeSlots: [{ startTime: '09:00', endTime: '17:00' }] },
          { day: 'Terça', enabled: false, timeSlots: [] },
        ],
      };

      const result = availabilitySchema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it('should reject schedule with no enabled days', () => {
      const invalidData = {
        schedule: [
          { day: 'Domingo', enabled: false, timeSlots: [] },
          { day: 'Segunda', enabled: false, timeSlots: [] },
          { day: 'Terça', enabled: false, timeSlots: [] },
        ],
      };

      const result = availabilitySchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain('al menos un día');
      }
    });

    it('should reject schedule with enabled day but no time slots', () => {
      const invalidData = {
        schedule: [
          { day: 'Domingo', enabled: false, timeSlots: [] },
          { day: 'Segunda', enabled: true, timeSlots: [] },
          { day: 'Terça', enabled: false, timeSlots: [] },
        ],
      };

      const result = availabilitySchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0].message).toContain('al menos un día');
      }
    });

    it('should validate multiple enabled days with time slots', () => {
      const validData = {
        schedule: [
          { day: 'Segunda', enabled: true, timeSlots: [{ startTime: '09:00', endTime: '17:00' }] },
          { day: 'Terça', enabled: true, timeSlots: [{ startTime: '10:00', endTime: '16:00' }] },
          { day: 'Quarta', enabled: true, timeSlots: [{ startTime: '08:00', endTime: '12:00' }] },
        ],
      };

      const result = availabilitySchema.safeParse(validData);
      expect(result.success).toBe(true);
    });
  });

  describe('workerRegistrationSchema', () => {
    it('should validate complete worker registration data', () => {
      const validData = {
        generalInfo: {
          profilePhoto: null,
          fullName: 'John Doe Silva',
          lastName: 'Silva',
          cpf: '12345678901',
          phone: '+5511999999999',
          email: 'john@example.com',
          birthDate: '01/01/1990',
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
        },
        serviceAddress: {
          serviceRadius: 15,
          address: 'Rua Example, 123',
          complement: 'Apto 45',
          acceptsRemoteService: true,
        },
        availability: {
          schedule: [
            { day: 'Segunda', enabled: true, timeSlots: [{ startTime: '09:00', endTime: '17:00' }] },
            { day: 'Terça', enabled: false, timeSlots: [] },
          ],
        },
      };

      const result = workerRegistrationSchema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it('should reject incomplete general info', () => {
      const invalidData = {
        generalInfo: {
          fullName: 'Jo',
          cpf: '123',
          phone: '123',
          email: 'invalid',
          birthDate: '',
          professionalLicense: '',
        },
        serviceAddress: {
          serviceRadius: 15,
          address: 'Rua Example, 123',
          acceptsRemoteService: true,
        },
        availability: {
          schedule: [
            { day: 'Segunda', enabled: true, timeSlots: [{ startTime: '09:00', endTime: '17:00' }] },
          ],
        },
      };

      const result = workerRegistrationSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
    });

    it('should reject invalid service address', () => {
      const invalidData = {
        generalInfo: {
          fullName: 'John Doe',
          cpf: '12345678901',
          phone: '+5511999999999',
          email: 'john@example.com',
          birthDate: '01/01/1990',
          professionalLicense: 'CRM-12345',
        },
        serviceAddress: {
          serviceRadius: 0,
          address: '',
          acceptsRemoteService: true,
        },
        availability: {
          schedule: [
            { day: 'Segunda', enabled: true, timeSlots: [{ startTime: '09:00', endTime: '17:00' }] },
          ],
        },
      };

      const result = workerRegistrationSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
    });

    it('should reject invalid availability', () => {
      const invalidData = {
        generalInfo: {
          fullName: 'John Doe',
          cpf: '12345678901',
          phone: '+5511999999999',
          email: 'john@example.com',
          birthDate: '01/01/1990',
          professionalLicense: 'CRM-12345',
        },
        serviceAddress: {
          serviceRadius: 15,
          address: 'Rua Example, 123',
          acceptsRemoteService: true,
        },
        availability: {
          schedule: [
            { day: 'Segunda', enabled: false, timeSlots: [] },
            { day: 'Terça', enabled: false, timeSlots: [] },
          ],
        },
      };

      const result = workerRegistrationSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    it('should handle CPF with formatting characters', () => {
      const data = {
        fullName: 'John Doe',
        lastName: 'Doe',
        cpf: '123.456.789-01',
        phone: '+5511999999999',
        email: 'john@example.com',
        birthDate: '01/01/1990',
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

      const result = generalInfoSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('should handle phone with various formats', () => {
      const validPhones = [
        '+5511999999999',
        '11999999999',
        '(11)99999-9999',
      ];

      validPhones.forEach(phone => {
        const data = {
          fullName: 'John Doe',
          lastName: 'Doe',
          cpf: '12345678901',
          phone,
          email: 'john@example.com',
          birthDate: '01/01/1990',
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

        const result = generalInfoSchema.safeParse(data);
        expect(result.success).toBe(true);
      });
    });

    it('should handle time slots at edge of day', () => {
      const data = {
        startTime: '00:00',
        endTime: '23:59',
      };

      const result = timeSlotSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('should handle large service radius', () => {
      const data = {
        serviceRadius: 100,
        address: 'Rua Example, 123',
        acceptsRemoteService: false,
      };

      const result = serviceAddressSchema.safeParse(data);
      expect(result.success).toBe(true);
    });

    it('should handle full week schedule', () => {
      const data = {
        schedule: [
          { day: 'Domingo', enabled: true, timeSlots: [{ startTime: '08:00', endTime: '12:00' }] },
          { day: 'Segunda', enabled: true, timeSlots: [{ startTime: '09:00', endTime: '17:00' }] },
          { day: 'Terça', enabled: true, timeSlots: [{ startTime: '09:00', endTime: '17:00' }] },
          { day: 'Quarta', enabled: true, timeSlots: [{ startTime: '09:00', endTime: '17:00' }] },
          { day: 'Quinta', enabled: true, timeSlots: [{ startTime: '09:00', endTime: '17:00' }] },
          { day: 'Sexta', enabled: true, timeSlots: [{ startTime: '09:00', endTime: '17:00' }] },
          { day: 'Sábado', enabled: true, timeSlots: [{ startTime: '08:00', endTime: '14:00' }] },
        ],
      };

      const result = availabilitySchema.safeParse(data);
      expect(result.success).toBe(true);
    });
  });
});
