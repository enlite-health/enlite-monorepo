import { InitWorkerUseCase } from '../InitWorkerUseCase';
import { Result } from '@shared/utils/Result';
import { Worker } from '../../domain/Worker';

// ─── Dados de teste realistas ────────────────────────────────────────────────

const REAL_AUTH_UID = 'abc123XYZ789def';
const REAL_EMAIL = 'joana.silva@gmail.com';
const REAL_PHONE = '+5511998887766';
const WORKER_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';

const IMPORTED_AUTH_UID_ANACARE = 'anacareimport_+5411999887766';
const IMPORTED_AUTH_UID_CANDIDATO = 'candidatoimport_+5411999887766';
const IMPORTED_AUTH_UID_PRETALN = 'pretalnimport_+5411999887766';
const IMPORTED_AUTH_UID_BASE1 = 'base1import_5491528261243';
const IMPORTED_AUTH_UID_CLICKUP_ENCUADRE = 'clickup_encuadre_86abvef8g';

const mockWorker: Worker = {
  id: WORKER_ID,
  authUid: REAL_AUTH_UID,
  email: REAL_EMAIL,
  phone: REAL_PHONE,
  currentStep: 1,
  status: 'INCOMPLETE_REGISTER',
  country: 'BR',
  timezone: 'America/Sao_Paulo',
  registrationCompleted: false,
  createdAt: new Date('2024-06-01T10:00:00Z'),
  updatedAt: new Date('2024-06-01T10:00:00Z'),
};

// ─── Factories de mock ────────────────────────────────────────────────────────

const makeRepository = (overrides = {}) => ({
  findByAuthUid: jest.fn().mockResolvedValue(Result.ok(null)),
  findByEmail: jest.fn().mockResolvedValue(Result.ok(null)),
  findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(null)),
  create: jest.fn().mockResolvedValue(Result.ok(mockWorker)),
  updateAuthUid: jest.fn().mockResolvedValue(Result.ok(mockWorker)),
  updateImportedWorkerData: jest.fn().mockResolvedValue(Result.ok(mockWorker)),
  findById: jest.fn(),
  findByPhone: jest.fn(),
  updatePersonalInfo: jest.fn(),
  updateStep: jest.fn(),
  delete: jest.fn(),
  deleteByAuthUid: jest.fn(),
  ...overrides,
});

const makeEventDispatcher = () => ({
  notifyWorkerCreated: jest.fn().mockResolvedValue(undefined),
  notifyStepCompleted: jest.fn(),
  notifyStatusChanged: jest.fn(),
  notifyWorkerUpdated: jest.fn(),
  notifyWorkerDeleted: jest.fn(),
});

const makeTwilioVerify = (overrides = {}) => ({
  startVerification: jest.fn().mockResolvedValue({ verificationSid: 'VE_TEST_SID' }),
  checkVerification: jest.fn().mockResolvedValue({ valid: true, status: 'approved' }),
  ...overrides,
});

const makeCreateDTO = (overrides = {}) => ({
  authUid: REAL_AUTH_UID,
  email: REAL_EMAIL,
  phone: REAL_PHONE,
  country: 'BR',
  ...overrides,
});

// ─── Testes ───────────────────────────────────────────────────────────────────

