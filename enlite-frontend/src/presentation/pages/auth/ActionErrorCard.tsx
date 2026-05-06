import { useTranslation } from 'react-i18next';
import { AlertCircle } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';

interface ActionErrorCardProps {
  titleKey: string;
  descriptionKey?: string;
}

export function ActionErrorCard({ titleKey, descriptionKey }: ActionErrorCardProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center gap-5 text-center">
      <div className="flex items-center justify-center w-14 h-14 rounded-full bg-red-50">
        <AlertCircle className="text-red-500" size={28} />
      </div>

      <div className="flex flex-col gap-2">
        <Heading level={2} weight="semibold" color="primary">
          {t(titleKey)}
        </Heading>
        {descriptionKey && (
          <Text size="sm" color="secondary">
            {t(descriptionKey)}
          </Text>
        )}
      </div>

      <Button
        variant="outline"
        size="md"
        borderColor="#180149"
        textColor="#180149"
        onClick={() => {
          window.location.href = '/admin/login';
        }}
      >
        {t('auth.action.backToLogin')}
      </Button>
    </div>
  );
}
