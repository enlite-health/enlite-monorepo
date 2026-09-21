import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { ActionButton } from '@presentation/components/features/access';
import { formatDateFromISO } from '@presentation/hooks/useMask';
import { getSexLabel, getGenderLabel, getLanguageLabel } from './workerDetailLabels';
import { WorkerTagsArea } from './WorkerTagsArea';
import type { WorkerTagSummary } from '@domain/entities/WorkerTag';

interface WorkerPersonalInfoCardProps {
  workerId: string;
  birthDate: string | null;
  sex: string | null;
  gender: string | null;
  sexualOrientation: string | null;
  race: string | null;
  religion: string | null;
  languages: string[];
  weightKg: string | null;
  heightCm: string | null;
  tags?: WorkerTagSummary[];
  /** When provided, renders the Edit button (gateado por `worker:write` no call site) wired to this handler. */
  onEdit?: () => void;
  /**
   * D286: o dossiê (nascimento, sexo, gênero, orientação, raça, religião, peso, altura) é
   * `worker_pii:read`; idiomas e etiquetas são operacionais (`worker:read`). Sem a célula o card
   * fica só com o que é operacional — e sem o botão de editar, porque o modal pré-carrega o
   * dossiê e salvaria campos em branco por cima (quem não LÊ não EDITA).
   */
  showDossier?: boolean;
}

function Field({ label, value }: { label: string; value: string | null }) {
  // Defeito 4 (21/09/2026): KMSEncryptionService.decrypt devolve '' (não null) para
  // coluna nula, e AdminWorkersDetailBuilder faz `?? null` — que não pega string
  // vazia. String vazia/só-espaço é tratada como ausente aqui (front, sem mexer no
  // KMSEncryptionService compartilhado).
  const display = value != null && value.trim() !== '' ? value : null;
  return (
    <p className="leading-snug">
      <Text as="span" size="sm" weight="medium" color="secondary">{label} </Text>
      <Text as="span" size="sm" color="muted">{display ?? '—'}</Text>
    </p>
  );
}

export function WorkerPersonalInfoCard({
  workerId,
  birthDate,
  sex,
  gender,
  sexualOrientation,
  race,
  religion,
  languages,
  weightKg,
  heightCm,
  tags = [],
  onEdit,
  showDossier = true,
}: WorkerPersonalInfoCardProps) {
  const { t } = useTranslation();

  // Defeito 2 (21/09/2026): `new Date(birthDate).toLocaleDateString('pt-BR')`
  // decodifica a string ISO como meia-noite UTC e formata no fuso LOCAL — em
  // fusos negativos (ex.: Argentina, UTC-3) isso perde 1 dia ("1985-03-25" vira
  // "24/03/1985"). `formatDateFromISO` faz split de string, sem Date/fuso, e
  // devolve o valor cru quando não é ISO (nunca "Invalid Date").
  const formattedBirth = birthDate ? formatDateFromISO(birthDate) : null;

  return (
    <div data-testid="worker-personal-card" className="bg-white rounded-card border-[1.5px] border-gray-700 p-6 sm:px-8 sm:py-10 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <Heading level={1} as="h3">
          {t('admin.workerDetail.personalInfo')}
        </Heading>
        {/* PATCH /admin/workers/:id/profile + PUT /admin/workers/:id/service-area
            (via WorkerEditModal) → worker:write. D269 — sem a célula, SOME. */}
        {onEdit && showDossier && (
          <ActionButton resource="worker" action="update" variant="primary" size="sm" className="w-40 shrink-0" onClick={onEdit} data-testid="worker-edit-button">
            {t('admin.workerDetail.edit')}
          </ActionButton>
        )}
      </div>

      <div className="flex flex-col gap-2.5">
        {showDossier && (
          <>
            <Field label={`${t('admin.workerDetail.birthDate')}:`} value={formattedBirth} />
            <Field label={`${t('admin.workerDetail.sex')}:`} value={getSexLabel(t, sex)} />
            <Field label={`${t('admin.workerDetail.gender')}:`} value={getGenderLabel(t, gender)} />
            <Field label={`${t('admin.workerDetail.sexualOrientation')}:`} value={sexualOrientation} />
            <Field label={`${t('admin.workerDetail.race')}:`} value={race} />
            <Field label={`${t('admin.workerDetail.religion')}:`} value={religion} />
          </>
        )}
        <Field label={`${t('admin.workerDetail.languages')}:`} value={languages.length > 0 ? languages.map(l => getLanguageLabel(t, l)).join(', ') : null} />
        {showDossier && (
          <>
            <Field label={`${t('admin.workerDetail.weight')}:`} value={weightKg ? `${weightKg}kg` : null} />
            <Field label={`${t('admin.workerDetail.height')}:`} value={heightCm ? `${heightCm}m` : null} />
          </>
        )}
        <WorkerTagsArea workerId={workerId} initialTags={tags} />
      </div>
    </div>
  );
}
