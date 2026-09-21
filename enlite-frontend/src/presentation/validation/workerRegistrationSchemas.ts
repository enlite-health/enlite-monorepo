import { z } from 'zod';
import i18n from '../../infrastructure/i18n/config';
import { isValidBirthDateBr } from '../hooks/useMask';

const t = i18n.t.bind(i18n);

// Enum values
const LANGUAGE_VALUES = ['pt', 'es', 'en'] as const;
const SEX_VALUES = ['male', 'female'] as const;
const GENDER_VALUES = ['male', 'female', 'other'] as const;
const DOCUMENT_TYPE_VALUES = ['CUIL_CUIT', 'CPF', 'RG', 'CNH'] as const;
const PROFESSION_VALUES = ['AT', 'CAREGIVER', 'NURSE', 'KINESIOLOGIST', 'PSYCHOLOGIST'] as const;
const KNOWLEDGE_LEVEL_VALUES = ['SECONDARY', 'TERTIARY', 'TECNICATURA', 'BACHELOR', 'POSTGRADUATE', 'MASTERS', 'DOCTORATE'] as const;
const PATIENT_TYPE_VALUES = ['adicciones', 'psicosis', 'trastorno_alimentar', 'trastorno_bipolaridad', 'trastorno_ansiedad', 'trastorno_discapacidad_intelectual', 'trastorno_depresivo', 'trastorno_neurologico', 'trastorno_opositor_desafiante', 'trastorno_psicologico', 'trastorno_psiquiatrico'] as const;
const YEARS_EXPERIENCE_VALUES = ['0_2', '3_5', '6_10', '10_plus'] as const;
const AGE_RANGE_VALUES = ['children', 'adolescents', 'adults', 'elderly'] as const;

// Enums for select values (with user-friendly error messages)
const DocumentTypeEnum = z.enum(DOCUMENT_TYPE_VALUES);

// General Info Step Schema factory
export const createGeneralInfoSchema = () => z.object({
  profilePhoto: z.string().nullable().optional(),
  fullName: z.string({ required_error: t('validation.fullNameMin'), invalid_type_error: t('validation.fullNameMin') }).min(3, t('validation.fullNameMin')),
  lastName: z.string({ required_error: t('validation.lastNameRequired'), invalid_type_error: t('validation.lastNameRequired') }).min(1, t('validation.lastNameRequired')),
  cpf: z.string({ required_error: t('validation.documentInvalid'), invalid_type_error: t('validation.documentInvalid') }).min(11, t('validation.documentInvalid')).max(14, t('validation.documentInvalid')),
  phone: z.string({ required_error: t('validation.phoneInvalid'), invalid_type_error: t('validation.phoneInvalid') }).min(10, t('validation.phoneInvalid')).max(15, t('validation.phoneInvalid')),
  email: z.string({ required_error: t('validation.emailInvalid'), invalid_type_error: t('validation.emailInvalid') }).email(t('validation.emailInvalid')),
  birthDate: z.string({ required_error: t('validation.birthDateRequired'), invalid_type_error: t('validation.birthDateRequired') })
    .min(1, t('validation.birthDateRequired'))
    // Vazio já é pego pelo `.min(1)` acima — aqui só reprova formato/calendário
    // quando HÁ conteúdo, senão as duas mensagens colidiriam no mesmo campo.
    .refine((val) => val === '' || isValidBirthDateBr(val), { message: t('validation.birthDateInvalid') }),
  sex: z.string({ invalid_type_error: t('validation.selectSex') })
    .transform((val) => val === '' ? undefined : val)
    .refine((val): val is 'male' | 'female' => val !== undefined && (SEX_VALUES as readonly string[]).includes(val), { message: t('validation.selectSex') }),
  gender: z.string({ invalid_type_error: t('validation.selectGender') })
    .transform((val) => val === '' ? undefined : val)
    .refine((val): val is 'male' | 'female' | 'other' => val !== undefined && (GENDER_VALUES as readonly string[]).includes(val), { message: t('validation.selectGender') }),
  documentType: DocumentTypeEnum,
  professionalLicense: z.string().min(1, t('validation.licenseRequired')),
  languages: z.array(
    z.enum(LANGUAGE_VALUES, { errorMap: () => ({ message: t('validation.selectLanguage') }) }),
  ).min(1, t('validation.selectLanguage')),
  profession: z.string({ invalid_type_error: t('validation.selectProfession') })
    .transform((val) => val === '' ? undefined : val)
    .refine((val): val is 'AT' | 'CAREGIVER' | 'NURSE' | 'KINESIOLOGIST' | 'PSYCHOLOGIST' => val !== undefined && (PROFESSION_VALUES as readonly string[]).includes(val), { message: t('validation.selectProfession') }),
  knowledgeLevel: z.string({ invalid_type_error: t('validation.selectKnowledgeLevel') })
    .transform((val) => val === '' ? undefined : val)
    .refine((val): val is 'SECONDARY' | 'TERTIARY' | 'TECNICATURA' | 'BACHELOR' | 'POSTGRADUATE' | 'MASTERS' | 'DOCTORATE' => val !== undefined && (KNOWLEDGE_LEVEL_VALUES as readonly string[]).includes(val), { message: t('validation.selectKnowledgeLevel') }),
  experienceTypes: z.array(
    z.enum(PATIENT_TYPE_VALUES, { errorMap: () => ({ message: t('validation.selectExperienceType') }) }),
  ).min(1, t('validation.selectExperienceType')),
  yearsExperience: z.string({ invalid_type_error: t('validation.selectYearsExperience') })
    .transform((val) => val === '' ? undefined : val)
    .refine((val): val is '0_2' | '3_5' | '6_10' | '10_plus' => val !== undefined && (YEARS_EXPERIENCE_VALUES as readonly string[]).includes(val), { message: t('validation.selectYearsExperience') }),
  preferredTypes: z.array(
    z.enum(PATIENT_TYPE_VALUES, { errorMap: () => ({ message: t('validation.selectPreferredType') }) }),
  ).min(1, t('validation.selectPreferredType')),
  preferredAgeRange: z.array(
    z.enum(AGE_RANGE_VALUES, { errorMap: () => ({ message: t('validation.selectAgeRange') }) }),
  ).min(1, t('validation.selectAgeRange')),
});

