/**
 * PhoneConflictModal
 *
 * Abre quando o autosave do telefone recebe 409 PHONE_NOT_AVAILABLE e o
 * backend confirma que o dono é outra conta REAL (account-link/start ok).
 * Transforma o beco sem saída do caso Edith num caminho de resolução:
 *
 *   colisão → "vincular?" → OTP (número DA CONTA ANTIGA) → conflitos (se
 *   houver) → resumo do que foi recuperado.
 *
 * O número digitado aparece POR EXTENSO (pega typo); o email da outra conta
 * vem MASCARADO do servidor (não vaza identidade). Enquanto a modal está
 * aberta, os toasts de autosave são suprimidos pelo caller (GeneralInfoTab).
 */

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { WorkerApiService, AccountLinkStartResponse, AccountLinkConfirmResponse } from '@infrastructure/http/WorkerApiService';
import { ApiError } from '@infrastructure/http/ApiError';
import type { DedupFieldComparison } from '@domain/entities/DedupGroup';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Label } from '@presentation/components/atoms/Label';
import { Button } from '@presentation/components/atoms/Button';

// ── Props ──────────────────────────────────────────────────────────────────

export interface PhoneConflictModalProps {
  open: boolean;
  /** Telefone exatamente como digitado (por extenso — pega typo). */
  phoneEntered: string;
  /** Resposta do account-link/start (email mascarado, sid, conflitos). */
  startData: AccountLinkStartResponse;
  onClose: () => void;
  /** Chamado após merge concluído (caller re-hydrata o store do servidor). */
  onLinked: (result: AccountLinkConfirmResponse) => void;
}

type Step = 'choice' | 'otp' | 'conflicts' | 'summary' | 'requires_review';

// ── Component ──────────────────────────────────────────────────────────────

