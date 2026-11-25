import { TwilioVerifyOtpAdapter } from '@modules/auth/infrastructure/TwilioVerifyOtpAdapter';
jest.mock('@shared/logging', () => ({
  logger:      { child: jest.fn().mockReturnValue({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) },
  reportError: jest.fn(),
  loggingAls:  { run: jest.fn() },
}));

import { InitWorkerUseCase } from '../InitWorkerUseCase';
import { Result } from '@shared/utils/Result';
import { Worker } from '../../domain/Worker';

// FR-88/C-43: worker achado por auth_uid SEM telefone aplica o mesmo ramo do cadastro.
// O telefone só é gravado se for NULL; o app só mapeia `code` para tela.

const AUTH_UID = 'abc123XYZ789def';
const EMAIL = 'joana.silva@gmail.com';
const PHONE_INPUT = '+5491151265663';
const PHONE_NORMALIZED = '5491151265663';
const WORKER_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const OTHER_ID = '0b8f3c1e-7a52-4e0c-9d34-6a1f2c3d4e5f';

const baseWorker = (overrides: Partial<Worker> = {}): Worker => ({
  id: WORKER_ID,
  authUid: AUTH_UID,
  email: EMAIL,
  currentStep: 1,
  status: 'INCOMPLETE_REGISTER',
  country: 'AR',
  timezone: 'America/Argentina/Buenos_Aires',
  registrationCompleted: false,
  createdAt: new Date('2024-06-01T10:00:00Z'),
  updatedAt: new Date('2024-06-01T10:00:00Z'),
  ...overrides,
});

const makeRepository = (found: Worker, overrides = {}) => ({
  findByAuthUid: jest.fn().mockResolvedValue(Result.ok(found)),
  findByEmail: jest.fn().mockResolvedValue(Result.ok(null)),
  findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(null)),
  setPhoneIfNull: jest.fn().mockResolvedValue({ ...found, phone: PHONE_NORMALIZED }),
  hasAbsorbedRealLogin: jest.fn().mockResolvedValue(Result.ok(false)),
  create: jest.fn(),
  updateAuthUid: jest.fn(),
  ...overrides,
});

const makeTwilio = () => ({
  startVerification: jest.fn().mockResolvedValue({ verificationSid: 'VE_TEST_SID' }),
  checkVerification: jest.fn(),
});

const input = (phone: string | undefined = PHONE_INPUT) => ({
  authUid: AUTH_UID,
  email: EMAIL,
  emailVerified: true,
  phone,
  country: 'AR',
});

describe('InitWorkerUseCase — telefone de worker existente sem telefone', () => {
  it('T-F3c-07 OK: ficha sem telefone e celular livre grava o celular normalizado e devolve OK', async () => {
    const found = baseWorker();
    const repo = makeRepository(found);
    const useCase = new InitWorkerUseCase(repo as any, new TwilioVerifyOtpAdapter(makeTwilio() as any));

    const result = await useCase.execute(input());

    expect(result.isSuccess).toBe(true);
    expect(result.getValue()).toEqual({
      status: 'ok',
      code: 'OK',
      worker: { ...found, phone: PHONE_NORMALIZED },
    });
    expect(repo.setPhoneIfNull).toHaveBeenCalledWith(WORKER_ID, PHONE_NORMALIZED);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('T-F3c-07 CLAIM_PENDING: celular de ficha importada leva ao OTP do claim e não grava', async () => {
    const found = baseWorker();
    const imported = baseWorker({
      id: OTHER_ID,
      authUid: 'anacareimport_+5491151265663',
      email: 'importada@exemplo.com',
      phone: PHONE_NORMALIZED,
    });
    const repo = makeRepository(found, {
      findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(imported)),
    });
    const twilio = makeTwilio();
    const useCase = new InitWorkerUseCase(repo as any, new TwilioVerifyOtpAdapter(twilio as any));

    const result = await useCase.execute(input());

    const output = result.getValue();
    expect(output.status).toBe('claim_pending');
    if (output.status === 'claim_pending') {
      expect(output.candidateWorkerId).toBe(OTHER_ID);
      expect(output.verificationSid).toBe('VE_TEST_SID');
    }
    expect(output).toMatchObject({ code: 'CLAIM_PENDING' });
    expect(twilio.startVerification).toHaveBeenCalledWith(`+${PHONE_NORMALIZED}`, expect.objectContaining({ workerId: expect.any(String) }));
    expect(repo.setPhoneIfNull).not.toHaveBeenCalled();
  });

  it('T-F3c-07 PHONE_IN_USE: celular de conta real devolve PHONE_IN_USE e não grava nem dispara OTP', async () => {
    const found = baseWorker();
    const real = baseWorker({ id: OTHER_ID, authUid: 'outroUidReal123', email: 'outra@exemplo.com', phone: PHONE_NORMALIZED });
    const repo = makeRepository(found, {
      findByPhoneCandidates: jest.fn().mockResolvedValue(Result.ok(real)),
    });
    const twilio = makeTwilio();
    const useCase = new InitWorkerUseCase(repo as any, new TwilioVerifyOtpAdapter(twilio as any));

    const result = await useCase.execute(input());

    expect(result.isSuccess).toBe(true);
    expect(result.getValue()).toEqual({ status: 'phone_rejected', code: 'PHONE_IN_USE' });
    expect(repo.setPhoneIfNull).not.toHaveBeenCalled();
    expect(twilio.startVerification).not.toHaveBeenCalled();
  });

  it('T-F3c-07 PHONE_LOCKED: ficha que já tinha telefone devolve PHONE_LOCKED sem alterar nada', async () => {
    const found = baseWorker({ phone: '5491100000000' });
    const repo = makeRepository(found);
    const useCase = new InitWorkerUseCase(repo as any, new TwilioVerifyOtpAdapter(makeTwilio() as any));

    const result = await useCase.execute(input());

    expect(result.isSuccess).toBe(true);
    const output = result.getValue();
    expect(output).toMatchObject({ status: 'ok', code: 'PHONE_LOCKED' });
    if (output.status === 'ok') expect(output.worker).toBe(found);
    expect(repo.setPhoneIfNull).not.toHaveBeenCalled();
    expect(repo.findByPhoneCandidates).not.toHaveBeenCalled();
  });

  it('T-F3c-07 INVALID_PHONE: telefone curto devolve INVALID_PHONE e não consulta nem grava', async () => {
    const found = baseWorker();
    const repo = makeRepository(found);
    const useCase = new InitWorkerUseCase(repo as any, new TwilioVerifyOtpAdapter(makeTwilio() as any));

    const result = await useCase.execute(input('12345'));

    expect(result.isSuccess).toBe(true);
    expect(result.getValue()).toEqual({ status: 'phone_rejected', code: 'INVALID_PHONE' });
    expect(repo.findByPhoneCandidates).not.toHaveBeenCalled();
    expect(repo.setPhoneIfNull).not.toHaveBeenCalled();
  });
});
