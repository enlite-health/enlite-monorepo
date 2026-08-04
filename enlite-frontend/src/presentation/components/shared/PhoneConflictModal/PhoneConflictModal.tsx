/**
 * PhoneConflictModal
 *
 * Abre quando o autosave do telefone recebe 409 PHONE_NOT_AVAILABLE e o
 * account-link/lookup confirma que a dona é conta REAL. Transforma o beco do
 * caso Edith num caminho:
 *
 *   colisão → "vincular?" → start (SÓ AQUI o SMS dispara — contrato v2) →
 *   OTP (número DA CONTA ANTIGA, com reenvio) → conflitos (valores só chegam
 *   DEPOIS da posse provada; default = sugestão "mais recente" do servidor)
 *   → finalize → resumo com contagens reais. Degrau alto-valor → aviso de
 *   revisão humana. "Sem acesso ao número" → orientação (não é beco).
 *
 * Enquanto aberta, o caller (GeneralInfoTab) suprime os toasts do autosave.
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  WorkerApiService,
  AccountLinkLookupResponse,
  AccountLinkConflict,
  AccountLinkConfirmResponse,
} from '@infrastructure/http/WorkerApiService';
import { ApiError } from '@infrastructure/http/ApiError';
import { FieldChoiceList } from '@presentation/components/shared/FieldChoiceList/FieldChoiceList';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Label } from '@presentation/components/atoms/Label';
import { Button } from '@presentation/components/atoms/Button';

// ── Props ──────────────────────────────────────────────────────────────────

export interface PhoneConflictModalProps {
  open: boolean;
  /** Telefone exatamente como digitado (por extenso — pega typo). */
  phoneEntered: string;
  /** Resposta do lookup (email/telefone mascarados — nada decriptado). */
  lookupData: AccountLinkLookupResponse;
  onClose: () => void;
  /** Chamado após merge concluído (caller re-hydrata o store do servidor). */
  onLinked: (result: AccountLinkConfirmResponse) => void;
}

type Step = 'choice' | 'no_access' | 'otp' | 'conflicts' | 'summary' | 'requires_review';

// ── Component ──────────────────────────────────────────────────────────────

