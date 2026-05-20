import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';

interface MatchMissingMeetLinksAlertProps {
  vacancyId: string;
  onClose: () => void;
}

export function MatchMissingMeetLinksAlert({
  vacancyId,
  onClose,
}: MatchMissingMeetLinksAlertProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <div className="bg-amber-50 border border-amber-300 rounded-card p-4 flex items-start gap-3">
      <AlertTriangle className="text-amber-600 shrink-0 mt-0.5" size={20} />
      <div className="flex-1">
        <Text size="sm" weight="semibold" color="inherit" className="text-amber-800">
          {t('admin.match.missingMeetLinks.title')}
        </Text>
        <Text size="sm" color="inherit" className="text-amber-700 mt-1">
          {t('admin.match.missingMeetLinks.instructionsBefore')}
          <strong>{t('admin.match.missingMeetLinks.instructionsTab')}</strong>
          {t('admin.match.missingMeetLinks.instructionsAfter')}
        </Text>
        <div className="mt-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              onClose();
              navigate(`/admin/vacancies/${vacancyId}#links`);
            }}
          >
            {t('admin.match.missingMeetLinks.goToLinks')}
          </Button>
        </div>
      </div>
    </div>
  );
}
