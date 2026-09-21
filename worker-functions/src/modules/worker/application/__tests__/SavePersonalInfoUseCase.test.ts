import { SavePersonalInfoUseCase } from '../SavePersonalInfoUseCase';
import { Result } from '@shared/utils/Result';
import type { PubSubClient } from '@shared/events/PubSubClient';

const mockWorker = {
  id: 'worker-123',
  authUid: 'auth-123',
  email: 'test@example.com',
  currentStep: 1,
  status: 'INCOMPLETE_REGISTER',
  country: 'AR',
  timezone: 'UTC',
  registrationCompleted: false,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockUpdatedWorker = {
  ...mockWorker,
  firstNameEncrypted: 'enc-firstName',
  lastNameEncrypted: 'enc-lastName',
  profession: 'CAREGIVER',
};

const makeRepository = (overrides = {}) => ({
  findById: jest.fn().mockResolvedValue(Result.ok(mockWorker)),
  updatePersonalInfo: jest.fn().mockResolvedValue(Result.ok(mockUpdatedWorker)),
  updateStep: jest.fn().mockResolvedValue(Result.ok({ ...mockWorker, currentStep: 3 })),
  findByAuthUid: jest.fn(),
  findByEmail: jest.fn(),
  create: jest.fn(),
  updateStatus: jest.fn(),
  updateAuthUid: jest.fn(),
  findByPhone: jest.fn(),
  findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(null)),
  delete: jest.fn(),
  deleteByAuthUid: jest.fn(),
  recalculateStatus: jest.fn().mockResolvedValue(null),
  ...overrides,
});

const personalInfoPayload = {
  workerId: 'worker-123',
  firstName: 'Gabriel',
  lastName: 'Stein',
  sex: 'male',
  gender: 'male',
  birthDate: '1990-04-18',
  documentType: 'DNI',
  documentNumber: '12345678',
  phone: '+5411999999',
  languages: ['pt', 'es'],
  profession: 'CAREGIVER',
  knowledgeLevel: 'SECONDARY',
  titleCertificate: 'Cert XYZ',
  experienceTypes: ['adicciones'],
  yearsExperience: '3_5',
  preferredTypes: ['adicciones'],
  preferredAgeRange: ['adolescents'],
  termsAccepted: true,
  privacyAccepted: true,
};

