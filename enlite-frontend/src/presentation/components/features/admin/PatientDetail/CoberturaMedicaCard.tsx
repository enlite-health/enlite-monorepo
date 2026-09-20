import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { ActionButton } from '@presentation/components/features/access';
import type { PatientDetail } from '@domain/entities/PatientDetail';
import { PatientCoverageEditDrawer } from './edit/PatientCoverageEditDrawer';
import { useAutoOpenDrawer, type DrawerFocusRequest } from '@hooks/admin/useAutoOpenDrawer';
import { DetailRow, DetailRows } from './DetailRows';

interface CoberturaMedicaCardProps {
  patient: PatientDetail;
  /** Called after a successful edit so the page can refetch the detail. */
  onSaved?: () => void;
  /** Spec 014 US-D1: pedido de foco do checklist ("falta cobertura") — abre este drawer. */
  focusRequest?: DrawerFocusRequest | null;
}

export function CoberturaMedicaCard({ patient, onSaved, focusRequest }: CoberturaMedicaCardProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  useAutoOpenDrawer(focusRequest, 'COVERAGE', () => setEditing(true));
  // Spec 012, US-B3: as verificadas por CÓDIGO do catálogo (traduzidas); o escalar antigo
  // (`insuranceVerified`, rótulo cru do ClickUp) só aparece quando não há código nenhum.
  const codes = patient.insuranceVerifiedCodes ?? [];
  // 417 (D301.3b): `null` = sem célula (redação, D113) → "—"; AUSENTE (backend anterior à 417, deploy-skew) =
  // "não li", nunca "não tem" (D167) → indisponível, como o PDF já faz.
  const emergencyContacts = patient.coverageEmergencyContacts ?? [];
  const verifiedLabel = codes.length > 0
    ? codes.map((c) => t(`admin.patients.insuranceProviderOptions.${c}`, c)).join(', ')
    : patient.insuranceVerified;

  return (
    <div
      className="bg-white rounded-card border-[1.5px] border-gray-700 p-6 sm:px-8 sm:py-10 flex flex-col gap-4"
      data-testid="cobertura-medica-card"
    >
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Heading level={1} as="h3" weight="semibold" color="primary">
          {t('admin.patients.detail.coverageCard.title')}
        </Heading>
        {/* D286 — abre o drawer que faz PATCH /patients/:id/coverage → patient_coverage:update (PR-8b). */}
        <ActionButton resource="patient_coverage" action="update" variant="outline" size="sm" onClick={() => setEditing(true)} className="w-28" data-testid="edit-coverage-btn">
          {t('admin.patients.detail.edit')}
        </ActionButton>
      </div>

      {editing && (
        <PatientCoverageEditDrawer
          patient={patient}
          onClose={() => setEditing(false)}
          onSaved={() => onSaved?.()}
        />
      )}

      {/* 06/09: cartão de LARGURA CHEIA com três campos — mesma peça do Diagnóstico (linha com
          filete, valor ancorado à direita), não a grade de pares dos cartões estreitos do topo.
          Antes eram duas colunas num container de ~1376px: metade da largura sem uso e a terceira
          célula sozinha na linha. */}
      <DetailRows>
        <DetailRow label={t('admin.patients.detail.coverageCard.providerName')}>
          <Text as="span" size="sm" color="muted">{patient.insuranceInformed ?? '—'}</Text>
        </DetailRow>
        <DetailRow label={t('admin.patients.detail.coverageCard.verified')} testId="coverage-verified">
          <Text as="span" size="sm" color="muted">{verifiedLabel ?? '—'}</Text>
        </DetailRow>
        <DetailRow label={t('admin.patients.detail.coverageCard.credential')}>
          <Text as="span" size="sm" color="muted">{patient.affiliateId ?? '—'}</Text>
        </DetailRow>
        {/* Spec 014 US-D2 tirou "Números de Emergencia" (era `null` fixo). Volta em 08/09 com dado de
            verdade (417; D301.3b — Ana): a lista de contatos de emergência da COBERTURA. */}
        <DetailRow label={t('admin.patients.detail.coverageCard.emergencyContacts')} testId="coverage-emergency-contacts">
          {/* lex C2.1 (molde EquipeTratanteCard): nome de profissional é texto — o Clarity não o mascara sozinho; o bloco inteiro leva a máscara. */}
          <div className="flex flex-col gap-0.5 text-right" data-clarity-mask="True">
            {patient.coverageEmergencyContactsUnavailable || patient.coverageEmergencyContacts === undefined ? (
              <Text as="span" size="sm" className="text-amber-700" data-testid="coverage-emergency-contacts-unavailable">{t('admin.patients.detail.coverageCard.emergencyContactsUnavailable')}</Text>
            ) : emergencyContacts.length === 0 ? (
              <Text as="span" size="sm" color="muted">—</Text>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {emergencyContacts.map((c) => (
                  <li key={c.id} data-testid={`coverage-emergency-contact-${c.kind}`}>
                    <Text as="span" size="sm" color="muted">{t(`admin.patients.detail.coverageCard.emergencyContactKinds.${c.kind}`, c.kind)}: {c.name} · {c.phone}</Text>
                  </li>
                ))}
              </ul>
            )}
            {/* lex C3: a lista NÃO é completa para quem não lê a equipe — dizer, em vez de fingir. */}
            {patient.coverageDirectProfessionalRedacted && (
              <Text as="span" size="xs" color="muted" data-testid="coverage-direct-professional-redacted">{t('admin.patients.detail.coverageCard.directProfessionalRedacted')}</Text>
            )}
          </div>
        </DetailRow>
      </DetailRows>
    </div>
  );
}
