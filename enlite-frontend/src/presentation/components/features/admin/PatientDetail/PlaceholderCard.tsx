import { useTranslation } from 'react-i18next';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';

interface PlaceholderCardProps {
  /** Chave i18n do título do card (mesma chave que o card usava antes de virar placeholder). */
  titleKey: string;
  testId?: string;
}

/**
 * Spec 014 US-D2 (decisão do Gabriel 03/09, item 9): card inteiramente vazio — sem dado, sem
 * endpoint, sem drawer — vira "título + Próximamente REAL". Nada de rótulo `—` fantasma, botão
 * `disabled` sem ação, nem busca decorativa: a promessa falsa de funcionalidade some, o "ainda
 * não existe" fica dito uma vez só.
 */
export function PlaceholderCard({ titleKey, testId }: PlaceholderCardProps) {
  const { t } = useTranslation();
  return (
    <div
      className="bg-white rounded-card border-[1.5px] border-gray-700 p-6 sm:px-8 sm:py-10 flex flex-col items-center justify-center gap-2 min-h-[160px]"
      data-testid={testId}
    >
      <Heading level={1} as="h3" weight="semibold" color="primary">
        {t(titleKey)}
      </Heading>
      <Text size="sm" color="muted">
        {t('admin.patients.detail.comingSoon')}
      </Text>
    </div>
  );
}
