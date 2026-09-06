import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { User, TriangleAlert } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { PatientDetail, PatientResponsibleDetail } from '@domain/entities/PatientDetail';
import { FieldPair, FieldPairGrid, FieldGroupTitle } from './FieldPairs';

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
 * O bloco do responsável (Gabriel, 06/09: "pode ser Contacto del responsable principal, pois o
 * paciente pode ter vários responsáveis porém sempre vai ter um principal").
 *
 * 🔒 `isPrimary` decide o TÍTULO, não só a ordem. O card escolhe o responsável com
 * `find(isPrimary) ?? responsibles[0]` — e nesse fallback ninguém elegeu ninguém. Chamar de
 * "principal" quem só é o primeiro da lista é a tela AFIRMAR o que o dado não diz; então o
 * fallback fica com o título neutro. O dado mostrado é o mesmo nos dois casos: nada some.
 */
// `t` vem do hook aqui dentro, não por prop: o `TFunction` do i18next tem sobrecargas (o 2º
// argumento é opções OU defaultValue) que nenhuma assinatura manual reproduz — tipá-la à mão
// fazia o tsc reprovar o fallback do parentesco. Mesmo padrão do FamiliaresCard.
function ResponsibleSection({ responsible, isPrimary }: { responsible: PatientResponsibleDetail; isPrimary: boolean }) {
  const { t } = useTranslation();
  const name = [responsible.firstName, responsible.lastName].filter(Boolean).join(' ') || '—';
  const docParts = [
    responsible.documentType ? t(`admin.patients.detail.documentTypes.${responsible.documentType}`) : null,
    responsible.documentNumber,
  ].filter(Boolean);
  const doc = docParts.length > 0 ? docParts.join(' ') : null;
  // 🔒 O 2º argumento é o FALLBACK para o valor cru, como em FamiliaresCard:88. Sem ele, um
  // parentesco fora do catálogo (o enum do banco tem 9 valores; a base pode ter outros) imprime a
  // CHAVE i18n inteira na tela — `admin.patients.detail.relationshipOptions.XPTO`. Pego no print,
  // não nos testes: `expectNoRawEnumLeaks` procura ALL_CAPS solto, e a chave inteira não casa com
  // esse padrão — ou seja, a versão SEM fallback escapa justamente do guard que existe para isso.
  const relationship = responsible.relationship
    ? t(`admin.patients.detail.relationshipOptions.${responsible.relationship}`, responsible.relationship)
    : null;

  return (
    <div className="mt-1">
      <FieldGroupTitle>
        {t(isPrimary
          ? 'admin.patients.detail.identityCard.primaryResponsibleContact'
          : 'admin.patients.detail.identityCard.responsibleContact')}
      </FieldGroupTitle>
      <FieldPairGrid>
        <FieldPair label={t('admin.patients.detail.identityCard.responsibleName')} value={name} />
        <FieldPair label={t('admin.patients.detail.identityCard.relationship')} value={relationship} />
        <FieldPair label={t('admin.patients.detail.identityCard.responsiblePhone')} value={responsible.phone} />
        <FieldPair label={t('admin.patients.detail.identityCard.documentType')} value={doc} />
        {responsible.email && (
          <FieldPair label={t('admin.patients.detail.identityCard.email')} value={responsible.email} full />
        )}
      </FieldPairGrid>
    </div>
  );
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

  const fullName = [patient.firstName, patient.lastName].filter(Boolean).join(' ') || '—';
  const statusKey = patient.status ?? '';
  const statusColor = STATUS_COLORS[statusKey] ?? 'bg-gray-100 text-gray-600';
  const statusLabel = statusKey ? t(`admin.patients.statusOptions.${statusKey}`, statusKey) : '—';
  // Motivo da espera (rótulo de catálogo, não a nota): só quando o estado é ON_HOLD.
  const onHoldReasonLabel = statusKey === 'ON_HOLD' && patient.onHoldReason
    ? t(`admin.patients.onHoldReasonOptions.${patient.onHoldReason}`, patient.onHoldReason)
    : null;
  const address = buildAddress(patient);
  const markedPrimary = patient.responsibles?.find((r) => r.isPrimary) ?? null;
  const primaryResponsible = markedPrimary ?? patient.responsibles?.[0] ?? null;

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
          <Heading level={1} as="h3" weight="semibold" color="primary" className="truncate">
            {fullName}
          </Heading>
          <div className="flex flex-wrap items-center gap-2 mt-1">
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
          {/* Spec 014 US-D2: "Desligamiento" REMOVIDO — era `value={null}` fixo, sem coluna no
              banco (a fonte real é `patient_status_history`, aba Historial). */}
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
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmingMove(true)}
                data-testid="move-phone-to-responsible-btn"
              >
                {t('admin.patients.detail.identityCard.movePhoneToResponsible')}
              </Button>
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

      {primaryResponsible && (
        <div className="border-t border-gray-200 pt-4">
          <ResponsibleSection responsible={primaryResponsible} isPrimary={markedPrimary !== null} />
        </div>
      )}
    </div>
  );
}
