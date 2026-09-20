import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { getPlatformLabel } from '@presentation/pages/admin/workersData';
import { getDocumentTypeLabel } from './workerDetailLabels';

interface WorkerContactCardProps {
  status: string;
  firstName: string | null;
  lastName: string | null;
  email: string;
  phone: string | null;
  whatsappPhone: string | null;
  profilePhotoUrl: string | null;
  documentType: string | null;
  documentNumber: string | null;
  platform: string;
  dataSources: string[];
  createdAt: string;
  updatedAt: string;
}

const STATUS_COLORS: Record<string, string> = {
  REGISTERED: 'bg-turquoise/20 text-primary',
  INCOMPLETE_REGISTER: 'bg-wait/20 text-yellow-700',
  DISABLED: 'bg-cancelled/20 text-red-700',
};

const STATUS_I18N_KEYS: Record<string, string> = {
  REGISTERED: 'admin.workerDetail.statusRegistered',
  INCOMPLETE_REGISTER: 'admin.workerDetail.statusIncomplete',
  DISABLED: 'admin.workerDetail.statusDisabled',
};

function formatPhoneDisplay(raw: string | null): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 13 && digits.startsWith('54')) {
    return `+54 9 ${digits.slice(3, 5)} ${digits.slice(5, 9)}-${digits.slice(9)}`;
  }
  if (digits.length === 13 && digits.startsWith('55')) {
    return `+55 (${digits.slice(2, 4)}) ${digits.slice(4, 9)}-${digits.slice(9)}`;
  }
  if (digits.length >= 8) return `+${digits}`;
  return raw;
}

function Field({ label, value }: { label: string; value: string | null }) {
  return (
    <p className="leading-snug">
      <Text as="span" size="sm" weight="medium" color="secondary">{label} </Text>
      <Text as="span" size="sm" color="muted">{value ?? '—'}</Text>
    </p>
  );
}

export function WorkerContactCard({
  status,
  firstName,
  lastName,
  email,
  phone,
  whatsappPhone,
  profilePhotoUrl,
  documentType,
  documentNumber,
  platform,
  dataSources,
  createdAt,
  updatedAt,
}: WorkerContactCardProps) {
  const { t } = useTranslation();
  const fullName = [firstName, lastName].filter(Boolean).join(' ') || email;
  const statusLabel = STATUS_I18N_KEYS[status] ? t(STATUS_I18N_KEYS[status]) : status;
  const statusColor = STATUS_COLORS[status] ?? 'bg-gray-100 text-gray-600';
  const platformLabel = getPlatformLabel(t, platform);
  const created = new Date(createdAt).toLocaleDateString('pt-BR');
  const updated = new Date(updatedAt).toLocaleDateString('pt-BR');

  return (
    <div data-testid="worker-contact-card" className="bg-white rounded-card border-[1.5px] border-gray-700 p-6 sm:px-8 sm:py-10 flex flex-col gap-4">
      <div className="flex items-center gap-4 mb-2">
        {profilePhotoUrl ? (
          <img
            src={profilePhotoUrl}
            alt={fullName}
            className="w-14 h-14 rounded-full object-cover border border-gray-600"
          />
        ) : (
          <div className="w-14 h-14 rounded-full bg-gray-300 flex items-center justify-center">
            <Text as="span" size="xl" weight="semibold" color="secondary">
              {(firstName?.[0] ?? email[0] ?? '?').toUpperCase()}
            </Text>
          </div>
        )}
        <div className="min-w-0">
          <Heading level={1} as="h3" className="truncate">
            {fullName}
          </Heading>
          <Text size="sm" color="muted" className="truncate">{email}</Text>
        </div>
      </div>

      <Heading level={1} as="h3">
        {t('admin.workerDetail.contactData')}
      </Heading>

      <div className="flex flex-col gap-3">
        <Field label={`${t('admin.workerDetail.statusLabel')}:`} value={null} />
        <div className="-mt-3 ml-0">
          <span className={`inline-flex px-3 py-0.5 rounded-full ${statusColor}`}>
            <Text as="span" size="xs" weight="medium" color="inherit">
              {statusLabel}
            </Text>
          </span>
        </div>
        <Field label={`${t('admin.workerDetail.phone')}:`} value={formatPhoneDisplay(phone)} />
        {whatsappPhone && whatsappPhone !== phone && (
          <Field label={`${t('admin.workerDetail.whatsapp')}:`} value={formatPhoneDisplay(whatsappPhone)} />
        )}
        <Field
          label={`${t('admin.workerDetail.document')}:`}
          value={documentNumber ? `${getDocumentTypeLabel(t, documentType) ?? '—'} — ${documentNumber}` : null}
        />
        <Field label={`${t('admin.workerDetail.platform')}:`} value={platformLabel} />
        {dataSources.length > 0 && (
          <Field
            label={`${t('admin.workerDetail.dataSources')}:`}
            value={dataSources.map((s) => getPlatformLabel(t, s)).join(', ')}
          />
        )}
        <Field label={`${t('admin.workerDetail.createdAt')}:`} value={created} />
        <Field label={`${t('admin.workerDetail.updatedAt')}:`} value={updated} />
      </div>

      <div className="flex items-center gap-4 pt-2">
        <ToggleIndicator label={t('admin.workerDetail.termsOfUse')} enabled />
        <ToggleIndicator label={t('admin.workerDetail.privacyPolicy')} enabled />
      </div>
    </div>
  );
}

function ToggleIndicator({ label, enabled }: { label: string; enabled: boolean }) {
  return (
    <div className="inline-flex items-center gap-3">
      <div className="relative w-[37px] h-5">
        <div className={`w-[37px] h-5 rounded-full ${enabled ? 'bg-primary' : 'bg-gray-600'}`} />
        <div
          className={`absolute top-0.5 w-[17px] h-[17px] bg-white rounded-full transition-all ${
            enabled ? 'right-[2px]' : 'left-[2px]'
          }`}
        />
      </div>
      <Text as="span" size="sm" weight="medium" color="primary">{label}</Text>
    </div>
  );
}
