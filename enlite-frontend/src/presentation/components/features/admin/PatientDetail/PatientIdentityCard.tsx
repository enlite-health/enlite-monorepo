import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { User, TriangleAlert } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { ActionButton } from '@presentation/components/features/access';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { PatientDetail } from '@domain/entities/PatientDetail';
import { FieldPair, FieldPairGrid, FieldGroupTitle } from './FieldPairs';
import { maskDocumentNumber } from '@presentation/utils/maskDocumentNumber';

interface PatientIdentityCardProps {
  patient: PatientDetail;
  /** Called after "Mover al responsable" grava com sucesso, para o pai refazer o fetch. */
  onSaved?: () => void;
}

/**
 * Spec 014 (US-D3, lex D3.1): entre os responsáveis do paciente, qual tem o MESMO telefone
 * (últimos 8 dígitos) que `patient.phoneWhatsapp` — só para nomear o aviso; o boolean que decide
 * SE o aviso aparece (`phoneMatchesResponsible`) vem pronto do backend (fonte única da regra).
 */
function findMatchingResponsibleName(patient: PatientDetail): string | null {
  const patientLast8 = (patient.phoneWhatsapp ?? '').replace(/\D/g, '').slice(-8);
  if (patientLast8.length < 8) return null;
  const match = patient.responsibles.find(
    (r) => (r.phone ?? '').replace(/\D/g, '').slice(-8) === patientLast8,
  );
  if (!match) return null;
  return [match.firstName, match.lastName].filter(Boolean).join(' ') || null;
}

// PatientStatus v2 (spec 012, US-B7): funil de admissão + seis estados clínicos. O rótulo vem
// de `admin.patients.statusOptions.<STATUS>` (mesmo vocabulário do select, do Kanban e do Historial).
const STATUS_COLORS: Record<string, string> = {
  SOLICITANTE: 'bg-slate-100 text-slate-700',
  ADMISSION: 'bg-blue-100 text-blue-700',
  PENDING_ADMISSION: 'bg-yellow-100 text-yellow-700',
  ACTIVE: 'bg-green-100 text-green-700',
  ON_HOLD: 'bg-amber-100 text-amber-700',
  SEARCHING: 'bg-sky-100 text-sky-700',
  REPLACEMENT: 'bg-indigo-100 text-indigo-700',
  SUSPENDED: 'bg-orange-100 text-orange-700',
  DISCHARGED: 'bg-gray-100 text-gray-600',
};

function formatDate(iso: string | null, locale = 'es-AR'): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString(locale);
  } catch {
    return iso;
  }
}

