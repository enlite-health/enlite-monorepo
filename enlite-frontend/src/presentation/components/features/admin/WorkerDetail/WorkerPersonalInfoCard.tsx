import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';
import { getSexLabel, getGenderLabel, getLanguageLabel } from './workerDetailLabels';

interface WorkerPersonalInfoCardProps {
  birthDate: string | null;
  sex: string | null;
  gender: string | null;
  sexualOrientation: string | null;
  race: string | null;
  religion: string | null;
  languages: string[];
  weightKg: string | null;
  heightCm: string | null;
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <p className="leading-snug">
      <Text as="span" size="sm" weight="medium" color="secondary">{label} </Text>
      <Text as="span" size="sm" color="muted">{value ?? '—'}</Text>
    </p>
  );
}

export function WorkerPersonalInfoCard({
  birthDate,
  sex,
  gender,
  sexualOrientation,
  race,
  religion,
  languages,
  weightKg,
  heightCm,
}: WorkerPersonalInfoCardProps) {
  const { t } = useTranslation();

  const formattedBirth = birthDate
    ? new Date(birthDate).toLocaleDateString('pt-BR')
    : null;

  return (
    <div className="bg-white rounded-card border-[1.5px] border-gray-700 p-6 sm:px-8 sm:py-10 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <Heading level={1} as="h3">
          {t('admin.workerDetail.personalInfo')}
        </Heading>
        <Button variant="primary" size="sm" className="w-40 shrink-0">
          {t('admin.workerDetail.edit')}
        </Button>
      </div>

      <div className="flex flex-col gap-2.5">
        <Field label={`${t('admin.workerDetail.birthDate')}:`} value={formattedBirth} />
        <Field label={`${t('admin.workerDetail.sex')}:`} value={getSexLabel(t, sex)} />
        <Field label={`${t('admin.workerDetail.gender')}:`} value={getGenderLabel(t, gender)} />
        <Field label={`${t('admin.workerDetail.sexualOrientation')}:`} value={sexualOrientation} />
        <Field label={`${t('admin.workerDetail.race')}:`} value={race} />
        <Field label={`${t('admin.workerDetail.religion')}:`} value={religion} />
        <Field label={`${t('admin.workerDetail.languages')}:`} value={languages.length > 0 ? languages.map(l => getLanguageLabel(t, l)).join(', ') : null} />
        <Field label={`${t('admin.workerDetail.weight')}:`} value={weightKg ? `${weightKg}kg` : null} />
        <Field label={`${t('admin.workerDetail.height')}:`} value={heightCm ? `${heightCm}m` : null} />
      </div>
    </div>
  );
}
