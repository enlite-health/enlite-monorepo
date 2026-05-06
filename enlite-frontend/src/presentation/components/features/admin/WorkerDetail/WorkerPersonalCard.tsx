import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';

interface WorkerPersonalCardProps {
  firstName: string | null;
  lastName: string | null;
  email: string;
  phone: string | null;
  whatsappPhone: string | null;
  profilePhotoUrl: string | null;
  birthDate: string | null;
  documentType: string | null;
  documentNumber: string | null;
  sex: string | null;
  gender: string | null;
}

function formatPhoneDisplay(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 13 && digits.startsWith('54')) {
    return `+54 9 ${digits.slice(3, 5)} ${digits.slice(5, 9)}-${digits.slice(9)}`;
  }
  if (digits.length === 13 && digits.startsWith('55')) {
    return `+55 ${digits.slice(2, 4)} ${digits.slice(4, 9)}-${digits.slice(9)}`;
  }
  if (digits.length >= 8) {
    return `+${digits}`;
  }
  return raw;
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex justify-between">
      <Text size="sm" color="secondary">{label}</Text>
      <Text size="sm" weight="medium">{value ?? '—'}</Text>
    </div>
  );
}

export function WorkerPersonalCard({
  firstName,
  lastName,
  email,
  phone,
  whatsappPhone,
  profilePhotoUrl,
  birthDate,
  documentType,
  documentNumber,
  sex,
  gender,
}: WorkerPersonalCardProps) {
  const { t } = useTranslation();
  const fullName = [firstName, lastName].filter(Boolean).join(' ') || '—';
  const formattedBirth = birthDate
    ? new Date(birthDate).toLocaleDateString('pt-BR')
    : null;
  const docDisplay = documentNumber
    ? `${documentType ?? '—'}: ${documentNumber}`
    : null;

  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 flex flex-col gap-4">
      <Heading level={1} as="h3" color="secondary">
        {t('admin.workerDetail.personalData')}
      </Heading>
      <div className="flex items-center gap-4 mb-2">
        {profilePhotoUrl ? (
          <img
            src={profilePhotoUrl}
            alt={fullName}
            className="w-14 h-14 rounded-full object-cover border border-slate-200"
          />
        ) : (
          <div className="w-14 h-14 rounded-full bg-slate-100 flex items-center justify-center">
            <Text size="xl" weight="semibold" color="inherit" className="text-slate-400">
              {(firstName?.[0] ?? email[0] ?? '?').toUpperCase()}
            </Text>
          </div>
        )}
        <div>
          <Text size="sm" weight="semibold">{fullName}</Text>
          <Text size="sm" color="secondary">{email}</Text>
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <Field label={t('admin.workerDetail.phone')} value={formatPhoneDisplay(phone)} />
        <Field label={t('admin.workerDetail.whatsapp')} value={formatPhoneDisplay(whatsappPhone)} />
        <Field label={t('admin.workerDetail.birthDate')} value={formattedBirth} />
        <Field label={t('admin.workerDetail.document')} value={docDisplay} />
        <Field label={t('admin.workerDetail.sex')} value={sex} />
        <Field label={t('admin.workerDetail.gender')} value={gender} />
      </div>
    </div>
  );
}