describe('SavePersonalInfoUseCase', () => {
  describe('sucesso', () => {
    it('deve salvar informações pessoais e retornar o worker atualizado', async () => {
      const repo = makeRepository();
      const useCase = new SavePersonalInfoUseCase(repo as any);

      const result = await useCase.execute(personalInfoPayload);

      expect(result.isFailure).toBe(false);
      expect(repo.findById).toHaveBeenCalledWith('worker-123');
      expect(repo.updatePersonalInfo).toHaveBeenCalledWith(
        expect.objectContaining({
          workerId: 'worker-123',
          firstName: 'Gabriel',
          lastName: 'Stein',
          profession: 'CAREGIVER',
        })
      );
    });

    it('NÃO deve chamar updateStep — sem avanço de step na edição por abas', async () => {
      const repo = makeRepository();
      const useCase = new SavePersonalInfoUseCase(repo as any);

      await useCase.execute(personalInfoPayload);

      expect(repo.updateStep).not.toHaveBeenCalled();
    });

    it('deve aceitar profilePhotoUrl opcional', async () => {
      const repo = makeRepository();
      const useCase = new SavePersonalInfoUseCase(repo as any);

      const result = await useCase.execute({
        ...personalInfoPayload,
        profilePhotoUrl: 'https://example.com/photo.jpg',
      });

      expect(result.isFailure).toBe(false);
      expect(repo.updatePersonalInfo).toHaveBeenCalledWith(
        expect.objectContaining({ profilePhotoUrl: 'https://example.com/photo.jpg' })
      );
    });

    it('deve funcionar sem profilePhotoUrl', async () => {
      const repo = makeRepository();
      const useCase = new SavePersonalInfoUseCase(repo as any);

      const result = await useCase.execute(personalInfoPayload);

      expect(result.isFailure).toBe(false);
    });
  });

  // Defeito 1 (21/09/2026, autorizado pelo Gabriel): a rota PUT /api/workers/me/general-info
  // (saveGeneralInfo → este use case) não validava `birthDate` — qualquer string era
  // encriptada e gravada. Front mandava lixo tipo "25/31/985" quando a máscara via menos
  // de 8 dígitos (defeito espelhado no frontend, useMask.ts). Este bloco prova o 400 no
  // mesmo padrão de erro já usado pela API (Result.fail → sendPersonalInfoFailure → 400).
  describe('birthDate inválido (defeito 1)', () => {
    it.each([
      ['25/31/985', 'agrupamento quebrado (não-ISO)'],
      ['1985-13-10', 'mês inexistente'],
      ['1985-02-30', 'dia inexistente no mês'],
      ['1899-01-01', 'ano implausível (< 1900)'],
      ['not-a-date', 'lixo arbitrário'],
      ['1990/01/01', 'separador errado'],
    ])('rejeita "%s" (%s) com Result.fail, sem chamar updatePersonalInfo', async (badBirthDate) => {
      const repo = makeRepository();
      const useCase = new SavePersonalInfoUseCase(repo as any);

      const result = await useCase.execute({ ...personalInfoPayload, birthDate: badBirthDate });

      expect(result.isFailure).toBe(true);
      expect(repo.updatePersonalInfo).not.toHaveBeenCalled();
    });

    it('rejeita data futura', async () => {
      const repo = makeRepository();
      const useCase = new SavePersonalInfoUseCase(repo as any);
      const futureYear = new Date().getUTCFullYear() + 1;

      const result = await useCase.execute({ ...personalInfoPayload, birthDate: `${futureYear}-01-01` });

      expect(result.isFailure).toBe(true);
      expect(repo.updatePersonalInfo).not.toHaveBeenCalled();
    });

    it('aceita ISO YYYY-MM-DD real e passada', async () => {
      const repo = makeRepository();
      const useCase = new SavePersonalInfoUseCase(repo as any);

      const result = await useCase.execute({ ...personalInfoPayload, birthDate: '1990-04-18' });

      expect(result.isFailure).toBe(false);
      expect(repo.updatePersonalInfo).toHaveBeenCalledWith(
        expect.objectContaining({ birthDate: '1990-04-18' }),
      );
    });

    it('birthDate vazio/ausente não é validado (preserva a semântica de "mantém o atual" via COALESCE)', async () => {
      const repo = makeRepository();
      const useCase = new SavePersonalInfoUseCase(repo as any);

      const result = await useCase.execute({ ...personalInfoPayload, birthDate: '' });

      expect(result.isFailure).toBe(false);
      expect(repo.updatePersonalInfo).toHaveBeenCalled();
    });
  });

  describe('worker não encontrado', () => {
    it('deve falhar se worker não existe', async () => {
      const repo = makeRepository({
        findById: jest.fn().mockResolvedValue(Result.ok(null)),
      });
      const useCase = new SavePersonalInfoUseCase(repo as any);

      const result = await useCase.execute(personalInfoPayload);

      expect(result.isFailure).toBe(true);
      expect(result.error).toBe('Worker not found');
      expect(repo.updatePersonalInfo).not.toHaveBeenCalled();
    });

    it('deve falhar se findById retorna erro', async () => {
      const repo = makeRepository({
        findById: jest.fn().mockResolvedValue(Result.fail('DB connection error')),
      });
      const useCase = new SavePersonalInfoUseCase(repo as any);

      const result = await useCase.execute(personalInfoPayload);

      expect(result.isFailure).toBe(true);
      expect(result.error).toBe('DB connection error');
    });
  });

  describe('falha no updatePersonalInfo', () => {
    it('deve propagar erro do repositório', async () => {
      const repo = makeRepository({
        updatePersonalInfo: jest.fn().mockResolvedValue(
          Result.fail('Failed to update personal info: Failed to encrypt data')
        ),
      });
      const useCase = new SavePersonalInfoUseCase(repo as any);

      const result = await useCase.execute(personalInfoPayload);

      expect(result.isFailure).toBe(true);
      expect(result.error).toContain('Failed to encrypt data');
      expect(repo.updateStep).not.toHaveBeenCalled();
    });
  });

  describe('telefone — normalização e colisão', () => {
    it('grava o telefone NORMALIZADO (canônico) quando há troca para número livre', async () => {
      // worker sem phone atual + número livre → grava canônico.
      const repo = makeRepository();
      const useCase = new SavePersonalInfoUseCase(repo as any);

      // '1151265663' (10 díg) → '5491151265663'
      await useCase.execute({ ...personalInfoPayload, phone: '1151265663' });

      expect(repo.findByPhoneCandidates).toHaveBeenCalled();
      expect(repo.updatePersonalInfo).toHaveBeenCalledWith(
        expect.objectContaining({ phone: '5491151265663' }),
      );
    });

    it('NÃO altera o telefone (passa vazio) quando o número não mudou, mesmo em formato diferente', async () => {
      // worker já tem '1151265663'; reenvio em formato canônico = mesmo número.
      const repo = makeRepository({
        findById: jest.fn().mockResolvedValue(Result.ok({ ...mockWorker, phone: '1151265663' })),
      });
      const useCase = new SavePersonalInfoUseCase(repo as any);

      await useCase.execute({ ...personalInfoPayload, phone: '+5491151265663' });

      // phone vazio → repo mantém o atual via COALESCE; não checa colisão.
      expect(repo.findByPhoneCandidates).not.toHaveBeenCalled();
      expect(repo.updatePersonalInfo).toHaveBeenCalledWith(
        expect.objectContaining({ phone: '' }),
      );
    });

    it('falha com PHONE_NOT_AVAILABLE quando o número pertence a OUTRO worker', async () => {
      const repo = makeRepository({
        findById: jest.fn().mockResolvedValue(Result.ok({ ...mockWorker, phone: '1100000000' })),
        findByPhoneCandidates: jest
          .fn()
          .mockResolvedValue(Result.ok({ ...mockWorker, id: 'outro-worker-999' })),
      });
      const useCase = new SavePersonalInfoUseCase(repo as any);

      const result = await useCase.execute({ ...personalInfoPayload, phone: '1151265663' });

      expect(result.isFailure).toBe(true);
      expect(result.error).toBe('PHONE_NOT_AVAILABLE');
      expect(repo.updatePersonalInfo).not.toHaveBeenCalled();
    });

    it('NÃO bloqueia quando o número "de outro" é na verdade o próprio worker', async () => {
      const repo = makeRepository({
        findById: jest.fn().mockResolvedValue(Result.ok({ ...mockWorker, phone: '1100000000' })),
        findByPhoneCandidates: jest
          .fn()
          .mockResolvedValue(Result.ok({ ...mockWorker, id: 'worker-123' })),
      });
      const useCase = new SavePersonalInfoUseCase(repo as any);

      const result = await useCase.execute({ ...personalInfoPayload, phone: '1151265663' });

      expect(result.isFailure).toBe(false);
      expect(repo.updatePersonalInfo).toHaveBeenCalledWith(
        expect.objectContaining({ phone: '5491151265663' }),
      );
    });
  });

  describe('mirror event — enqueue + publish', () => {
    function makePool(rows: Array<{ id: string }> = [{ id: 'evt-sp-1' }]) {
      return {
        query: jest.fn().mockResolvedValue({ rows }),
      };
    }

    function makePubsub(): jest.Mocked<Pick<PubSubClient, 'publish'>> {
      return { publish: jest.fn().mockResolvedValue('msg-1') };
    }

    it('enqueues mirror event and publishes on successful save', async () => {
      const repo = makeRepository();
      const pool = makePool();
      const pubsub = makePubsub();
      const useCase = new SavePersonalInfoUseCase(repo as any, pool as any, pubsub as unknown as PubSubClient);

      const result = await useCase.execute(personalInfoPayload);

      expect(result.isFailure).toBe(false);
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO domain_events'),
        expect.arrayContaining(['worker.mirror_requested']),
      );
      expect(pubsub.publish).toHaveBeenCalledWith('worker-mirror-requested', { eventId: 'evt-sp-1' });
    });

    it('does NOT publish when pubsub not injected (no pool in scope)', async () => {
      // Pool not injected — enqueueMirrorEvent catches DB error best-effort.
      const repo = makeRepository();
      const pubsub = makePubsub();
      // Construct without pool; pubsub is 3rd arg but pool is 2nd — omit pool
      const useCase = new SavePersonalInfoUseCase(repo as any, undefined, pubsub as unknown as PubSubClient);

      // Should not throw even if DB is unavailable
      const result = await useCase.execute(personalInfoPayload);
      expect(result.isFailure).toBe(false);
    });
  });

  describe('trilha de fonte worker_self (self deixou de ser cego — D92)', () => {
    // Linha crua do captureWorkerBefore com o MESMO estado do payload.
    // KMS em testMode (NODE_ENV=test) decripta com base64-decode — as colunas
    // *_encrypted do fixture precisam estar em base64.
    const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
    const beforeRowIdentico = {
      email: 'test@example.com',
      document_type: 'DNI',
      profession: 'CAREGIVER',
      occupation: null,
      knowledge_level: 'SECONDARY',
      title_certificate: 'Cert XYZ',
      years_experience: '3_5',
      experience_types: ['adicciones'],
      preferred_types: ['adicciones'],
      preferred_age_range: ['adolescents'],
      first_name_encrypted: b64('Gabriel'),
      last_name_encrypted: b64('Stein'),
      birth_date_encrypted: b64('1990-04-18'),
      document_number_encrypted: b64('12345678'),
      languages_encrypted: b64('["pt","es"]'),
      linkedin_url_encrypted: null,
    };

    function makePool(beforeRow: Record<string, unknown> = {}) {
      return {
        query: jest.fn().mockImplementation((sql: string) => {
          if (String(sql).startsWith('SELECT email')) return Promise.resolve({ rows: [beforeRow] });
          return Promise.resolve({ rows: [{ id: 'evt-1' }] });
        }),
      };
    }

    function auditCall(pool: { query: jest.Mock }) {
      return pool.query.mock.calls.find(([sql]: [string]) =>
        String(sql).includes('worker_profile_changes_audit'),
      );
    }

    it('grava o audit com changed_by=worker_self e valores REDIGIDOS', async () => {
      const repo = makeRepository();
      const pool = makePool(); // snapshot vazio → tudo é edição nova
      const useCase = new SavePersonalInfoUseCase(repo as any, pool as any);

      await useCase.execute(personalInfoPayload);

      const call = auditCall(pool);
      expect(call).toBeDefined();
      const values = call![1] as unknown[];
      // changed_by/source em toda linha
      expect(values).toContain('worker_self');
      expect(values).toContain('platform');
      // documento redigido last-4, nome mascarado — nunca o valor cru
      expect(values).toContain('***5678');
      expect(values).not.toContain('Gabriel');
      expect(values).not.toContain('12345678');
      // campo profissional plaintext passa legível
      expect(values).toContain('CAREGIVER');
    });

    it('só audita campos que MUDARAM (wizard reenvia o form inteiro)', async () => {
      const repo = makeRepository();
      const pool = makePool(beforeRowIdentico);
      const useCase = new SavePersonalInfoUseCase(repo as any, pool as any);

      // round-trip idêntico → nenhuma linha de audit
      await useCase.execute(personalInfoPayload);
      expect(auditCall(pool)).toBeUndefined();

      // muda SÓ a profissão → o audit sai com exatamente 1 linha (8 valores)
      pool.query.mockClear();
      await useCase.execute({ ...personalInfoPayload, profession: 'AT' });
      const call = auditCall(pool);
      expect(call).toBeDefined();
      expect((call![1] as unknown[]).length).toBe(8);
      expect(call![1]).toEqual(
        expect.arrayContaining(['profession', 'CAREGIVER', 'AT', 'worker_self']),
      );
    });

    it('falha do audit NÃO derruba o save (best-effort)', async () => {
      const repo = makeRepository();
      const pool = {
        query: jest.fn().mockImplementation((sql: string) => {
          if (String(sql).includes('worker_profile_changes_audit')) {
            return Promise.reject(new Error('db down'));
          }
          if (String(sql).startsWith('SELECT email')) return Promise.resolve({ rows: [{}] });
          return Promise.resolve({ rows: [{ id: 'evt-1' }] });
        }),
      };
      const useCase = new SavePersonalInfoUseCase(repo as any, pool as any);

      const result = await useCase.execute(personalInfoPayload);
      expect(result.isFailure).toBe(false);
    });
  });
});
