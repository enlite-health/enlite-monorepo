import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { ActionButton } from '@presentation/components/features/access';
import type { PatientDetail } from '@domain/entities/PatientDetail';
import { chatRolesToDisplay, chatRoleLabel } from '@domain/value-objects/patientChatRole';
import { usePatientChatRoles } from '@presentation/hooks/usePatientChatRoles';
import { PatientChatIdsEditDrawer } from './edit/PatientChatIdsEditDrawer';

interface Props {
  patient: PatientDetail;
  onSaved?: () => void;
}

function Field({ label, value, testId }: { label: string; value: string | null; testId: string }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col min-w-0" data-testid={testId}>
      <Text size="sm" weight="medium" color="muted">{label}</Text>
      <Text size="sm" color={value ? 'primary' : 'muted'} className="font-mono break-all">
        {value ?? t('admin.patients.detail.chatIdsCard.notLinked')}
      </Text>
    </div>
  );
}

/**
 * PatientChatIdsCard — os grupos de WhatsApp (Periskope) do paciente, POR PAPEL.
 *
 * É a chave de join Postgres ↔ Periskope ↔ ClickUp que a auditoria de informes
 * (Candela) precisa. Exibe o valor cru de propósito: quem opera precisa poder
 * conferir o chat_id contra o Periskope sem clicar em nada.
 *
 * A lista de papéis e os RÓTULOS vêm do CATÁLOGO (`patient_chat_roles`, via
 * API), não deste arquivo nem do `es.json`: papel criado na tela de
 * administração aparece aqui sozinho, sem deploy. E papel que o paciente já tem
 * gravado mas saiu do catálogo continua visível — esconder um vínculo existente
 * seria pior que mostrar o código cru.
 */
export function PatientChatIdsCard({ patient, onSaved }: Props) {
  const { t, i18n } = useTranslation();
  const [editing, setEditing] = useState(false);
  const tc = (k: string) => t(`admin.patients.detail.chatIdsCard.${k}`);
  const { roles: catalog } = usePatientChatRoles();

  const chatIds = patient.chatIds ?? {};
  const roles = chatRolesToDisplay(catalog, chatIds);

  return (
    <div
      className="bg-white rounded-card border-[1.5px] border-gray-700 p-6 sm:px-8 sm:py-10 flex flex-col gap-4"
      data-testid="patient-chat-ids-card"
    >
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Heading level={1} as="h3" weight="semibold" color="primary">{tc('title')}</Heading>
        {/* D269 — abre o drawer que faz PUT /patients/:id/chat-ids → patient:write. */}
        <ActionButton
          resource="patient_chat"
          action="update"
          variant="primary"
          size="sm"
          onClick={() => setEditing(true)}
          data-testid="chat-ids-edit-btn"
        >
          {tc('link')}
        </ActionButton>
      </div>

      <Text size="sm" color="muted">{tc('subtitle')}</Text>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
        {roles.map(role => (
          <Field
            key={role}
            label={chatRoleLabel(catalog, role, i18n.language)}
            value={chatIds[role] ?? null}
            testId={`chat-id-${role}-value`}
          />
        ))}
      </div>

      {editing && (
        <PatientChatIdsEditDrawer
          patient={patient}
          catalog={catalog}
          onClose={() => setEditing(false)}
          onSaved={() => onSaved?.()}
        />
      )}
    </div>
  );
}
