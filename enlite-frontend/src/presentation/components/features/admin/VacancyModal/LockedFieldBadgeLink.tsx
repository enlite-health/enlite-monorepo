/**
 * LockedFieldBadgeLink
 *
 * Link "Editar en la ficha del paciente" ao lado de um grupo de campo travado pela origem (F3/
 * fase 1, `completar-vacante-em-rascunho`) — reusado pelos 4 grupos do passo 1 cuja coluna está
 * em `locked_fields` (fase-4.md "O que implementa"): endereço, faixa etária, quantidade de
 * profissionais e horário. Abre em nova aba — o operador não perde o progresso do wizard (a
 * guarda de saída da mesma fase protege a navegação DENTRO do wizard, não esta).
 */
import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';

export interface LockedFieldBadgeLinkProps {
  patientId: string | null | undefined;
  testId: string;
}

export function LockedFieldBadgeLink({ patientId, testId }: LockedFieldBadgeLinkProps): JSX.Element | null {
  const { t } = useTranslation();
  if (!patientId) return null;

  return (
    <a
      href={`/admin/patients/${patientId}`}
      target="_blank"
      rel="noopener noreferrer"
      data-testid={testId}
      className="inline-flex items-center gap-1 shrink-0 hover:opacity-80 transition-opacity"
    >
      <Text as="span" size="xs" weight="medium" color="inherit" className="text-[#180149] underline underline-offset-2">
        {t('admin.vacancyModal.lockedFieldLink')}
      </Text>
      <ExternalLink className="w-3 h-3 text-[#180149]" aria-hidden="true" />
    </a>
  );
}