export function PhoneConflictModal({
  open,
  phoneEntered,
  lookupData,
  onClose,
  onLinked,
}: PhoneConflictModalProps): JSX.Element | null {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>('choice');
  const [isLoading, setIsLoading] = useState(false);
  const [verificationSid, setVerificationSid] = useState('');
  const [otpPhoneMasked, setOtpPhoneMasked] = useState(lookupData.phoneMasked);
  const [otp, setOtp] = useState('');
  const [otpError, setOtpError] = useState<string | null>(null);
  const [resent, setResent] = useState(false);
  const [conflicts, setConflicts] = useState<AccountLinkConflict[]>([]);
  const [accounts, setAccounts] = useState<{ current: string; other: string }>({ current: '', other: '' });
  const [linkToken, setLinkToken] = useState('');
  const [fieldChoices, setFieldChoices] = useState<Record<string, string>>({});
  const [confirmResult, setConfirmResult] = useState<AccountLinkConfirmResponse | null>(null);

  if (!open) return null;

  // ── Ações ────────────────────────────────────────────────────────────────

  /** SÓ AQUI o SMS dispara (contrato v2) — também serve de reenvio. */
  const handleStart = async (isResend: boolean): Promise<void> => {
    setIsLoading(true);
    setOtpError(null);
    try {
      const out = await WorkerApiService.startAccountLink(phoneEntered);
      setVerificationSid(out.verificationSid);
      setOtpPhoneMasked(out.phoneMasked);
      setResent(isResend);
      setStep('otp');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'RATE_LIMITED') {
        setOtpError(t('accountLink.otp.errorRateLimited', 'Demasiados intentos. Esperá una hora y probá de nuevo.'));
        if (!isResend) setStep('otp');
      } else {
        setOtpError(t('accountLink.otp.errorStart', 'No pudimos enviar el código. Probá de nuevo.'));
        if (!isResend) setStep('otp');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const applyConfirmResult = (result: AccountLinkConfirmResponse): void => {
    setConfirmResult(result);
    if (result.status === 'REQUIRES_REVIEW') {
      setStep('requires_review');
      return;
    }
    if (result.status === 'conflicts') {
      setConflicts(result.conflicts);
      setAccounts(result.accounts);
      setLinkToken(result.linkToken);
      // Default = sugestão do servidor (conta com updated_at mais recente)
      setFieldChoices(Object.fromEntries(result.conflicts.map(c => [c.field, c.suggested])));
      setStep('conflicts');
      return;
    }
    setStep('summary');
    onLinked(result);
  };

  const handleOtpSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (otp.length < 6 || isLoading) return;
    setIsLoading(true);
    try {
      const result = await WorkerApiService.confirmAccountLink({ phone: phoneEntered, verificationSid, otp });
      applyConfirmResult(result);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'EXPIRED_OTP') {
        setOtpError(t('accountLink.otp.errorExpired', 'El código expiró. Pedí uno nuevo con "Reenviar código".'));
      } else if (err instanceof ApiError && err.code === 'RATE_LIMITED') {
        setOtpError(t('accountLink.otp.errorRateLimited', 'Demasiados intentos. Esperá una hora y probá de nuevo.'));
      } else {
        setOtpError(t('accountLink.otp.errorInvalid', 'Código incorrecto. Revisá e intentá de nuevo.'));
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleFinalize = async (): Promise<void> => {
    setIsLoading(true);
    try {
      const result = await WorkerApiService.finalizeAccountLink({ linkToken, fieldChoices });
      applyConfirmResult(result);
    } catch {
      // Token expirado (10 min) → volta pro OTP com reenvio
      setOtpError(t('accountLink.otp.errorExpired', 'El código expiró. Pedí uno nuevo con "Reenviar código".'));
      setOtp('');
      setStep('otp');
    } finally {
      setIsLoading(false);
    }
  };

  const recovered = confirmResult?.status === 'merged' ? confirmResult.recovered : {};
  const recoveredApplications = recovered.worker_job_applications ?? 0;
  const recoveredDocuments = recovered.worker_documents ?? 0;

  // Copy adaptativa (achado do e2e REAL: "0 postulaciones y 1 documentos" soa
  // a bug e erra o plural) — só cita o que de fato veio, com plural correto.
  const summaryText = ((): string => {
    const apps = recoveredApplications === 1
      ? t('accountLink.summary.oneApplication', 'tu postulación')
      : t('accountLink.summary.manyApplications', 'tus {{count}} postulaciones', { count: recoveredApplications });
    if (recoveredApplications > 0 && recoveredDocuments > 0) {
      return t('accountLink.summary.recoveredBoth',
        'Recuperamos {{apps}} y tus documentos de tu cuenta anterior. Tu teléfono ya quedó guardado.', { apps });
    }
    if (recoveredApplications > 0) {
      return t('accountLink.summary.recoveredApplications',
        'Recuperamos {{apps}} de tu cuenta anterior. Tu teléfono ya quedó guardado.', { apps });
    }
    if (recoveredDocuments > 0) {
      return t('accountLink.summary.recoveredDocuments',
        'Recuperamos tus documentos de tu cuenta anterior. Tu teléfono ya quedó guardado.');
    }
    return t('accountLink.summary.recoveredNone',
      '¡Listo! Tu cuenta anterior quedó vinculada y tu teléfono ya quedó guardado.');
  })();

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50" aria-hidden="true" onClick={step === 'summary' ? onClose : undefined} />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="phone-conflict-title"
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        data-testid="phone-conflict-modal"
      >
        <div className="bg-white rounded-2xl shadow-xl w-full max-w-[480px] p-6 sm:p-8 flex flex-col gap-6 max-h-[90vh] overflow-y-auto">

          {/* ── 1. Colisão detectada ───────────────────────────────────── */}
          {step === 'choice' && (
            <div className="flex flex-col gap-5" data-testid="phone-conflict-step-choice">
              <div className="flex flex-col gap-2">
                <Heading level={2} weight="semibold" color="primary" id="phone-conflict-title">
                  {t('accountLink.choice.title', 'Este número ya está asociado a otra cuenta')}
                </Heading>
                <Text size="sm" color="secondary">
                  {t('accountLink.choice.phoneEntered', 'Número ingresado:')}{' '}
                  <span className="font-semibold text-primary" data-testid="phone-conflict-phone">{phoneEntered}</span>
                </Text>
                <Text size="sm" color="secondary">
                  {t('accountLink.choice.otherAccount', 'Cuenta asociada:')}{' '}
                  <span className="font-semibold text-primary" data-testid="phone-conflict-email">{lookupData.otherEmailMasked}</span>
                </Text>
                <Text size="sm" color="secondary">
                  {t(
                    'accountLink.choice.explanation',
                    '¿Es tu cuenta anterior? Podés vincularla y recuperar tus postulaciones y documentos. Te vamos a enviar un código al número para confirmar que es tuyo.',
                  )}
                </Text>
              </div>

              <div className="flex flex-col gap-3">
                <Button
                  type="button"
                  variant="primary"
                  size="lg"
                  fullWidth
                  isLoading={isLoading}
                  onClick={() => void handleStart(false)}
                  data-testid="phone-conflict-link-button"
                >
                  {t('accountLink.choice.linkButton', 'Sí, es mi cuenta — vincular')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="md"
                  fullWidth
                  onClick={() => setStep('no_access')}
                  data-testid="phone-conflict-no-access-button"
                >
                  {t('accountLink.choice.noAccessButton', 'No tengo acceso a ese número')}
                </Button>
                <a
                  href="https://wa.me/5491133339999"
                  target="_blank"
                  rel="noreferrer"
                  className="text-center text-sm text-primary underline"
                  data-testid="phone-conflict-support-link"
                >
                  {t('accountLink.choice.notMineLink', 'No es mi cuenta — hablar con soporte')}
                </a>
              </div>
            </div>
          )}

          {/* ── 1b. Sem acesso ao número — NÃO é beco ──────────────────── */}
          {step === 'no_access' && (
            <div className="flex flex-col gap-5" data-testid="phone-conflict-step-no-access">
              <div className="flex flex-col gap-2">
                <Heading level={2} weight="semibold" color="primary" id="phone-conflict-title">
                  {t('accountLink.noAccess.title', '¿Sin acceso a ese número?')}
                </Heading>
                <Text size="sm" color="secondary">
                  {t(
                    'accountLink.noAccess.optionNewNumber',
                    'Si tenés un número NUEVO que es tuyo y está activo, cerrá esta ventana y cargalo en el campo de teléfono — con eso ya podés completar tu registro.',
                  )}
                </Text>
                <Text size="sm" color="secondary">
                  {t(
                    'accountLink.noAccess.optionSupport',
                    'Si querés recuperar la cuenta anterior (postulaciones, documentos), hablá con soporte y el equipo termina el vínculo por vos.',
                  )}
                </Text>
              </div>
              <div className="flex flex-col gap-3">
                <Button type="button" variant="primary" size="lg" fullWidth onClick={onClose} data-testid="phone-conflict-no-access-close">
                  {t('accountLink.noAccess.closeButton', 'Usar otro número')}
                </Button>
                <a
                  href="https://wa.me/5491133339999"
                  target="_blank"
                  rel="noreferrer"
                  className="text-center text-sm text-primary underline"
                >
                  {t('accountLink.noAccess.supportLink', 'Hablar con soporte')}
                </a>
              </div>
            </div>
          )}

          {/* ── 2. OTP no número DA CONTA ANTIGA (com reenvio) ─────────── */}
          {step === 'otp' && (
            <form onSubmit={(e) => void handleOtpSubmit(e)} className="flex flex-col gap-5" data-testid="phone-conflict-step-otp">
              <div className="flex flex-col gap-2">
                <Heading level={2} weight="semibold" color="primary" id="phone-conflict-title">
                  {t('accountLink.otp.title', 'Confirmá que el número es tuyo')}
                </Heading>
                <Text size="sm" color="secondary">
                  {t('accountLink.otp.subtitle', 'Enviamos un código de 6 dígitos al {{phoneMasked}}.', {
                    phoneMasked: otpPhoneMasked,
                  })}
                </Text>
                {resent && (
                  <span className="text-sm text-green-700" data-testid="account-link-otp-resent">
                    {t('accountLink.otp.resent', 'Código reenviado.')}
                  </span>
                )}
              </div>

              <div className="flex flex-col gap-1.5">
                <Label htmlFor="account-link-otp">{t('accountLink.otp.inputLabel', 'Código')}</Label>
                <input
                  id="account-link-otp"
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={otp}
                  onChange={(e) => { setOtp(e.target.value.replace(/\D/g, '').slice(0, 6)); if (otpError) setOtpError(null); }}
                  maxLength={6}
                  placeholder="000000"
                  disabled={isLoading}
                  className={[
                    'w-full h-14 px-4 rounded-xl border-[1.5px] outline-none',
                    'font-lexend text-base tracking-[0.3em] text-center text-primary',
                    'transition-colors duration-150',
                    otpError ? 'border-red-400 bg-red-50 focus:border-red-500' : 'border-gray-300 focus:border-primary',
                    isLoading ? 'opacity-60 cursor-not-allowed' : '',
                  ].filter(Boolean).join(' ')}
                  data-testid="account-link-otp-input"
                />
                {otpError && (
                  <span className="text-sm text-red-600" data-testid="account-link-otp-error">
                    {otpError}
                  </span>
                )}
              </div>

              <div className="flex flex-col gap-3">
                <Button
                  type="submit"
                  variant="primary"
                  size="lg"
                  fullWidth
                  isLoading={isLoading}
                  disabled={otp.length < 6 || isLoading}
                  data-testid="account-link-otp-confirm"
                >
                  {t('accountLink.otp.confirmButton', 'Confirmar')}
                </Button>
                <button
                  type="button"
                  onClick={() => void handleStart(true)}
                  disabled={isLoading}
                  className="text-sm text-primary underline disabled:opacity-50"
                  data-testid="account-link-otp-resend"
                >
                  {t('accountLink.otp.resendButton', 'Reenviar código')}
                </button>
                <Button type="button" variant="ghost" size="md" fullWidth onClick={onClose} disabled={isLoading}>
                  {t('accountLink.otp.cancelButton', 'Cancelar')}
                </Button>
              </div>
            </form>
          )}

          {/* ── 3. Conflitos (valores só chegam pós-OTP) ───────────────── */}
          {step === 'conflicts' && (
            <div className="flex flex-col gap-5" data-testid="phone-conflict-step-conflicts">
              <div className="flex flex-col gap-2">
                <Heading level={2} weight="semibold" color="primary" id="phone-conflict-title">
                  {t('accountLink.conflicts.title', 'Elegí qué información mantener')}
                </Heading>
                <Text size="sm" color="secondary">
                  {t(
                    'accountLink.conflicts.subtitle',
                    'Las dos cuentas tienen valores distintos en estos campos. Elegí cuál vale (pre-seleccionamos el más reciente).',
                  )}
                </Text>
              </div>

              <div className="border border-slate-200 rounded-xl">
                <FieldChoiceList
                  comparisons={conflicts}
                  options={[
                    { id: accounts.current, label: t('accountLink.conflicts.currentAccount', 'Tu cuenta actual') },
                    { id: accounts.other, label: t('accountLink.conflicts.otherAccount', 'Cuenta anterior') },
                  ]}
                  choices={fieldChoices}
                  fallbackChoiceId={accounts.current}
                  onChange={(field, accountId) => setFieldChoices((prev) => ({ ...prev, [field]: accountId }))}
                  fieldLabel={(field) => t(`accountLink.fields.${field}`, field)}
                  valueLabel={(_field, raw) =>
                    raw == null ? null : t(`workerRegistration.generalInfo.${raw}`, raw)}
                />
              </div>

              <Button
                type="button"
                variant="primary"
                size="lg"
                fullWidth
                isLoading={isLoading}
                onClick={() => void handleFinalize()}
                data-testid="account-link-conflicts-confirm"
              >
                {t('accountLink.conflicts.confirmButton', 'Vincular cuentas')}
              </Button>
            </div>
          )}

          {/* ── 4. Resumo (contagens reais do reparent) ────────────────── */}
          {step === 'summary' && (
            <div className="flex flex-col gap-5" data-testid="phone-conflict-step-summary">
              <div className="flex flex-col gap-2">
                <Heading level={2} weight="semibold" color="primary" id="phone-conflict-title">
                  {t('accountLink.summary.title', '¡Cuentas vinculadas!')}
                </Heading>
                <span className="text-sm text-gray-800" data-testid="account-link-summary-text">
                  {summaryText}
                </span>
              </div>
              <Button type="button" variant="primary" size="lg" fullWidth onClick={onClose} data-testid="account-link-summary-close">
                {t('accountLink.summary.closeButton', 'Continuar')}
              </Button>
            </div>
          )}

          {/* ── Alto valor: revisão humana ─────────────────────────────── */}
          {step === 'requires_review' && (
            <div className="flex flex-col gap-5" data-testid="phone-conflict-step-review">
              <div className="flex flex-col gap-2">
                <Heading level={2} weight="semibold" color="primary" id="phone-conflict-title">
                  {t('accountLink.review.title', 'Vamos a terminar el vínculo por vos')}
                </Heading>
                <Text size="sm" color="secondary">
                  {t(
                    'accountLink.review.explanation',
                    'Tu cuenta anterior tiene actividad importante, así que nuestro equipo va a completar el vínculo manualmente. Te avisamos apenas esté listo.',
                  )}
                </Text>
              </div>
              <Button type="button" variant="primary" size="lg" fullWidth onClick={onClose}>
                {t('accountLink.review.closeButton', 'Entendido')}
              </Button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