function buildAddress(patient: PatientDetail): string | null {
  const addr = patient.addresses?.[0];
  // Contrato real da API (spec 011 A2): `addressFormatted`/`addressRaw`, não `fullAddress`.
  const formatted = addr?.addressFormatted ?? addr?.addressRaw;
  if (formatted) return formatted;
  const parts = [
    patient.zoneNeighborhood,
    patient.cityLocality,
    patient.province,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

/**
 * Spec 018 PR-3 (FR-208/209/210/224, US-8, D-A): o cabeçalho mostra o contato de EMERGÊNCIA
 * MARCADO (`emergencyContactRef` — spec 018 PR-2), nunca mais o `find(isPrimary) ??
 * responsibles[0]` que a `ResponsibleSection` antiga usava (esse fallback SAIU daqui — FR-224
 * proíbe reproduzi-lo: "sem fallback" é justamente não inventar um "principal" que ninguém
 * marcou). A duplicata com a `FamiliaresCard` (que mostra TODOS os responsáveis, número
 * completo) também sai — FR-210 nomeia essa remoção.
 *
 * TRÊS estados, sem fallback entre eles (FR-224):
 *   1. `redacted`    — `externalContacts === null` (D113: sem `patient_family:read`, o backend
 *                      nula os 4 campos do container `family` juntos) → marcador de redação.
 *   2. `notSet`      — tem a célula, mas `emergencyContactRef` é `null` → "não definido".
 *   3. `contact`     — tem a célula e a marca aponta para um responsável ou contato externo.
 */
type EmergencyContactBlockState =
  | { kind: 'redacted' }
  | { kind: 'notSet' }
  | {
      kind: 'contact';
      isExternal: boolean;
      name: string;
      phone: string | null;
      documentTypeLabelKey: string | null;
      documentNumberMasked: string | null;
      email: string | null;
    };

function resolveEmergencyContactBlock(patient: PatientDetail): EmergencyContactBlockState {
  // D113: os 4 campos do container `family` (responsibles/externalContacts/phoneMatchesResponsible/
  // emergencyContactRef) saem juntos como `null` quando falta `patient_family:read` — checar
  // QUALQUER um deles delataria o mesmo tanto; `externalContacts` é o já documentado no domínio.
  if (patient.externalContacts === null || patient.externalContacts === undefined) {
    return { kind: 'redacted' };
  }
  const ref = patient.emergencyContactRef;
  if (!ref) return { kind: 'notSet' };

  if (ref.kind === 'RESPONSIBLE') {
    const r = patient.responsibles.find((x) => x.id === ref.id);
    if (!r) return { kind: 'notSet' }; // marca órfã (não deveria acontecer; nunca quebra a tela)
    return {
      kind: 'contact',
      isExternal: false,
      name: [r.firstName, r.lastName].filter(Boolean).join(' ') || '—',
      phone: r.phone,
      documentTypeLabelKey: r.documentType ? `admin.patients.detail.documentTypes.${r.documentType}` : null,
      documentNumberMasked: maskDocumentNumber(r.documentNumber),
      email: r.email,
    };
  }
  // D-A #6: contato externo não tem coluna de documento — rótulo "do contato", sem documento.
  const c = patient.externalContacts.find((x) => x.id === ref.id);
  if (!c) return { kind: 'notSet' };
  return {
    kind: 'contact',
    isExternal: true,
    name: c.name || '—',
    phone: c.phone,
    documentTypeLabelKey: null,
    documentNumberMasked: null,
    email: null,
  };
}

export function PatientIdentityCard({ patient, onSaved }: PatientIdentityCardProps) {
  const { t } = useTranslation();
  const [phoneWarningDismissed, setPhoneWarningDismissed] = useState(false);
  const [confirmingMove, setConfirmingMove] = useState(false);
  const [movingPhone, setMovingPhone] = useState(false);
  /**
   * F4 — o `try/finally` desta ação NÃO tinha `catch`, e a ação APAGA o WhatsApp do paciente
   * (`{phoneWhatsapp: null}`). Se o PATCH rejeitasse, nada era renderizado, `onSaved()` não
   * rodava, e o único sinal era o spinner parando com o modal aberto: a operadora não distinguia
   * "não salvou" de "salvou e a tela não atualizou" — e clicava de novo. Ação destrutiva não
   * pode falhar em silêncio.
   */
  const [moveError, setMoveError] = useState<string | null>(null);

  const showPhoneWarning = patient.phoneMatchesResponsible && !phoneWarningDismissed;
  const matchingResponsibleName = showPhoneWarning ? findMatchingResponsibleName(patient) : null;

  const handleMovePhone = async () => {
    setMoveError(null);
    setMovingPhone(true);
    try {
      // Só o campo do PACIENTE — o do responsável nunca é tocado (lex D3.1: "sem apagar").
      await AdminApiService.updatePatientSection(patient.id, 'general', { phoneWhatsapp: null });
      setConfirmingMove(false);
      onSaved?.();
    } catch {
      // Falhou: o modal FICA aberto com a mensagem. Nada foi apagado, e ela sabe disso.
      setMoveError(t('admin.patients.detail.identityCard.movePhoneError'));
    } finally {
      setMovingPhone(false);
    }
  };

  const statusKey = patient.status ?? '';
  const statusColor = STATUS_COLORS[statusKey] ?? 'bg-gray-100 text-gray-600';
  const statusLabel = statusKey ? t(`admin.patients.statusOptions.${statusKey}`, statusKey) : '—';
  // Motivo da espera (rótulo de catálogo, não a nota): só quando o estado é ON_HOLD.
  const onHoldReasonLabel = statusKey === 'ON_HOLD' && patient.onHoldReason
    ? t(`admin.patients.onHoldReasonOptions.${patient.onHoldReason}`, patient.onHoldReason)
    : null;
  const address = buildAddress(patient);
  // FR-204: chip/linha de alta SÓ com status ATUAL DISCHARGED (não "já foi DISCHARGED alguma
  // vez" — REGRA-17, um nome só, SUP-1). dischargedAt vem do backend já filtrado pela mesma
  // condição (último DISCHARGED em patient_status_history), mas o status atual é quem decide a
  // EXIBIÇÃO — reabrir um paciente (ex.: ACTIVE de novo) não deve reexibir a alta antiga.
  const isDischarged = statusKey === 'DISCHARGED';
  const dischargedAtLabel = isDischarged ? formatDate(patient.dischargedAt ?? null) : null;
  const emergencyBlock = resolveEmergencyContactBlock(patient);

  return (
    <div
      className="bg-white rounded-card border-[1.5px] border-gray-700 p-6 sm:px-8 sm:py-10 flex flex-col gap-4"
      data-testid="patient-identity-card"
    >
      <div className="flex items-center gap-4 mb-2">
        <div className="w-14 h-14 rounded-full bg-gray-200 flex items-center justify-center text-gray-600 shrink-0">
          <User className="w-8 h-8" />
        </div>
        <div className="min-w-0">
          {/* 06/09: o NOME saiu daqui — subiu para o `h1` da página, a 100px acima. Repetir os dois
              não era só redundância visual: `getByText(nome)` passou a resolver DOIS elementos e
              três e2e quebraram em strict mode. O cartão mantém o que é dele — avatar, estado,
              motivo da espera, número do caso e os campos de contato. */}
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex px-2.5 py-0.5 rounded-full ${statusColor}`} data-testid="patient-status-badge">
              <Text as="span" size="xs" weight="medium" color="inherit">
                {statusLabel}
              </Text>
            </span>
            {onHoldReasonLabel && (
              <span className="inline-flex px-2.5 py-0.5 rounded-full bg-amber-50 text-amber-700" data-testid="patient-on-hold-reason">
                <Text as="span" size="xs" weight="medium" color="inherit">
                  {onHoldReasonLabel}
                </Text>
              </span>
            )}
            {patient.lastCaseNumber != null && (
              <span className="inline-flex px-2.5 py-0.5 rounded-full bg-purple-100 text-purple-700">
                <Text as="span" size="xs" weight="semibold" color="inherit">
                  {t('admin.patients.detail.caseNumber')} #{patient.lastCaseNumber}
                </Text>
              </span>
            )}
            {/* FR-204 (REGRA-17, SUP-1): mesmo rótulo do status ATUAL, chip pílula salmão/branco,
                SÓ quando status === DISCHARGED — o texto NÃO é um segundo nome para o mesmo estado. */}
            {isDischarged && (
              <span className="inline-flex px-2.5 py-0.5 rounded-full bg-rose-300" data-testid="patient-discharge-chip">
                <Text as="span" size="xs" weight="medium" color="inherit" className="!text-white">
                  {statusLabel}
                </Text>
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        <FieldPairGrid>
          {/* D3.1: rótulo CORRIGIDO — mostrava "Teléfono del Responsable" para o telefone do
              PACIENTE. O valor não muda, só o nome do campo (dado já certo, rótulo estava errado). */}
          <FieldPair label={t('admin.patients.detail.identityCard.patientWhatsapp')} value={patient.phoneWhatsapp} />
          {/* E-mail do paciente EM CLARO (lex A4: é o contato do titular na ficha dele); a
              máscara do Clarity vai no DOM porque o modo do dashboard é configuração remota
              que ninguém aqui controla (lex C4.2). */}
          <div data-clarity-mask="True" className="flex flex-col min-w-0">
            <FieldPair label={t('admin.patients.detail.identityCard.patientEmail')} value={patient.contactEmail} testId="patient-contact-email" />
          </div>
          <FieldPair label={t('admin.patients.detail.identityCard.admission')} value={formatDate(patient.createdAt)} />
          <FieldPair label={t('admin.patients.detail.identityCard.lastUpdate')} value={formatDate(patient.updatedAt)} />
          {/*
           * Spec 014 US-D2 removeu "Desligamiento" porque não havia coluna (era `value={null}`
           * fixo). Spec 018 PR-3 (FR-203) TRAZ DE VOLTA com fonte real: o último DISCHARGED em
           * `patient_status_history` (a mesma tabela da aba Historial — lex CONDIÇÃO 6: nenhuma
           * célula nova, mesmo `patient:read` que a aba já exige). SÓ aparece com status atual
           * DISCHARGED (FR-204).
           */}
          {/* Reusa a chave `discharge` já existente (i18n legado da spec 014 US-D2 — nunca consumida). */}
          {isDischarged && (
            <FieldPair label={t('admin.patients.detail.identityCard.discharge')} value={dischargedAtLabel} testId="patient-discharged-at" />
          )}
          {/* Rua + número é texto: o Clarity (Balanced) não mascara sozinho (lex C2.1; QA 🔴2). */}
          {address && (
            <div data-clarity-mask="True" className="flex flex-col min-w-0 sm:col-span-2">
              <FieldPair label={t('admin.patients.detail.identityCard.address')} value={address} testId="patient-address" />
            </div>
          )}
        </FieldPairGrid>
        {showPhoneWarning && (
          <div
            className="flex flex-col gap-2 rounded-lg border border-amber-400 bg-amber-50 px-4 py-3"
            data-testid="phone-match-warning"
          >
            <div className="flex items-start gap-2">
              <TriangleAlert className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <Text size="sm" className="text-amber-800">
                {t('admin.patients.detail.identityCard.phoneMatchWarning', {
                  name: matchingResponsibleName ?? '—',
                })}
              </Text>
            </div>
            <div className="flex items-center gap-2">
              {/* D286 — grava PATCH /patients/:id/general (telefone) → patient_identity:write. */}
              <ActionButton
                resource="patient_identity"
                action="write"
                variant="outline"
                size="sm"
                onClick={() => setConfirmingMove(true)}
                data-testid="move-phone-to-responsible-btn"
              >
                {t('admin.patients.detail.identityCard.movePhoneToResponsible')}
              </ActionButton>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPhoneWarningDismissed(true)}
                data-testid="keep-phone-btn"
              >
                {t('admin.patients.detail.identityCard.keepPhone')}
              </Button>
            </div>
          </div>
        )}
      </div>

      {confirmingMove && (
        <>
          <div
            className="fixed inset-0 bg-black/50 z-40"
            onClick={() => !movingPhone && setConfirmingMove(false)}
            data-testid="move-phone-confirm-backdrop"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t('admin.patients.detail.identityCard.movePhoneConfirmTitle')}
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-full max-w-md bg-white rounded-2xl shadow-2xl p-6 flex flex-col gap-4"
            data-testid="move-phone-confirm-modal"
          >
            <Heading level={3} weight="semibold" color="primary">
              {t('admin.patients.detail.identityCard.movePhoneConfirmTitle')}
            </Heading>
            <Text size="sm" color="secondary">
              {t('admin.patients.detail.identityCard.movePhoneConfirmBody')}
            </Text>
            {moveError && (
              <Text size="sm" role="alert" className="text-red-600" data-testid="move-phone-error">
                {moveError}
              </Text>
            )}
            <div className="flex items-center justify-end gap-3 mt-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmingMove(false)}
                disabled={movingPhone}
                data-testid="move-phone-cancel-btn"
              >
                {t('admin.patients.activate.cancel')}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={handleMovePhone}
                isLoading={movingPhone}
                data-testid="move-phone-confirm-btn"
              >
                {t('admin.patients.detail.identityCard.movePhoneToResponsible')}
              </Button>
            </div>
          </div>
        </>
      )}

      {/*
       * FR-208/209/210/211/224 (US-8, D-A): o contato de emergência é o MARCADO — nunca mais o
       * `find(isPrimary) ?? responsibles[0]`. Lê SÓ do container `family` (o próprio dado já vem
       * `null` do backend sem `patient_family:read` — D286); documento SEMPRE mascarado ANTES do
       * render (`maskDocumentNumber`, FR-210); `data-clarity-mask` no bloco inteiro (FR-211).
       */}
      <div className="border-t border-gray-200 pt-4" data-clarity-mask="True" data-testid="patient-emergency-contact-section">
        <FieldGroupTitle>{t('admin.patients.detail.identityCard.emergencyContactTitle')}</FieldGroupTitle>
        {emergencyBlock.kind === 'redacted' && (
          <Text size="sm" color="secondary" data-testid="emergency-contact-redacted">
            {t('admin.patients.detail.identityCard.emergencyContactRedacted')}
          </Text>
        )}
        {emergencyBlock.kind === 'notSet' && (
          <Text size="sm" color="secondary" data-testid="emergency-contact-not-set">
            {t('admin.patients.detail.identityCard.emergencyContactNotSet')}
          </Text>
        )}
        {emergencyBlock.kind === 'contact' && (
          <FieldPairGrid>
            <FieldPair
              label={t(emergencyBlock.isExternal
                ? 'admin.patients.detail.identityCard.emergencyContactNameExternal'
                : 'admin.patients.detail.identityCard.responsibleName')}
              value={emergencyBlock.name}
              testId="emergency-contact-name"
            />
            <FieldPair
              label={t(emergencyBlock.isExternal
                ? 'admin.patients.detail.identityCard.emergencyContactPhoneExternal'
                : 'admin.patients.detail.identityCard.responsiblePhone')}
              value={emergencyBlock.phone}
              testId="emergency-contact-phone"
            />
            {/* D-A #6: contato externo não tem coluna de documento — o par some, não "—" fixo. */}
            {!emergencyBlock.isExternal && (
              <>
                <FieldPair
                  label={t('admin.patients.detail.identityCard.documentType')}
                  value={emergencyBlock.documentTypeLabelKey ? t(emergencyBlock.documentTypeLabelKey) : null}
                />
                <FieldPair
                  label={t('admin.patients.detail.identityCard.emergencyContactDocumentNumber')}
                  value={emergencyBlock.documentNumberMasked}
                  testId="emergency-contact-document-number"
                />
              </>
            )}
            {emergencyBlock.email && (
              <FieldPair label={t('admin.patients.detail.identityCard.email')} value={emergencyBlock.email} full />
            )}
          </FieldPairGrid>
        )}
      </div>
    </div>
  );
}
