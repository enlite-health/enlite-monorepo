import { describe, it, expect, beforeAll } from 'vitest';
import i18n from '../../../infrastructure/i18n/config';
import {
  createGeneralInfoSchema,
  createServiceAddressSchema,
  createTimeSlotSchema,
  createAvailabilitySchema,
} from '../workerRegistrationSchemas';

/**
 * Testes rigorosos de mensagens de erro de validação do perfil do worker.
 *
 * Objetivo: garantir que TODAS as mensagens de erro são amigáveis para o usuário
 * (não técnicas) e estão traduzidas corretamente em ambos os idiomas (ES e PT-BR).
 *
 * Problemas que estes testes detectam:
 * - Mensagens padrão do Zod vazando ("Expected string", "Invalid input", "Required")
 * - Mensagens técnicas demais ("min length 3", "invalid enum value")
 * - Chaves de tradução faltando
 * - Mensagens que não orientam o usuário sobre como corrigir o erro
 */

// ─── Helpers ────────────────────────────────────────────────────────────────

function getFieldErrors(result: { success: boolean; error?: { errors: Array<{ path: (string | number)[]; message: string }> } }) {
  if (result.success) return {};
  return result.error!.errors.reduce<Record<string, string>>((acc, e) => {
    const path = e.path.join('.');
    acc[path] = e.message;
    return acc;
  }, {});
}

/** Mensagens técnicas do Zod que NUNCA devem aparecer para o usuário */
const ZOD_TECHNICAL_PATTERNS = [
  /^Expected /i,
  /^Invalid input$/i,
  /^Required$/i,
  /^String must contain/i,
  /^Number must be/i,
  /^Invalid enum value/i,
  /^Invalid type/i,
  /^Unrecognized key/i,
  /^Invalid literal value/i,
  /^Invalid union/i,
  /received/i,
];

function assertUserFriendly(message: string, fieldName: string) {
  for (const pattern of ZOD_TECHNICAL_PATTERNS) {
    expect(message, `Campo "${fieldName}": mensagem técnica do Zod detectada: "${message}"`).not.toMatch(pattern);
  }
  // Mensagem não pode ser vazia
  expect(message.length, `Campo "${fieldName}": mensagem de erro vazia`).toBeGreaterThan(0);
  // Mensagem deve ter pelo menos 10 caracteres (mensagens muito curtas são pouco informativas)
  expect(message.length, `Campo "${fieldName}": mensagem muito curta: "${message}"`).toBeGreaterThanOrEqual(10);
}

// ─── Dados base válidos ─────────────────────────────────────────────────────

const VALID_GENERAL_INFO = {
  profilePhoto: null,
  fullName: 'Alberto Marquez',
  lastName: 'Marquez',
  cpf: '12345678901',
  phone: '+5411999999999',
  email: 'alberto@example.com',
  birthDate: '18/03/1960',
  sex: 'male' as const,
  gender: 'male' as const,
  documentType: 'CUIL_CUIT' as const,
  professionalLicense: 'Licenciado en psicología',
  languages: ['es'] as Array<'pt' | 'es' | 'en'>,
  profession: 'AT' as const,
  knowledgeLevel: 'BACHELOR' as const,
  experienceTypes: ['adicciones'] as Array<'adicciones'>,
  yearsExperience: '3_5' as const,
  preferredTypes: ['adicciones'] as Array<'adicciones'>,
  preferredAgeRange: ['adults'] as Array<'children' | 'adolescents' | 'adults' | 'elderly'>,
};

const VALID_SERVICE_ADDRESS = {
  serviceRadius: 10,
  address: 'Av. Corrientes 1234, CABA',
  complement: 'Piso 3',
  acceptsRemoteService: false,
};

// ═══════════════════════════════════════════════════════════════════════════
// TESTES EM ESPANHOL (idioma principal)
// ═══════════════════════════════════════════════════════════════════════════