describe('InitWorkerUseCase', () => {

  describe('Cenário 1 — Worker novo (nenhum registro existe)', () => {
    it('deve criar worker e retornar status ok com o worker criado', async () => {
      const repo = makeRepository();
      const dispatcher = makeEventDispatcher();
      const useCase = new InitWorkerUseCase(repo as any, dispatcher as any);

      const result = await useCase.execute(makeCreateDTO());

      expect(result.isSuccess).toBe(true);
      const output = result.getValue();
      expect(output.status).toBe('ok');
      if (output.status === 'ok') {
        expect(output.worker).toEqual(mockWorker);
      }
    });

    it('deve chamar create com os dados corretos incluindo lgpdOptIn e whatsappPhone', async () => {
      const repo = makeRepository();
      const dispatcher = makeEventDispatcher();
      const useCase = new InitWorkerUseCase(repo as any, dispatcher as any);
      const dto = makeCreateDTO({ lgpdOptIn: true, whatsappPhone: '+5411234567890' });

      await useCase.execute(dto);

      expect(repo.create).toHaveBeenCalledWith({
        authUid: dto.authUid,
        email: dto.email,
        phone: dto.phone,
        whatsappPhone: '+5411234567890',
        lgpdOptIn: true,
        country: dto.country,
      });
    });

    it('deve chamar create com lgpdOptIn e whatsappPhone undefined quando não fornecidos', async () => {
      const repo = makeRepository();
      const dispatcher = makeEventDispatcher();
      const useCase = new InitWorkerUseCase(repo as any, dispatcher as any);
      const dto = makeCreateDTO();

      await useCase.execute(dto);

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          authUid: dto.authUid,
          email: dto.email,
          phone: dto.phone,
          lgpdOptIn: undefined,
          whatsappPhone: undefined,
          country: dto.country,
        })
      );
    });

    it('deve persistir lgpdOptIn=false quando enviado explicitamente como false', async () => {
      const repo = makeRepository();
      const dispatcher = makeEventDispatcher();
      const useCase = new InitWorkerUseCase(repo as any, dispatcher as any);

      await useCase.execute(makeCreateDTO({ lgpdOptIn: false }));

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ lgpdOptIn: false })
      );
    });
  });

  describe('Cenário 2 — AuthUid já existe (idempotência)', () => {
    it('deve retornar status ok com worker existente sem chamar create', async () => {
      const existingWorker = { ...mockWorker };
      const repo = makeRepository({
        findByAuthUid: jest.fn().mockResolvedValue(Result.ok(existingWorker)),
      });
      const dispatcher = makeEventDispatcher();
      const useCase = new InitWorkerUseCase(repo as any, dispatcher as any);

      const result = await useCase.execute(makeCreateDTO());

      expect(result.isSuccess).toBe(true);
      const output = result.getValue();
      expect(output.status).toBe('ok');
      if (output.status === 'ok') {
        expect(output.worker).toBe(existingWorker);
      }
      expect(repo.create).not.toHaveBeenCalled();
      expect(repo.findByEmail).not.toHaveBeenCalled();
    });

    it('não deve chamar notifyWorkerCreated quando authUid já existe', async () => {
      const repo = makeRepository({
        findByAuthUid: jest.fn().mockResolvedValue(Result.ok(mockWorker)),
      });
      const dispatcher = makeEventDispatcher();
      const useCase = new InitWorkerUseCase(repo as any, dispatcher as any);

      await useCase.execute(makeCreateDTO());

      expect(dispatcher.notifyWorkerCreated).not.toHaveBeenCalled();
    });
  });

  describe('Cenário 3 — Email existe com authUid diferente (reconexão Google Identity)', () => {
    const workerWithOldAuthUid: Worker = {
      ...mockWorker,
      authUid: 'oldAuthUidFromPreviousAccount',
      id: 'e3d4f5a6-7890-4b12-8c34-56d78e90f123',
    };

    it('deve chamar updateAuthUid com o id do worker existente e o novo authUid', async () => {
      const repo = makeRepository({
        findByAuthUid: jest.fn().mockResolvedValue(Result.ok(null)),
        findByEmail: jest.fn().mockResolvedValue(Result.ok(workerWithOldAuthUid)),
        updateAuthUid: jest.fn().mockResolvedValue(
          Result.ok({ ...workerWithOldAuthUid, authUid: REAL_AUTH_UID })
        ),
      });
      const dispatcher = makeEventDispatcher();
      const useCase = new InitWorkerUseCase(repo as any, dispatcher as any);

      const result = await useCase.execute(makeCreateDTO());

      expect(result.isSuccess).toBe(true);
      expect(repo.updateAuthUid).toHaveBeenCalledWith(
        workerWithOldAuthUid.id,
        REAL_AUTH_UID,
        undefined,
        undefined,
      );
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('deve retornar status ok com worker com authUid atualizado', async () => {
      const updatedWorker = { ...workerWithOldAuthUid, authUid: REAL_AUTH_UID };
      const repo = makeRepository({
        findByAuthUid: jest.fn().mockResolvedValue(Result.ok(null)),
        findByEmail: jest.fn().mockResolvedValue(Result.ok(workerWithOldAuthUid)),
        updateAuthUid: jest.fn().mockResolvedValue(Result.ok(updatedWorker)),
      });
      const dispatcher = makeEventDispatcher();
      const useCase = new InitWorkerUseCase(repo as any, dispatcher as any);

      const result = await useCase.execute(makeCreateDTO());

      const output = result.getValue();
      expect(output.status).toBe('ok');
      if (output.status === 'ok') {
        expect(output.worker.authUid).toBe(REAL_AUTH_UID);
      }
    });

    it('não deve chamar notifyWorkerCreated na reconexão por email', async () => {
      const repo = makeRepository({
        findByAuthUid: jest.fn().mockResolvedValue(Result.ok(null)),
        findByEmail: jest.fn().mockResolvedValue(Result.ok(workerWithOldAuthUid)),
        updateAuthUid: jest.fn().mockResolvedValue(Result.ok(workerWithOldAuthUid)),
      });
      const dispatcher = makeEventDispatcher();
      const useCase = new InitWorkerUseCase(repo as any, dispatcher as any);

      await useCase.execute(makeCreateDTO());

      expect(dispatcher.notifyWorkerCreated).not.toHaveBeenCalled();
    });

    it('deve passar consentAt quando lgpdOptIn=true na reconexão por email', async () => {
      const repo = makeRepository({
        findByAuthUid: jest.fn().mockResolvedValue(Result.ok(null)),
        findByEmail: jest.fn().mockResolvedValue(Result.ok(workerWithOldAuthUid)),
        updateAuthUid: jest.fn().mockResolvedValue(Result.ok(mockWorker)),
      });
      const dispatcher = makeEventDispatcher();
      const useCase = new InitWorkerUseCase(repo as any, dispatcher as any);

      await useCase.execute(makeCreateDTO({ lgpdOptIn: true }));

      const call = repo.updateAuthUid.mock.calls[0];
      expect(call[3]).toBeInstanceOf(Date);
    });

    it('NÃO deve passar consentAt quando lgpdOptIn=false na reconexão por email', async () => {
      const repo = makeRepository({
        findByAuthUid: jest.fn().mockResolvedValue(Result.ok(null)),
        findByEmail: jest.fn().mockResolvedValue(Result.ok(workerWithOldAuthUid)),
        updateAuthUid: jest.fn().mockResolvedValue(Result.ok(mockWorker)),
      });
      const dispatcher = makeEventDispatcher();
      const useCase = new InitWorkerUseCase(repo as any, dispatcher as any);

      await useCase.execute(makeCreateDTO({ lgpdOptIn: false }));

      const call = repo.updateAuthUid.mock.calls[0];
      expect(call[3]).toBeUndefined();
    });
  });

  describe('Cenário 4 — Email existe com mesmo authUid', () => {
    it('deve retornar status ok sem chamar updateAuthUid nem create', async () => {
      const existingWorker: Worker = { ...mockWorker };
      const repo = makeRepository({
        findByAuthUid: jest.fn().mockResolvedValue(Result.ok(null)),
        findByEmail: jest.fn().mockResolvedValue(Result.ok(existingWorker)),
      });
      const dispatcher = makeEventDispatcher();
      const useCase = new InitWorkerUseCase(repo as any, dispatcher as any);

      const result = await useCase.execute(makeCreateDTO());

      expect(result.isSuccess).toBe(true);
      const output = result.getValue();
      expect(output.status).toBe('ok');
      if (output.status === 'ok') {
        expect(output.worker).toBe(existingWorker);
      }
      expect(repo.updateAuthUid).not.toHaveBeenCalled();
      expect(repo.create).not.toHaveBeenCalled();
      expect(dispatcher.notifyWorkerCreated).not.toHaveBeenCalled();
    });
  });

  describe('Cenário 5 — Worker importado por telefone → claim_pending (OTP)', () => {
    const importedWorkerAnacare: Worker = {
      ...mockWorker,
      authUid: IMPORTED_AUTH_UID_ANACARE,
      email: 'importado@anacareimport.invalid',
      id: 'a1b2c3d4-1234-4abc-8def-9876543210ab',
    };

    const importedWorkerCandidato: Worker = {
      ...mockWorker,
      authUid: IMPORTED_AUTH_UID_CANDIDATO,
      email: 'importado@candidatoimport.invalid',
      id: 'b2c3d4e5-2345-4bcd-9ef0-0987654321bc',
    };

    const importedWorkerPretaln: Worker = {
      ...mockWorker,
      authUid: IMPORTED_AUTH_UID_PRETALN,
      email: 'importado@pretalnimport.invalid',
      id: 'c3d4e5f6-3456-4cde-a012-1098765432cd',
    };

    const importedWorkerBase1: Worker = {
      ...mockWorker,
      authUid: IMPORTED_AUTH_UID_BASE1,
      email: 'base1import_5491528261243@enlite.import',
      id: 'd4e5f6a7-4567-4def-b123-4321098765de',
    };

    const importedWorkerClickup: Worker = {
      ...mockWorker,
      authUid: IMPORTED_AUTH_UID_CLICKUP_ENCUADRE,
      email: 'clickup_encuadre_86abvef8g@enlite.import',
      id: 'e5f6a7b8-5678-4efg-c234-5432109876ef',
    };

    it.each([
      ['anacareimport_', importedWorkerAnacare],
      ['candidatoimport_', importedWorkerCandidato],
      ['pretalnimport_', importedWorkerPretaln],
      ['base1import_', importedWorkerBase1],
      ['clickup_encuadre_', importedWorkerClickup],
    ])(
      'deve retornar claim_pending quando authUid começa com %s',
      async (_, importedWorker) => {
        const twilio = makeTwilioVerify();
        const repo = makeRepository({
          findByAuthUid: jest.fn().mockResolvedValue(Result.ok(null)),
          findByEmail: jest.fn().mockResolvedValue(Result.ok(null)),
          findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(importedWorker)),
        });
        const dispatcher = makeEventDispatcher();
        const useCase = new InitWorkerUseCase(repo as any, dispatcher as any, twilio as any);

        const result = await useCase.execute(makeCreateDTO());

        expect(result.isSuccess).toBe(true);
        const output = result.getValue();
        expect(output.status).toBe('claim_pending');
        if (output.status === 'claim_pending') {
          expect(output.candidateWorkerId).toBe(importedWorker.id);
          expect(output.verificationSid).toBe('VE_TEST_SID');
          expect(output.phoneMasked).toBeTruthy();
        }
        // NÃO deve mutar o banco
        expect(repo.updateImportedWorkerData).not.toHaveBeenCalled();
        expect(repo.create).not.toHaveBeenCalled();
      }
    );

    it('deve chamar startVerification com o phone DA FICHA (anti-hijack)', async () => {
      const FICHA_PHONE = '+5491155261243';
      const importedWorker: Worker = {
        ...importedWorkerAnacare,
        phone: FICHA_PHONE,
      };
      const twilio = makeTwilioVerify();
      const repo = makeRepository({
        findByAuthUid: jest.fn().mockResolvedValue(Result.ok(null)),
        findByEmail: jest.fn().mockResolvedValue(Result.ok(null)),
        findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(importedWorker)),
      });
      const dispatcher = makeEventDispatcher();
      const useCase = new InitWorkerUseCase(repo as any, dispatcher as any, twilio as any);

      // Payload envia phone DIFERENTE da ficha
      await useCase.execute(makeCreateDTO({ phone: '+5411999887766' }));

      expect(twilio.startVerification).toHaveBeenCalledWith(FICHA_PHONE);
    });

    it('não deve chamar notifyWorkerCreated ao detectar candidato', async () => {
      const twilio = makeTwilioVerify();
      const repo = makeRepository({
        findByAuthUid: jest.fn().mockResolvedValue(Result.ok(null)),
        findByEmail: jest.fn().mockResolvedValue(Result.ok(null)),
        findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(importedWorkerAnacare)),
      });
      const dispatcher = makeEventDispatcher();
      const useCase = new InitWorkerUseCase(repo as any, dispatcher as any, twilio as any);

      await useCase.execute(makeCreateDTO());

      expect(dispatcher.notifyWorkerCreated).not.toHaveBeenCalled();
    });

    it('deve retornar fail quando Twilio Verify lança erro', async () => {
      const twilio = makeTwilioVerify({
        startVerification: jest.fn().mockRejectedValue(new Error('Twilio unavailable')),
      });
      const repo = makeRepository({
        findByAuthUid: jest.fn().mockResolvedValue(Result.ok(null)),
        findByEmail: jest.fn().mockResolvedValue(Result.ok(null)),
        findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(importedWorkerAnacare)),
      });
      const dispatcher = makeEventDispatcher();
      const useCase = new InitWorkerUseCase(repo as any, dispatcher as any, twilio as any);

      const result = await useCase.execute(makeCreateDTO());

      expect(result.isFailure).toBe(true);
      expect(result.error).toContain('TWILIO_ERROR');
    });

    it('sem twilioVerify injetado deve retornar claim_pending com sid sintético', async () => {
      const repo = makeRepository({
        findByAuthUid: jest.fn().mockResolvedValue(Result.ok(null)),
        findByEmail: jest.fn().mockResolvedValue(Result.ok(null)),
        findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(importedWorkerAnacare)),
      });
      const dispatcher = makeEventDispatcher();
      // Sem twilioVerify (undefined) — fallback para TWILIO_NOT_CONFIGURED
      const useCase = new InitWorkerUseCase(repo as any, dispatcher as any);

      const result = await useCase.execute(makeCreateDTO());

      expect(result.isSuccess).toBe(true);
      const output = result.getValue();
      expect(output.status).toBe('claim_pending');
      if (output.status === 'claim_pending') {
        expect(output.verificationSid).toBe('TWILIO_NOT_CONFIGURED');
      }
    });
  });

  describe('Cenário 6 — Worker por telefone mas NÃO importado (authUid real)', () => {
    it('não deve migrar — deve criar novo worker ignorando o existente por telefone', async () => {
      const realWorkerByPhone: Worker = {
        ...mockWorker,
        authUid: 'xyzAnotherRealUid999',
        email: 'outro.usuario@gmail.com',
        id: 'd4e5f6a7-4567-4def-b123-2109876543de',
      };
      const repo = makeRepository({
        findByAuthUid: jest.fn().mockResolvedValue(Result.ok(null)),
        findByEmail: jest.fn().mockResolvedValue(Result.ok(null)),
        findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(realWorkerByPhone)),
      });
      const dispatcher = makeEventDispatcher();
      const useCase = new InitWorkerUseCase(repo as any, dispatcher as any);

      await useCase.execute(makeCreateDTO());

      expect(repo.updateImportedWorkerData).not.toHaveBeenCalled();
      expect(repo.create).toHaveBeenCalled();
    });
  });

  describe('Cenário 6b — Regressão: prefixes talentum_ NÃO devem acionar claim', () => {
    it('worker com authUid talentum_abc123 que tem match de phone NÃO deve retornar claim_pending', async () => {
      const workerWithTalentumUid: Worker = {
        ...mockWorker,
        authUid: 'talentum_abc123',
        email: 'talentum_abc123@enlite.import',
        id: 'f6a7b8c9-6789-4fgh-d345-6543210987fg',
      };
      const repo = makeRepository({
        findByAuthUid: jest.fn().mockResolvedValue(Result.ok(null)),
        findByEmail: jest.fn().mockResolvedValue(Result.ok(null)),
        findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(workerWithTalentumUid)),
      });
      const dispatcher = makeEventDispatcher();
      const useCase = new InitWorkerUseCase(repo as any, dispatcher as any);

      await useCase.execute(makeCreateDTO());

      expect(repo.updateImportedWorkerData).not.toHaveBeenCalled();
      expect(repo.create).toHaveBeenCalled();
    });
  });

  describe('Cenário 7 — Erro no findByAuthUid', () => {
    it('deve propagar o erro sem chamar outros métodos', async () => {
      const repo = makeRepository({
        findByAuthUid: jest.fn().mockResolvedValue(
          Result.fail('Erro de conexão com o banco: timeout')
        ),
      });
      const dispatcher = makeEventDispatcher();
      const useCase = new InitWorkerUseCase(repo as any, dispatcher as any);

      const result = await useCase.execute(makeCreateDTO());

      expect(result.isFailure).toBe(true);
      expect(result.error).toBe('Erro de conexão com o banco: timeout');
      expect(repo.findByEmail).not.toHaveBeenCalled();
      expect(repo.create).not.toHaveBeenCalled();
    });
  });

  describe('Cenário 8 — Erro no findByEmail', () => {
    it('deve propagar o erro sem chamar create', async () => {
      const repo = makeRepository({
        findByAuthUid: jest.fn().mockResolvedValue(Result.ok(null)),
        findByEmail: jest.fn().mockResolvedValue(
          Result.fail('Query inválida: coluna email não existe')
        ),
      });
      const dispatcher = makeEventDispatcher();
      const useCase = new InitWorkerUseCase(repo as any, dispatcher as any);

      const result = await useCase.execute(makeCreateDTO());

      expect(result.isFailure).toBe(true);
      expect(result.error).toBe('Query inválida: coluna email não existe');
      expect(repo.create).not.toHaveBeenCalled();
    });
  });

  describe('Cenário 9 — Erro no updateAuthUid', () => {
    it('deve propagar o erro do repositório ao tentar reconciliar authUid', async () => {
      const workerWithDifferentUid: Worker = {
        ...mockWorker,
        authUid: 'uid-anterior-do-firebase',
      };
      const repo = makeRepository({
        findByAuthUid: jest.fn().mockResolvedValue(Result.ok(null)),
        findByEmail: jest.fn().mockResolvedValue(Result.ok(workerWithDifferentUid)),
        updateAuthUid: jest.fn().mockResolvedValue(
          Result.fail('Falha ao atualizar authUid: constraint violation')
        ),
      });
      const dispatcher = makeEventDispatcher();
      const useCase = new InitWorkerUseCase(repo as any, dispatcher as any);

      const result = await useCase.execute(makeCreateDTO());

      expect(result.isFailure).toBe(true);
      expect(result.error).toBe('Falha ao atualizar authUid: constraint violation');
      expect(dispatcher.notifyWorkerCreated).not.toHaveBeenCalled();
    });
  });

  describe('Cenário 10 — Preservação do phone do worker existente', () => {
    const EXISTING_PHONE = '+5491157983978';
    const PAYLOAD_PHONE = '+5491199990000';

    it('worker existente COM phone: o phone original deve ser preservado após reconexão por email', async () => {
      const workerWithPhone: Worker = {
        ...mockWorker,
        authUid: 'oldAuthUid111',
        phone: EXISTING_PHONE,
        id: 'f1a2b3c4-0001-4000-a000-000000000001',
      };
      const updatedWorker: Worker = {
        ...workerWithPhone,
        authUid: REAL_AUTH_UID,
        phone: EXISTING_PHONE,
      };
      const repo = makeRepository({
        findByAuthUid: jest.fn().mockResolvedValue(Result.ok(null)),
        findByEmail: jest.fn().mockResolvedValue(Result.ok(workerWithPhone)),
        updateAuthUid: jest.fn().mockResolvedValue(Result.ok(updatedWorker)),
      });
      const dispatcher = makeEventDispatcher();
      const useCase = new InitWorkerUseCase(repo as any, dispatcher as any);

      const result = await useCase.execute(makeCreateDTO({ phone: PAYLOAD_PHONE }));

      expect(result.isSuccess).toBe(true);
      expect(repo.updateAuthUid).toHaveBeenCalledWith(
        workerWithPhone.id, REAL_AUTH_UID, undefined, undefined
      );
      const output = result.getValue();
      if (output.status === 'ok') {
        expect(output.worker.phone).toBe(EXISTING_PHONE);
      }
    });

    it('worker existente SEM phone: o phone do payload deve preencher após reconexão por email', async () => {
      const workerWithoutPhone: Worker = {
        ...mockWorker,
        authUid: 'oldAuthUid222',
        phone: undefined,
        id: 'f1a2b3c4-0002-4000-a000-000000000002',
      };
      const updatedWorker: Worker = {
        ...workerWithoutPhone,
        authUid: REAL_AUTH_UID,
        phone: PAYLOAD_PHONE,
      };
      const repo = makeRepository({
        findByAuthUid: jest.fn().mockResolvedValue(Result.ok(null)),
        findByEmail: jest.fn().mockResolvedValue(Result.ok(workerWithoutPhone)),
        updateAuthUid: jest.fn().mockResolvedValue(Result.ok(updatedWorker)),
      });
      const dispatcher = makeEventDispatcher();
      const useCase = new InitWorkerUseCase(repo as any, dispatcher as any);

      const result = await useCase.execute(makeCreateDTO({ phone: PAYLOAD_PHONE }));

      expect(result.isSuccess).toBe(true);
      expect(repo.updateAuthUid).toHaveBeenCalledWith(
        workerWithoutPhone.id, REAL_AUTH_UID, PAYLOAD_PHONE, undefined
      );
    });

    it('worker NOVO: phone do payload deve ser gravado normalmente', async () => {
      const NEW_PHONE = '+5491177778888';
      const createdWorker: Worker = {
        ...mockWorker,
        authUid: REAL_AUTH_UID,
        phone: NEW_PHONE,
        id: 'f1a2b3c4-0003-4000-a000-000000000003',
      };
      const repo = makeRepository({
        findByAuthUid: jest.fn().mockResolvedValue(Result.ok(null)),
        findByEmail: jest.fn().mockResolvedValue(Result.ok(null)),
        findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(null)),
        create: jest.fn().mockResolvedValue(Result.ok(createdWorker)),
      });
      const dispatcher = makeEventDispatcher();
      const useCase = new InitWorkerUseCase(repo as any, dispatcher as any);

      const result = await useCase.execute(makeCreateDTO({ phone: NEW_PHONE }));

      expect(result.isSuccess).toBe(true);
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ phone: NEW_PHONE })
      );
    });
  });

  describe('Cenário 11 — Erro no create', () => {
    it('deve propagar o erro sem chamar notifyWorkerCreated', async () => {
      const repo = makeRepository({
        create: jest.fn().mockResolvedValue(
          Result.fail('INSERT falhou: duplicate key value violates unique constraint')
        ),
      });
      const dispatcher = makeEventDispatcher();
      const useCase = new InitWorkerUseCase(repo as any, dispatcher as any);

      const result = await useCase.execute(makeCreateDTO());

      expect(result.isFailure).toBe(true);
      expect(result.error).toContain('duplicate key');
      expect(dispatcher.notifyWorkerCreated).not.toHaveBeenCalled();
    });
  });

  describe('Cenário 12 — notifyWorkerCreated apenas na criação de worker novo', () => {
    it('deve chamar notifyWorkerCreated com o id e email do worker criado', async () => {
      const repo = makeRepository();
      const dispatcher = makeEventDispatcher();
      const useCase = new InitWorkerUseCase(repo as any, dispatcher as any);

      await useCase.execute(makeCreateDTO());

      expect(dispatcher.notifyWorkerCreated).toHaveBeenCalledTimes(1);
      expect(dispatcher.notifyWorkerCreated).toHaveBeenCalledWith(
        mockWorker.id,
        { email: mockWorker.email }
      );
    });

    it('NÃO deve chamar notifyWorkerCreated quando authUid já existe', async () => {
      const repo = makeRepository({
        findByAuthUid: jest.fn().mockResolvedValue(Result.ok(mockWorker)),
      });
      const dispatcher = makeEventDispatcher();
      const useCase = new InitWorkerUseCase(repo as any, dispatcher as any);

      await useCase.execute(makeCreateDTO());

      expect(dispatcher.notifyWorkerCreated).not.toHaveBeenCalled();
    });

    it('NÃO deve chamar notifyWorkerCreated quando reconecta por email (updateAuthUid)', async () => {
      const workerWithOldUid = { ...mockWorker, authUid: 'uidAntigo456' };
      const repo = makeRepository({
        findByAuthUid: jest.fn().mockResolvedValue(Result.ok(null)),
        findByEmail: jest.fn().mockResolvedValue(Result.ok(workerWithOldUid)),
        updateAuthUid: jest.fn().mockResolvedValue(Result.ok(mockWorker)),
      });
      const dispatcher = makeEventDispatcher();
      const useCase = new InitWorkerUseCase(repo as any, dispatcher as any);

      await useCase.execute(makeCreateDTO());

      expect(dispatcher.notifyWorkerCreated).not.toHaveBeenCalled();
    });

    it('NÃO deve chamar notifyWorkerCreated quando detecta candidato importado (claim_pending)', async () => {
      const importedWorker: Worker = {
        ...mockWorker,
        authUid: IMPORTED_AUTH_UID_ANACARE,
        email: 'joana@anacareimport.invalid',
        id: 'e5f6a7b8-5678-4efg-c234-3210987654ef',
      };
      const twilio = makeTwilioVerify();
      const repo = makeRepository({
        findByAuthUid: jest.fn().mockResolvedValue(Result.ok(null)),
        findByEmail: jest.fn().mockResolvedValue(Result.ok(null)),
        findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(importedWorker)),
      });
      const dispatcher = makeEventDispatcher();
      const useCase = new InitWorkerUseCase(repo as any, dispatcher as any, twilio as any);

      await useCase.execute(makeCreateDTO());

      expect(dispatcher.notifyWorkerCreated).not.toHaveBeenCalled();
    });
  });

  describe('Cenário 13 — Reconciliação com variações de formato de telefone', () => {
    const importedWorkerWithCanonical: Worker = {
      ...mockWorker,
      authUid: IMPORTED_AUTH_UID_ANACARE,
      email: 'importado@anacareimport.invalid',
      phone: '5491155555555',
      id: 'aa000001-0000-4000-a000-000000000001',
    };

    it('deve retornar claim_pending quando phone chega com prefixo "+" (ex: +5491155555555)', async () => {
      const twilio = makeTwilioVerify();
      const repo = makeRepository({
        findByAuthUid: jest.fn().mockResolvedValue(Result.ok(null)),
        findByEmail: jest.fn().mockResolvedValue(Result.ok(null)),
        findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(importedWorkerWithCanonical)),
      });
      const dispatcher = makeEventDispatcher();
      const useCase = new InitWorkerUseCase(repo as any, dispatcher as any, twilio as any);

      const result = await useCase.execute(makeCreateDTO({ phone: '+5491155555555' }));

      expect(result.isSuccess).toBe(true);
      expect(result.getValue().status).toBe('claim_pending');
      expect(repo.findByPhoneCandidates).toHaveBeenCalled();
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('deve retornar claim_pending quando phone chega em formato local de 10 dígitos (ex: 1155555555)', async () => {
      const twilio = makeTwilioVerify();
      const repo = makeRepository({
        findByAuthUid: jest.fn().mockResolvedValue(Result.ok(null)),
        findByEmail: jest.fn().mockResolvedValue(Result.ok(null)),
        findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(importedWorkerWithCanonical)),
      });
      const dispatcher = makeEventDispatcher();
      const useCase = new InitWorkerUseCase(repo as any, dispatcher as any, twilio as any);

      const result = await useCase.execute(makeCreateDTO({ phone: '1155555555' }));

      expect(result.isSuccess).toBe(true);
      expect(result.getValue().status).toBe('claim_pending');
    });

    it('phone com 8 dígitos NÃO deve disparar busca por candidatos', async () => {
      const repo = makeRepository({
        findByAuthUid: jest.fn().mockResolvedValue(Result.ok(null)),
        findByEmail: jest.fn().mockResolvedValue(Result.ok(null)),
      });
      const dispatcher = makeEventDispatcher();
      const useCase = new InitWorkerUseCase(repo as any, dispatcher as any);

      await useCase.execute(makeCreateDTO({ phone: '12345678' }));

      expect(repo.findByPhoneCandidates).not.toHaveBeenCalled();
      expect(repo.create).toHaveBeenCalled();
    });

    it('phone nulo NÃO deve disparar busca — deve ir direto para create', async () => {
      const repo = makeRepository({
        findByAuthUid: jest.fn().mockResolvedValue(Result.ok(null)),
        findByEmail: jest.fn().mockResolvedValue(Result.ok(null)),
      });
      const dispatcher = makeEventDispatcher();
      const useCase = new InitWorkerUseCase(repo as any, dispatcher as any);

      await useCase.execute(makeCreateDTO({ phone: undefined }));

      expect(repo.findByPhoneCandidates).not.toHaveBeenCalled();
      expect(repo.create).toHaveBeenCalled();
    });

    it('quando data.phone é vazio mas data.whatsappPhone não, deve usar whatsappPhone para busca', async () => {
      const twilio = makeTwilioVerify();
      const repo = makeRepository({
        findByAuthUid: jest.fn().mockResolvedValue(Result.ok(null)),
        findByEmail: jest.fn().mockResolvedValue(Result.ok(null)),
        findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(importedWorkerWithCanonical)),
      });
      const dispatcher = makeEventDispatcher();
      const useCase = new InitWorkerUseCase(repo as any, dispatcher as any, twilio as any);

      const result = await useCase.execute(
        makeCreateDTO({ phone: undefined, whatsappPhone: '+5491155555555' })
      );

      expect(result.isSuccess).toBe(true);
      expect(result.getValue().status).toBe('claim_pending');
      expect(repo.findByPhoneCandidates).toHaveBeenCalled();
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('quando data.phone e data.whatsappPhone ambos presentes, phone tem prioridade', async () => {
      const phoneCallArgs: string[][] = [];
      const repo = makeRepository({
        findByAuthUid: jest.fn().mockResolvedValue(Result.ok(null)),
        findByEmail: jest.fn().mockResolvedValue(Result.ok(null)),
        findByPhoneCandidates: jest.fn().mockImplementation((candidates: string[]) => {
          phoneCallArgs.push(candidates);
          return Promise.resolve(Result.ok(null));
        }),
      });
      const dispatcher = makeEventDispatcher();
      const useCase = new InitWorkerUseCase(repo as any, dispatcher as any);

      await useCase.execute(
        makeCreateDTO({ phone: '1155555555', whatsappPhone: '1166666666' })
      );

      expect(repo.findByPhoneCandidates).toHaveBeenCalledTimes(1);
      const calledCandidates = phoneCallArgs[0];
      expect(calledCandidates.some(c => c.includes('5555'))).toBe(true);
      expect(calledCandidates.some(c => c.includes('6666') && !c.includes('5555'))).toBe(false);
    });
  });
});
