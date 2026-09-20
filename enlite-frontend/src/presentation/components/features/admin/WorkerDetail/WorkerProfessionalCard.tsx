import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { ExternalLink } from 'lucide-react';
import {
  getProfessionLabel,
  getKnowledgeLevelLabel,
  getExperienceTypeLabel,
  getYearsExperienceLabel,
  getAgeRangeLabel,
  getLanguageLabel,
} from './workerDetailLabels';

interface WorkerProfessionalCardProps {
  profession: string | null;
  occupation: string | null;
  knowledgeLevel: string | null;
  titleCertificate: string | null;
  experienceTypes: string[];
  yearsExperience: string | null;
  preferredTypes: string[];
  preferredAgeRange: string[];
  languages: string[];
  linkedinUrl: string | null;
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex justify-between">
      <Text size="sm" color="secondary">{label}</Text>
      <Text size="sm" weight="medium">{value ?? '—'}</Text>
    </div>
  );
}

function ArrayField({ label, values }: { label: string; values: string[] }) {
  return (
    <div className="flex justify-between items-start">
      <Text size="sm" color="secondary" className="shrink-0">{label}</Text>
      <div className="flex flex-wrap justify-end gap-1 ml-4">
        {values.length > 0 ? (
          values.map((v) => (
            <span key={v} className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
              <Text as="span" size="xs" color="inherit">{v}</Text>
            </span>
          ))
        ) : (
          <Text size="sm" weight="medium">—</Text>
        )}
      </div>
    </div>
  );
}

export function WorkerProfessionalCard({
  profession,
  occupation,
  knowledgeLevel,
  titleCertificate,
  experienceTypes,
  yearsExperience,
  preferredTypes,
  preferredAgeRange,
  languages,
  linkedinUrl,
}: WorkerProfessionalCardProps) {
  const { t } = useTranslation();

  return (
    <div data-testid="worker-professional-card" className="bg-white rounded-card border-2 border-gray-600 p-6 sm:px-8 sm:py-10 flex flex-col gap-4">
      <Heading level={1} as="h3" color="secondary">
        {t('admin.workerDetail.professionalData')}
      </Heading>
      <div className="flex flex-col gap-3">
        <Field label={t('admin.workerDetail.profession')} value={getProfessionLabel(t, profession)} />
        <Field label={t('admin.workerDetail.occupation')} value={occupation} />
        <Field label={t('admin.workerDetail.knowledgeLevel')} value={getKnowledgeLevelLabel(t, knowledgeLevel)} />
        <Field label={t('admin.workerDetail.titleCertificate')} value={titleCertificate} />
        <Field label={t('admin.workerDetail.yearsExperience')} value={getYearsExperienceLabel(t, yearsExperience)} />
        <ArrayField label={t('admin.workerDetail.preferredAgeRange')} values={preferredAgeRange.map(v => getAgeRangeLabel(t, v))} />
        <ArrayField label={t('admin.workerDetail.experienceTypes')} values={experienceTypes.map(v => getExperienceTypeLabel(t, v))} />
        <ArrayField label={t('admin.workerDetail.preferredTypes')} values={preferredTypes.map(v => getExperienceTypeLabel(t, v))} />
        <ArrayField label={t('admin.workerDetail.languages')} values={languages.map(v => getLanguageLabel(t, v))} />
        {linkedinUrl && (
          <div className="flex justify-between items-center">
            <Text size="sm" color="secondary">{t('admin.workerDetail.linkedin')}</Text>
            <a
              href={linkedinUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-blue-600 hover:underline"
            >
              <Text as="span" size="sm" color="inherit">{t('admin.workerDetail.viewProfile')}</Text>
              <ExternalLink className="w-3 h-3" />
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
