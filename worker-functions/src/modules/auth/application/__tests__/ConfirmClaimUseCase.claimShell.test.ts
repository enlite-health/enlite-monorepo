import { TwilioVerifyOtpAdapter } from '../../infrastructure/TwilioVerifyOtpAdapter';
import { ConfirmClaimUseCase } from '../ConfirmClaimUseCase';
import { Result } from '@shared/utils/Result';
import { Worker } from '@modules/worker/domain/Worker';

jest.mock('@shared/logging', () => ({
  logger: { child: jest.fn().mockReturnValue({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }) },
  reportError: jest.fn(),
}));

// D764: o authUid do token já tem OUTRA ficha (X). Antes: `SET auth_uid` estourava workers_auth_uid_key (500, M-7).
const CANDIDATE_ID = 'a1b2c3d4-1234-4abc-8def-9876543210ab';
const OWN_ID = '0f9e8d7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f';
const UID = 'newFirebaseUid999';

const base = { currentStep: 1, status: 'INCOMPLETE_REGISTER', country: 'AR', timezone: 'America/Argentina/Buenos_Aires', registrationCompleted: false, createdAt: new Date('2024-01-01'), updatedAt: new Date('2024-01-01') } as const;
const imported: Worker = { ...base, id: CANDIDATE_ID, authUid: 'anacareimport_+5491155261243', email: 'imp@anacareimport.invalid', phone: '+5491155261243' };
const own: Worker = { ...base, id: OWN_ID, authUid: UID, email: 'joana@gmail.com' };

const repo = (over = {}) => ({
  hasAbsorbedRealLogin: jest.fn().mockResolvedValue(Result.ok(false)),
  findById: jest.fn().mockResolvedValue(Result.ok(imported)),
  findByAuthUid: jest.fn().mockResolvedValue(Result.ok(null)),
  updateImportedWorkerData: jest.fn().mockResolvedValue(Result.ok({ ...imported, authUid: UID })),
  updateAuthUid: jest.fn().mockResolvedValue(Result.ok(own)),
  ...over,
});
const twilio = () => ({
  startVerification: jest.fn(),
  checkVerification: jest.fn().mockResolvedValue({ valid: true, status: 'approved', to: '+5491155261243' }),
});
const input = { verificationSid: 'VE_X', otp: '123456', authUid: UID, email: 'joana@gmail.com', candidateWorkerId: CANDIDATE_ID };

describe('ConfirmClaimUseCase — conta que já tem ficha (D764)', () => {
  it('T-D764 (a) ficha própria (casca): absorve a importada nela, sem SET auth_uid na importada', async () => {
    const r = repo({ findByAuthUid: jest.fn().mockResolvedValue(Result.ok(own)) });
    const absorber = { absorbImportedIntoExisting: jest.fn().mockResolvedValue(Result.ok(undefined)) };
    const result = await new ConfirmClaimUseCase(r as any, new TwilioVerifyOtpAdapter(twilio() as any), absorber).execute(input);

    expect(result.isSuccess).toBe(true);
    expect(absorber.absorbImportedIntoExisting).toHaveBeenCalledWith({ existingId: OWN_ID, importedId: CANDIDATE_ID, authUid: UID, consentAt: undefined });
    expect(absorber.absorbImportedIntoExisting.mock.calls[0][0].consentAt).toBeUndefined(); // OTP não presume aceite
    expect(r.updateImportedWorkerData).not.toHaveBeenCalled();
    expect(r.updateAuthUid).not.toHaveBeenCalled(); // consentimento vai na transação da absorção, não por fora
  });

  it('T-D764 (b) ficha própria não é casca: CLAIM_CONFLICT, nada de updateImportedWorkerData', async () => {
    const r = repo({ findByAuthUid: jest.fn().mockResolvedValue(Result.ok(own)) });
    const absorber = { absorbImportedIntoExisting: jest.fn().mockResolvedValue(Result.fail('CLAIM_CONFLICT')) };
    const result = await new ConfirmClaimUseCase(r as any, new TwilioVerifyOtpAdapter(twilio() as any), absorber).execute(input);

    expect(result.isFailure).toBe(true);
    expect(result.error).toBe('CLAIM_CONFLICT');
    expect(r.updateImportedWorkerData).not.toHaveBeenCalled();
    expect(r.updateAuthUid).not.toHaveBeenCalled();
  });

  it('T-D764 (c) uid sem ficha: comportamento de hoje (updateImportedWorkerData), absorvedor intocado', async () => {
    const r = repo();
    const absorber = { absorbImportedIntoExisting: jest.fn() };
    const result = await new ConfirmClaimUseCase(r as any, new TwilioVerifyOtpAdapter(twilio() as any), absorber).execute(input);

    expect(result.isSuccess).toBe(true);
    expect(r.updateImportedWorkerData).toHaveBeenCalledWith(CANDIDATE_ID, expect.objectContaining({ authUid: UID }));
    expect(absorber.absorbImportedIntoExisting).not.toHaveBeenCalled();
  });

  it('T-D764 (d) uid com ficha e sem absorvedor configurado: CLAIM_CONFLICT (nunca erro de banco)', async () => {
    const r = repo({ findByAuthUid: jest.fn().mockResolvedValue(Result.ok(own)) });
    const result = await new ConfirmClaimUseCase(r as any, new TwilioVerifyOtpAdapter(twilio() as any)).execute(input);

    expect(result.isFailure).toBe(true);
    expect(result.error).toBe('CLAIM_CONFLICT');
    expect(r.updateImportedWorkerData).not.toHaveBeenCalled();
  });
});