describe('Mensagens de erro — Espanhol (ES)', () => {
  beforeAll(() => {
    i18n.changeLanguage('es');
  });

  describe('Aba: Información General', () => {
    const schema = () => createGeneralInfoSchema();

    // ── fullName ──────────────────────────────────────────────────────────

    it('fullName vazio → mensagem amigável indicando mínimo de caracteres', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, fullName: '' });
      const errors = getFieldErrors(result);
      expect(errors['fullName']).toBe('El nombre completo debe tener al menos 3 caracteres');
      assertUserFriendly(errors['fullName'], 'fullName');
    });

    it('fullName com 2 caracteres → mensagem amigável indicando mínimo', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, fullName: 'Al' });
      const errors = getFieldErrors(result);
      expect(errors['fullName']).toBe('El nombre completo debe tener al menos 3 caracteres');
      assertUserFriendly(errors['fullName'], 'fullName');
    });

    it('fullName com 3 caracteres → deve ser aceito', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, fullName: 'Ana' });
      expect(result.success).toBe(true);
    });

    // ── lastName ──────────────────────────────────────────────────────────

    it('lastName vazio → mensagem indicando que é obrigatório', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, lastName: '' });
      const errors = getFieldErrors(result);
      expect(errors['lastName']).toBe('El apellido es obligatorio');
      assertUserFriendly(errors['lastName'], 'lastName');
    });

    // ── cpf (documento) ──────────────────────────────────────────────────

    it('documento muito curto (menos de 11 chars) → "Documento inválido"', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, cpf: '12345' });
      const errors = getFieldErrors(result);
      expect(errors['cpf']).toBe('Documento inválido');
      assertUserFriendly(errors['cpf'], 'cpf');
    });

    it('documento muito longo (mais de 14 chars) → "Documento inválido"', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, cpf: '123456789012345' });
      const errors = getFieldErrors(result);
      expect(errors['cpf']).toBe('Documento inválido');
      assertUserFriendly(errors['cpf'], 'cpf');
    });

    it('documento vazio → "Documento inválido"', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, cpf: '' });
      const errors = getFieldErrors(result);
      expect(errors['cpf']).toBe('Documento inválido');
      assertUserFriendly(errors['cpf'], 'cpf');
    });

    it('documento com 11 chars → deve ser aceito', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, cpf: '12345678901' });
      expect(result.success).toBe(true);
    });

    it('documento com 14 chars (formatado) → deve ser aceito', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, cpf: '123.456.789-01' });
      expect(result.success).toBe(true);
    });

    // ── phone ─────────────────────────────────────────────────────────────

    it('telefone muito curto → "Teléfono inválido"', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, phone: '12345' });
      const errors = getFieldErrors(result);
      expect(errors['phone']).toBe('Teléfono inválido');
      assertUserFriendly(errors['phone'], 'phone');
    });

    it('telefone muito longo → "Teléfono inválido"', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, phone: '1234567890123456' });
      const errors = getFieldErrors(result);
      expect(errors['phone']).toBe('Teléfono inválido');
      assertUserFriendly(errors['phone'], 'phone');
    });

    it('telefone vazio → "Teléfono inválido"', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, phone: '' });
      const errors = getFieldErrors(result);
      expect(errors['phone']).toBe('Teléfono inválido');
      assertUserFriendly(errors['phone'], 'phone');
    });

    // ── email ─────────────────────────────────────────────────────────────

    it('email inválido → "Correo electrónico inválido"', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, email: 'not-an-email' });
      const errors = getFieldErrors(result);
      expect(errors['email']).toBe('Correo electrónico inválido');
      assertUserFriendly(errors['email'], 'email');
    });

    it('email vazio → "Correo electrónico inválido"', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, email: '' });
      const errors = getFieldErrors(result);
      // Empty string is invalid email
      expect(errors['email']).toBeDefined();
      assertUserFriendly(errors['email'], 'email');
    });

    it('email sem @ → "Correo electrónico inválido"', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, email: 'userdomain.com' });
      const errors = getFieldErrors(result);
      expect(errors['email']).toBe('Correo electrónico inválido');
    });

    // ── birthDate ─────────────────────────────────────────────────────────

    it('data de nascimento vazia → mensagem amigável', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, birthDate: '' });
      const errors = getFieldErrors(result);
      expect(errors['birthDate']).toBe('La fecha de nacimiento es obligatoria');
      assertUserFriendly(errors['birthDate'], 'birthDate');
    });

    // ── sex ───────────────────────────────────────────────────────────────

    it('sexo não selecionado (string vazia) → mensagem pedindo para selecionar', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, sex: '' });
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.errors.map((e) => e.message);
        expect(messages).toContain('Por favor, seleccione el sexo');
      }
    });

    it('sexo com valor válido "male" → deve ser aceito', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, sex: 'male' });
      expect(result.success).toBe(true);
    });

    it('sexo com valor válido "female" → deve ser aceito', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, sex: 'female' });
      expect(result.success).toBe(true);
    });

    // ── gender ────────────────────────────────────────────────────────────

    it('gênero não selecionado (string vazia) → mensagem pedindo para selecionar', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, gender: '' });
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.errors.map((e) => e.message);
        expect(messages).toContain('Por favor, seleccione el género');
      }
    });

    it('gênero "other" → deve ser aceito', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, gender: 'other' });
      expect(result.success).toBe(true);
    });

    // ── professionalLicense ───────────────────────────────────────────────

    it('licença profissional vazia → mensagem amigável', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, professionalLicense: '' });
      const errors = getFieldErrors(result);
      expect(errors['professionalLicense']).toBe('El registro profesional es obligatorio');
      assertUserFriendly(errors['professionalLicense'], 'professionalLicense');
    });

    // ── languages ─────────────────────────────────────────────────────────

    it('nenhum idioma selecionado → mensagem pedindo para selecionar', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, languages: [] });
      const errors = getFieldErrors(result);
      expect(errors['languages']).toBe('Seleccione al menos un idioma');
      assertUserFriendly(errors['languages'], 'languages');
    });

    it('múltiplos idiomas válidos → deve ser aceito', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, languages: ['pt', 'es', 'en'] });
      expect(result.success).toBe(true);
    });

    // ── profession ────────────────────────────────────────────────────────

    it('profissão não selecionada (string vazia) → mensagem amigável', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, profession: '' });
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.errors.map((e) => e.message);
        expect(messages).toContain('Por favor, seleccione la profesión');
      }
    });

    it.each(['AT', 'CAREGIVER', 'NURSE', 'KINESIOLOGIST', 'PSYCHOLOGIST'] as const)(
      'profissão "%s" → deve ser aceita',
      (profession) => {
        const result = schema().safeParse({ ...VALID_GENERAL_INFO, profession });
        expect(result.success).toBe(true);
      },
    );

    // ── knowledgeLevel ────────────────────────────────────────────────────

    it('nível de conhecimento não selecionado → mensagem amigável', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, knowledgeLevel: '' });
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.errors.map((e) => e.message);
        expect(messages).toContain('Por favor, seleccione el nivel de estudios');
      }
    });

    it.each(['SECONDARY', 'TERTIARY', 'TECNICATURA', 'BACHELOR', 'POSTGRADUATE', 'MASTERS', 'DOCTORATE'] as const)(
      'nível "%s" → deve ser aceito',
      (knowledgeLevel) => {
        const result = schema().safeParse({ ...VALID_GENERAL_INFO, knowledgeLevel });
        expect(result.success).toBe(true);
      },
    );

    // ── experienceTypes ───────────────────────────────────────────────────

    it('nenhum tipo de experiência selecionado → mensagem amigável', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, experienceTypes: [] });
      const errors = getFieldErrors(result);
      expect(errors['experienceTypes']).toBe('Seleccione al menos un tipo de experiencia');
      assertUserFriendly(errors['experienceTypes'], 'experienceTypes');
    });

    // ── yearsExperience ───────────────────────────────────────────────────

    it('anos de experiência não selecionados → mensagem amigável', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, yearsExperience: '' });
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.errors.map((e) => e.message);
        expect(messages).toContain('Por favor, seleccione los años de experiencia');
      }
    });

    it.each(['0_2', '3_5', '6_10', '10_plus'] as const)(
      'experiência "%s" → deve ser aceita',
      (yearsExperience) => {
        const result = schema().safeParse({ ...VALID_GENERAL_INFO, yearsExperience });
        expect(result.success).toBe(true);
      },
    );

    // ── preferredTypes ────────────────────────────────────────────────────

    it('nenhum tipo preferido selecionado → mensagem amigável', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, preferredTypes: [] });
      const errors = getFieldErrors(result);
      expect(errors['preferredTypes']).toBe('Seleccione al menos un tipo preferido');
      assertUserFriendly(errors['preferredTypes'], 'preferredTypes');
    });

    // ── preferredAgeRange ─────────────────────────────────────────────────

    it('faixa etária não selecionada → mensagem amigável', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, preferredAgeRange: [] });
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.errors.map((e) => e.message);
        expect(messages).toContain('Por favor, seleccione el rango de edad preferido');
      }
    });

    it.each(['children', 'adolescents', 'adults', 'elderly'] as const)(
      'faixa "%s" → deve ser aceita',
      (preferredAgeRange) => {
        const result = schema().safeParse({ ...VALID_GENERAL_INFO, preferredAgeRange: [preferredAgeRange] });
        expect(result.success).toBe(true);
      },
    );

    // ── Verificação global: NENHUMA mensagem técnica do Zod ───────────────

    it('formulário totalmente vazio → todas as mensagens devem ser amigáveis (não técnicas)', () => {
      const emptyData = {
        profilePhoto: null,
        fullName: '',
        lastName: '',
        cpf: '',
        phone: '',
        email: '',
        birthDate: '',
        sex: '',
        gender: '',
        documentType: 'CUIL_CUIT',
        professionalLicense: '',
        languages: [],
        profession: '',
        knowledgeLevel: '',
        experienceTypes: [],
        yearsExperience: '',
        preferredTypes: [],
        preferredAgeRange: [],
      };

      const result = schema().safeParse(emptyData);
      expect(result.success).toBe(false);
      if (!result.success) {
        for (const error of result.error.errors) {
          const fieldPath = error.path.join('.');
          assertUserFriendly(error.message, fieldPath || 'root');
        }
      }
    });
  });

  describe('Aba: Dirección de Servicio', () => {
    const schema = () => createServiceAddressSchema();

    it('endereço vazio → "La dirección es obligatoria"', () => {
      const result = schema().safeParse({ ...VALID_SERVICE_ADDRESS, address: '' });
      const errors = getFieldErrors(result);
      expect(errors['address']).toBe('La dirección es obligatoria');
      assertUserFriendly(errors['address'], 'address');
    });

    it('raio de atendimento 0 → mensagem amigável', () => {
      const result = schema().safeParse({ ...VALID_SERVICE_ADDRESS, serviceRadius: 0 });
      const errors = getFieldErrors(result);
      expect(errors['serviceRadius']).toBe('El radio de atención debe ser al menos 1 km');
      assertUserFriendly(errors['serviceRadius'], 'serviceRadius');
    });

    it('raio negativo → mensagem amigável', () => {
      const result = schema().safeParse({ ...VALID_SERVICE_ADDRESS, serviceRadius: -5 });
      const errors = getFieldErrors(result);
      expect(errors['serviceRadius']).toBe('El radio de atención debe ser al menos 1 km');
      assertUserFriendly(errors['serviceRadius'], 'serviceRadius');
    });

    it('complemento é opcional → aceito sem complemento', () => {
      const { complement: _, ...withoutComplement } = VALID_SERVICE_ADDRESS;
      const result = schema().safeParse(withoutComplement);
      expect(result.success).toBe(true);
    });

    it('aceita atendimento remoto true/false', () => {
      expect(schema().safeParse({ ...VALID_SERVICE_ADDRESS, acceptsRemoteService: true }).success).toBe(true);
      expect(schema().safeParse({ ...VALID_SERVICE_ADDRESS, acceptsRemoteService: false }).success).toBe(true);
    });
  });

  describe('Aba: Disponibilidad', () => {
    const schema = () => createAvailabilitySchema();

    it('nenhum dia selecionado → mensagem amigável', () => {
      const result = schema().safeParse({
        schedule: [
          { day: 'Domingo', enabled: false, timeSlots: [] },
          { day: 'Lunes', enabled: false, timeSlots: [] },
        ],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.errors.map((e) => e.message);
        expect(messages).toContain('Seleccione al menos un día con horarios disponibles');
        for (const err of result.error.errors) {
          assertUserFriendly(err.message, 'schedule');
        }
      }
    });

    it('dia habilitado sem horários → mensagem amigável', () => {
      const result = schema().safeParse({
        schedule: [
          { day: 'Lunes', enabled: true, timeSlots: [] },
        ],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        for (const err of result.error.errors) {
          assertUserFriendly(err.message, 'schedule');
        }
      }
    });

    it('dia com horário válido → deve ser aceito', () => {
      const result = schema().safeParse({
        schedule: [
          { day: 'Lunes', enabled: true, timeSlots: [{ startTime: '09:00', endTime: '17:00' }] },
        ],
      });
      expect(result.success).toBe(true);
    });
  });

  describe('Aba: Horários (TimeSlot)', () => {
    const schema = () => createTimeSlotSchema();

    it('horário de início inválido → "Horario inválido"', () => {
      const result = schema().safeParse({ startTime: '25:00', endTime: '17:00' });
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.errors.map((e) => e.message);
        expect(messages).toContain('Horario inválido');
        for (const err of result.error.errors) {
          assertUserFriendly(err.message, 'timeSlot');
        }
      }
    });

    it('horário de fim inválido → "Horario inválido"', () => {
      const result = schema().safeParse({ startTime: '09:00', endTime: '25:00' });
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.errors.map((e) => e.message);
        expect(messages).toContain('Horario inválido');
      }
    });

    it('fim antes do início → mensagem amigável sobre ordem', () => {
      const result = schema().safeParse({ startTime: '17:00', endTime: '09:00' });
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.errors.map((e) => e.message);
        expect(messages).toContain('El horario de fin debe ser después del horario de inicio');
        for (const err of result.error.errors) {
          assertUserFriendly(err.message, 'timeSlot');
        }
      }
    });

    it('horários iguais → deve rejeitar', () => {
      const result = schema().safeParse({ startTime: '09:00', endTime: '09:00' });
      expect(result.success).toBe(false);
    });

    it('minutos inválidos (60) → deve rejeitar', () => {
      const result = schema().safeParse({ startTime: '09:60', endTime: '17:00' });
      expect(result.success).toBe(false);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// TESTES EM PORTUGUÊS (PT-BR)
// ═══════════════════════════════════════════════════════════════════════════

describe('Mensagens de erro — Português (PT-BR)', () => {
  beforeAll(() => {
    i18n.changeLanguage('pt-BR');
  });

  describe('Aba: Informações Gerais', () => {
    const schema = () => createGeneralInfoSchema();

    it('fullName vazio → "Nome completo deve ter pelo menos 3 caracteres"', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, fullName: '' });
      const errors = getFieldErrors(result);
      expect(errors['fullName']).toBe('Nome completo deve ter pelo menos 3 caracteres');
      assertUserFriendly(errors['fullName'], 'fullName');
    });

    it('lastName vazio → "Sobrenome é obrigatório"', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, lastName: '' });
      const errors = getFieldErrors(result);
      expect(errors['lastName']).toBe('Sobrenome é obrigatório');
      assertUserFriendly(errors['lastName'], 'lastName');
    });

    it('documento curto → "Documento inválido"', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, cpf: '123' });
      const errors = getFieldErrors(result);
      expect(errors['cpf']).toBe('Documento inválido');
      assertUserFriendly(errors['cpf'], 'cpf');
    });

    it('telefone curto → "Telefone inválido"', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, phone: '12345' });
      const errors = getFieldErrors(result);
      expect(errors['phone']).toBe('Telefone inválido');
      assertUserFriendly(errors['phone'], 'phone');
    });

    it('email inválido → "E-mail inválido"', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, email: 'abc' });
      const errors = getFieldErrors(result);
      expect(errors['email']).toBe('E-mail inválido');
      assertUserFriendly(errors['email'], 'email');
    });

    it('data de nascimento vazia → "Data de nascimento é obrigatória"', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, birthDate: '' });
      const errors = getFieldErrors(result);
      expect(errors['birthDate']).toBe('Data de nascimento é obrigatória');
      assertUserFriendly(errors['birthDate'], 'birthDate');
    });

    it('sexo não selecionado → "Por favor, selecione o sexo"', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, sex: '' });
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.errors.map((e) => e.message);
        expect(messages).toContain('Por favor, selecione o sexo');
      }
    });

    it('gênero não selecionado → "Por favor, selecione o gênero"', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, gender: '' });
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.errors.map((e) => e.message);
        expect(messages).toContain('Por favor, selecione o gênero');
      }
    });

    it('licença vazia → "Registro profissional é obrigatório"', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, professionalLicense: '' });
      const errors = getFieldErrors(result);
      expect(errors['professionalLicense']).toBe('Registro profissional é obrigatório');
      assertUserFriendly(errors['professionalLicense'], 'professionalLicense');
    });

    it('nenhum idioma → "Selecione pelo menos um idioma"', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, languages: [] });
      const errors = getFieldErrors(result);
      expect(errors['languages']).toBe('Selecione pelo menos um idioma');
      assertUserFriendly(errors['languages'], 'languages');
    });

    it('profissão não selecionada → "Por favor, selecione a profissão"', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, profession: '' });
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.errors.map((e) => e.message);
        expect(messages).toContain('Por favor, selecione a profissão');
      }
    });

    it('nível de conhecimento não selecionado → "Por favor, selecione o nível de estudos"', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, knowledgeLevel: '' });
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.errors.map((e) => e.message);
        expect(messages).toContain('Por favor, selecione o nível de estudos');
      }
    });

    it('nenhum tipo de experiência → "Selecione pelo menos um tipo de experiência"', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, experienceTypes: [] });
      const errors = getFieldErrors(result);
      expect(errors['experienceTypes']).toBe('Selecione pelo menos um tipo de experiência');
      assertUserFriendly(errors['experienceTypes'], 'experienceTypes');
    });

    it('anos de experiência não selecionados → "Por favor, selecione os anos de experiência"', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, yearsExperience: '' });
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.errors.map((e) => e.message);
        expect(messages).toContain('Por favor, selecione os anos de experiência');
      }
    });

    it('nenhum tipo preferido → "Selecione pelo menos um tipo preferido"', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, preferredTypes: [] });
      const errors = getFieldErrors(result);
      expect(errors['preferredTypes']).toBe('Selecione pelo menos um tipo preferido');
      assertUserFriendly(errors['preferredTypes'], 'preferredTypes');
    });

    it('faixa etária não selecionada → "Por favor, selecione a faixa etária preferida"', () => {
      const result = schema().safeParse({ ...VALID_GENERAL_INFO, preferredAgeRange: [] });
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.errors.map((e) => e.message);
        expect(messages).toContain('Por favor, selecione a faixa etária preferida');
      }
    });

    // ── Verificação global: NENHUMA mensagem técnica do Zod em PT-BR ─────

    it('formulário totalmente vazio → todas as mensagens em PT-BR devem ser amigáveis', () => {
      const emptyData = {
        profilePhoto: null,
        fullName: '',
        lastName: '',
        cpf: '',
        phone: '',
        email: '',
        birthDate: '',
        sex: '',
        gender: '',
        documentType: 'CUIL_CUIT',
        professionalLicense: '',
        languages: [],
        profession: '',
        knowledgeLevel: '',
        experienceTypes: [],
        yearsExperience: '',
        preferredTypes: [],
        preferredAgeRange: [],
      };

      const result = schema().safeParse(emptyData);
      expect(result.success).toBe(false);
      if (!result.success) {
        for (const error of result.error.errors) {
          const fieldPath = error.path.join('.');
          assertUserFriendly(error.message, fieldPath || 'root');
        }
      }
    });
  });

  describe('Aba: Endereço de Atendimento', () => {
    const schema = () => createServiceAddressSchema();

    it('endereço vazio → "Endereço é obrigatório"', () => {
      const result = schema().safeParse({ ...VALID_SERVICE_ADDRESS, address: '' });
      const errors = getFieldErrors(result);
      expect(errors['address']).toBe('Endereço é obrigatório');
      assertUserFriendly(errors['address'], 'address');
    });

    it('raio 0 → "Raio de atendimento deve ser pelo menos 1km"', () => {
      const result = schema().safeParse({ ...VALID_SERVICE_ADDRESS, serviceRadius: 0 });
      const errors = getFieldErrors(result);
      expect(errors['serviceRadius']).toBe('Raio de atendimento deve ser pelo menos 1km');
      assertUserFriendly(errors['serviceRadius'], 'serviceRadius');
    });
  });

  describe('Aba: Disponibilidade', () => {
    const schema = () => createAvailabilitySchema();

    it('nenhum dia → "Selecione pelo menos um dia com horários disponíveis"', () => {
      const result = schema().safeParse({
        schedule: [{ day: 'Domingo', enabled: false, timeSlots: [] }],
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.errors.map((e) => e.message);
        expect(messages).toContain('Selecione pelo menos um dia com horários disponíveis');
      }
    });
  });

  describe('Aba: Horários (TimeSlot)', () => {
    const schema = () => createTimeSlotSchema();

    it('horário inválido → "Horário inválido"', () => {
      const result = schema().safeParse({ startTime: '25:00', endTime: '17:00' });
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.errors.map((e) => e.message);
        expect(messages).toContain('Horário inválido');
      }
    });

    it('fim antes do início → "Horário de término deve ser depois do horário de início"', () => {
      const result = schema().safeParse({ startTime: '17:00', endTime: '09:00' });
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.errors.map((e) => e.message);
        expect(messages).toContain('Horário de término deve ser depois do horário de início');
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUDITORIA: Mensagens técnicas do Zod que NÃO devem vazar
// ═══════════════════════════════════════════════════════════════════════════

describe('Auditoria: nenhuma mensagem técnica do Zod deve vazar para o usuário', () => {
  beforeAll(() => {
    i18n.changeLanguage('es');
  });

  /**
   * Testa cenários extremos onde o tipo de dado está completamente errado
   * (ex: number onde espera string). Se o Zod vaza mensagens técnicas
   * como "Expected string, received number", o teste falha.
   */

  it('campo de texto recebendo undefined → não deve mostrar "Required"', () => {
    const schema = createGeneralInfoSchema();
    const data = { ...VALID_GENERAL_INFO };
    delete (data as Record<string, unknown>).fullName;
    const result = schema.safeParse(data);
    if (!result.success) {
      for (const err of result.error.errors) {
        expect(err.message, `Zod "Required" vazou no campo ${err.path.join('.')}`).not.toBe('Required');
      }
    }
  });

  it('campo sex recebendo valor inválido (não-enum, não-vazio) → mensagem não-técnica', () => {
    const schema = createGeneralInfoSchema();
    const result = schema.safeParse({ ...VALID_GENERAL_INFO, sex: 'unknown_value' });
    if (!result.success) {
      for (const err of result.error.errors) {
        assertUserFriendly(err.message, err.path.join('.'));
      }
    }
  });

  it('campo profession recebendo valor inválido → mensagem não-técnica', () => {
    const schema = createGeneralInfoSchema();
    const result = schema.safeParse({ ...VALID_GENERAL_INFO, profession: 'INVALID_PROFESSION' });
    if (!result.success) {
      for (const err of result.error.errors) {
        assertUserFriendly(err.message, err.path.join('.'));
      }
    }
  });

  it('campo knowledgeLevel recebendo valor inválido → mensagem não-técnica', () => {
    const schema = createGeneralInfoSchema();
    const result = schema.safeParse({ ...VALID_GENERAL_INFO, knowledgeLevel: 'PHD' });
    if (!result.success) {
      for (const err of result.error.errors) {
        assertUserFriendly(err.message, err.path.join('.'));
      }
    }
  });

  it('campo yearsExperience recebendo valor inválido → mensagem não-técnica', () => {
    const schema = createGeneralInfoSchema();
    const result = schema.safeParse({ ...VALID_GENERAL_INFO, yearsExperience: '20_plus' });
    if (!result.success) {
      for (const err of result.error.errors) {
        assertUserFriendly(err.message, err.path.join('.'));
      }
    }
  });

  it('campo preferredAgeRange recebendo valor inválido → mensagem não-técnica', () => {
    const schema = createGeneralInfoSchema();
    const result = schema.safeParse({ ...VALID_GENERAL_INFO, preferredAgeRange: ['babies'] });
    if (!result.success) {
      for (const err of result.error.errors) {
        assertUserFriendly(err.message, err.path.join('.'));
      }
    }
  });

  it('campo gender recebendo valor inválido → mensagem não-técnica', () => {
    const schema = createGeneralInfoSchema();
    const result = schema.safeParse({ ...VALID_GENERAL_INFO, gender: 'nonbinary' });
    if (!result.success) {
      for (const err of result.error.errors) {
        assertUserFriendly(err.message, err.path.join('.'));
      }
    }
  });

  it('campo languages com valor inválido no array → mensagem não-técnica', () => {
    const schema = createGeneralInfoSchema();
    const result = schema.safeParse({ ...VALID_GENERAL_INFO, languages: ['fr'] });
    if (!result.success) {
      for (const err of result.error.errors) {
        assertUserFriendly(err.message, err.path.join('.'));
      }
    }
  });

  it('campo experienceTypes com valor inválido → mensagem não-técnica', () => {
    const schema = createGeneralInfoSchema();
    const result = schema.safeParse({ ...VALID_GENERAL_INFO, experienceTypes: ['cancer'] });
    if (!result.success) {
      for (const err of result.error.errors) {
        assertUserFriendly(err.message, err.path.join('.'));
      }
    }
  });

  it('campo serviceRadius recebendo string → mensagem não-técnica', () => {
    const schema = createServiceAddressSchema();
    const result = schema.safeParse({ ...VALID_SERVICE_ADDRESS, serviceRadius: 'ten' as unknown as number });
    if (!result.success) {
      for (const err of result.error.errors) {
        assertUserFriendly(err.message, err.path.join('.'));
      }
    }
  });
});