export type GeneralInfoFormData = z.infer<ReturnType<typeof createGeneralInfoSchema>>;

// Service Address Step Schema factory
export const createServiceAddressSchema = () => z.object({
  serviceRadius: z.number({ invalid_type_error: t('validation.serviceRadiusMin') }).min(1, t('validation.serviceRadiusMin')),
  address: z.string().min(1, t('validation.addressRequired')),
  complement: z.string().optional(),
  acceptsRemoteService: z.boolean(),
});

export type ServiceAddressFormData = z.infer<ReturnType<typeof createServiceAddressSchema>>;

// Time Slot Schema factory
export const createTimeSlotSchema = () => z.object({
  startTime: z.string().regex(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, t('validation.timeInvalid')),
  endTime: z.string().regex(/^([0-1]?[0-9]|2[0-3]):[0-5][0-9]$/, t('validation.timeInvalid')),
}).refine((data) => {
  const [startHour, startMin] = data.startTime.split(':').map(Number);
  const [endHour, endMin] = data.endTime.split(':').map(Number);
  const startMinutes = startHour * 60 + startMin;
  const endMinutes = endHour * 60 + endMin;
  return endMinutes > startMinutes;
}, {
  message: t('validation.endTimeAfterStart'),
  path: ['endTime'],
});

export type TimeSlotFormData = z.infer<ReturnType<typeof createTimeSlotSchema>>;

// Day Availability Schema
export const dayAvailabilitySchema = z.object({
  day: z.string(),
  enabled: z.boolean(),
  timeSlots: z.array(z.object({
    startTime: z.string(),
    endTime: z.string(),
  })),
});

export type DayAvailabilityFormData = z.infer<typeof dayAvailabilitySchema>;

// Availability Step Schema factory
export const createAvailabilitySchema = () => z.object({
  schedule: z.array(dayAvailabilitySchema).refine(
    (schedule) => schedule.some((day) => day.enabled && day.timeSlots.length > 0),
    {
      message: t('validation.selectAtLeastOneDay'),
    }
  ),
});

export type AvailabilityFormData = z.infer<ReturnType<typeof createAvailabilitySchema>>;

// Complete Worker Registration Schema factory
export const createWorkerRegistrationSchema = () => z.object({
  generalInfo: createGeneralInfoSchema(),
  serviceAddress: createServiceAddressSchema(),
  availability: createAvailabilitySchema(),
});

export type WorkerRegistrationFormData = z.infer<ReturnType<typeof createWorkerRegistrationSchema>>;

// Legacy exports for backward compatibility (deprecated, use create* functions)
export const generalInfoSchema = createGeneralInfoSchema();
export const serviceAddressSchema = createServiceAddressSchema();
export const timeSlotSchema = createTimeSlotSchema();
export const availabilitySchema = createAvailabilitySchema();
export const workerRegistrationSchema = createWorkerRegistrationSchema();
