import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { ActionButton } from '@presentation/components/features/access';
import type { PatientDetail } from '@domain/entities/PatientDetail';
import { PatientCoverageEditDrawer } from './edit/PatientCoverageEditDrawer';
import type { DrawerFocusRequest } from '@hooks/admin/useAutoOpenDrawer';
import { DetailRow, DetailRows } from './DetailRows';
import { currentCoverageDisplay } from './currentCoverageText';
import { CoverageValue } from './CoverageValue';

interface CoberturaMedicaCardProps {
  patient: PatientDetail;
  /** Called after a successful edit so the page can refetch the detail. */
  onSaved?: () => void;
  /**
   * Mantido na assinatura (a página passa o mesmo pedido a todos os cartões), mas este cartão não o consome mais: desde a spec 087 o foco
   * "falta cobertura" abre o painel de contrato do SERVIÇO (`ServicosContratadosCard`), não o drawer de cobertura.
   */
  focusRequest?: DrawerFocusRequest | null;
}

/**
 * Cartão "Cobertura médica" (spec 087): a cobertura ATUAL é LIDA do serviço contratado — nunca mais da informada/verificada do paciente.
 * Uma linha só ("Cobertura actual"), decidida por `currentCoverageDisplay` (o mesmo decisor do cartão de identidade); Credencial e os
 * contatos de emergência continuam aqui porque só existem no paciente. A escrita do contrato é do serviço (`ServicosContratadosCard`).
 */
export function CoberturaMedicaCard({ patient, onSaved }: CoberturaMedicaCardProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  // 417 (D301.3b): `null` = sem célula (redação, D113) → "—"; AUSENTE (backend anterior à 417, deploy-skew) =
  // "não li", nunca "não tem" (D167) → indisponível, como o PDF já faz.
  const emergencyContacts = patient.coverageEmergencyContacts ?? [];
  // Serviço ativo sem vínculo vigente: o cartão aponta onde se resolve (o contrato vive no serviço).
  const hasUnlinked = (patient.currentCoverage?.unlinkedServices ?? 0) > 0;

  return (
    <div
      className="bg-white rounded-card border-[1.5px] border-gray-700 p-6 sm:px-8 sm:py-10 flex flex-col gap-4"
      data-testid="cobertura-medica-card"
    >
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Heading level={1} as="h3" weight="semibold" color="primary">
          {t('admin.patients.detail.coverageCard.title')}
        </Heading>
        {/* D286 — abre o drawer que faz PATCH /patients/:id/coverage → patient_coverage:update (PR-8b). Só Credencial + contatos (087). */}
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

      {/* 06/09: cartão de LARGURA CHEIA — linha com filete, valor ancorado à direita (a peça do Diagnóstico). */}
      <DetailRows>
        <DetailRow label={t('admin.patients.detail.identityCard.currentCoverage')} testId="coverage-current">
          <Text as="span" size="sm" color="muted" data-testid="coverage-current-value">
            <CoverageValue display={currentCoverageDisplay(t, patient.currentCoverage)} />
          </Text>
        </DetailRow>
        {hasUnlinked && (
          <p className="text-sm text-amber-700" data-testid="coverage-manage-in-service">
            {t('admin.patients.detail.coverageCard.manageInService')}
          </p>
        )}
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