export function PhoneConflictModal({
  open,
  phoneEntered,
  startData,
  onClose,
  onLinked,
}: PhoneConflictModalProps): JSX.Element | null {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>('choice');
  const [otp, setOtp] = useState('');
  const [otpError, setOtpError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [fieldChoices, setFieldChoices] = useState<Record<string, string>>({});
  const [confirmResult, setConfirmResult] = useState<AccountLinkConfirmResponse | null>(null);

  if (!open) return null;

  const conflicts: DedupFieldComparison[] = (startData.conflicts ?? []).filter(c => c.has_conflict);

  const handleOtpChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    setOtp(e.target.value.replace(/\D/g, '').slice(0, 6));
    if (otpError) setOtpError(null);
  };

  const handleConfirm = async (): Promise<void> => {
    if (otp.length < 6 || isLoading) return;
    setIsLoading(true);
    try {
      const result = await WorkerApiService.confirmAccountLink({
        verificationSid: startData.verificationSid,
        otp,
        fieldChoices,
      });
      setConfirmResult(result);
      if (result.status === 'REQUIRES_REVIEW') {
        setStep('requires_review');
      } else {
        setStep('summary');
        onLinked(result);
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'EXPIRED_OTP') {
        setOtpError(t('accountLink.otp.errorExpired', 'El código expiró. Pedí uno nuevo.'));
      } else {
        setOtpError(t('accountLink.otp.errorInvalid', 'Código incorrecto. Revisá e intentá de nuevo.'));
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleOtpSubmit = (e: React.FormEvent): void => {
    e.preventDefault();
    // Se houver conflitos reais, escolhe os campos ANTES de executar o merge.
    if (conflicts.length > 0 && step === 'otp') {
      setStep('conflicts');
      return;
    }
    void handleConfirm();
  };

  const recoveredApplications = confirmResult?.recovered?.worker_job_applications ?? 0;
  const recoveredDocuments = confirmResult?.recovered?.worker_documents ?? 0;

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

          {/* ── Passo 1: colisão detectada ─────────────────────────────── */}
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
                  <span className="font-semibold text-primary" data-testid="phone-conflict-email">{startData.otherEmailMasked}</span>
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
                  onClick={() => setStep('otp')}
                  data-testid="phone-conflict-link-button"
                >
                  {t('accountLink.choice.linkButton', 'Sí, es mi cuenta — vincular')}
                </Button>
                <Button type="button" variant="ghost" size="md" fullWidth onClick={onClose} data-testid="phone-conflict-no-access-button">
                  {t('accountLink.choice.noAccessButton', 'No tengo acceso a ese número')}
                </Button>
                <a
                  href="https://wa.me/5491133339999"
                  target="_blank"
                  rel="noreferrer"
                  className="text-center text-sm text-gray-700 underline"
                  data-testid="phone-conflict-support-link"
                >
                  {t('accountLink.choice.notMineLink', 'No es mi cuenta — hablar con soporte')}
                </a>
              </div>
            </div>
          )}

          {/* ── Passo 2: OTP no número DA CONTA ANTIGA ─────────────────── */}
          {(step === 'otp' || step === 'conflicts') && (
            <div className="flex flex-col gap-5">
              {step === 'otp' && (
                <form onSubmit={handleOtpSubmit} className="flex flex-col gap-5" data-testid="phone-conflict-step-otp">
                  <div className="flex flex-col gap-2">
                    <Heading level={2} weight="semibold" color="primary" id="phone-conflict-title">
                      {t('accountLink.otp.title', 'Confirmá que el número es tuyo')}
                    </Heading>
                    <Text size="sm" color="secondary">
                      {t('accountLink.otp.subtitle', 'Enviamos un código de 6 dígitos al {{phoneMasked}}.', {
                        phoneMasked: startData.phoneMasked,
                      })}
                    </Text>
                  </div>

                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="account-link-otp">{t('accountLink.otp.inputLabel', 'Código')}</Label>
                    <input
                      id="account-link-otp"
                      type="text"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      value={otp}
                      onChange={handleOtpChange}
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
                    <Button type="button" variant="ghost" size="md" fullWidth onClick={onClose} disabled={isLoading}>
                      {t('accountLink.otp.cancelButton', 'Cancelar')}
                    </Button>
                  </div>
                </form>
              )}

              {/* ── Passo 3: conflitos (só campos em conflito REAL) ──────── */}
              {step === 'conflicts' && (
                <div className="flex flex-col gap-5" data-testid="phone-conflict-step-conflicts">
                  <div className="flex flex-col gap-2">
                    <Heading level={2} weight="semibold" color="primary" id="phone-conflict-title">
                      {t('accountLink.conflicts.title', 'Elegí qué información mantener')}
                    </Heading>
                    <Text size="sm" color="secondary">
                      {t(
                        'accountLink.conflicts.subtitle',
                        'Las dos cuentas tienen valores distintos en estos campos. Elegí cuál vale.',
                      )}
                    </Text>
                  </div>

                  <div className="flex flex-col gap-3">
                    {conflicts.map((conflict) => {
                      const accountIds = Object.keys(conflict.values);
                      return (
                        <div key={conflict.field} className="border border-slate-200 rounded-xl p-4 flex flex-col gap-2" data-testid={`conflict-field-${conflict.field}`}>
                          <Text as="span" size="sm" weight="semibold">
                            {t(`accountLink.fields.${conflict.field}`, conflict.field)}
                          </Text>
                          {accountIds.map((accountId) => (
                            <label key={accountId} className="flex items-center gap-2 cursor-pointer">
                              <input
                                type="radio"
                                name={`conflict-${conflict.field}`}
                                checked={(fieldChoices[conflict.field] ?? accountIds[0]) === accountId}
                                onChange={() => setFieldChoices((prev) => ({ ...prev, [conflict.field]: accountId }))}
                                data-testid={`conflict-${conflict.field}-${accountId}`}
                              />
                              <Text as="span" size="sm">{conflict.values[accountId] ?? '—'}</Text>
                            </label>
                          ))}
                        </div>
                      );
                    })}
                  </div>

                  <Button
                    type="button"
                    variant="primary"
                    size="lg"
                    fullWidth
                    isLoading={isLoading}
                    onClick={() => void handleConfirm()}
                    data-testid="account-link-conflicts-confirm"
                  >
                    {t('accountLink.conflicts.confirmButton', 'Vincular cuentas')}
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* ── Passo 4: resumo do que foi recuperado ──────────────────── */}
          {step === 'summary' && (
            <div className="flex flex-col gap-5" data-testid="phone-conflict-step-summary">
              <div className="flex flex-col gap-2">
                <Heading level={2} weight="semibold" color="primary" id="phone-conflict-title">
                  {t('accountLink.summary.title', '¡Cuentas vinculadas!')}
                </Heading>
                <span className="text-sm text-gray-800" data-testid="account-link-summary-text">
                  {t('accountLink.summary.recovered', 'Recuperamos {{applications}} postulaciones y {{documents}} documentos de tu cuenta anterior. Tu teléfono ya quedó guardado.', {
                    applications: recoveredApplications,
                    documents: recoveredDocuments,
                  })}
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
