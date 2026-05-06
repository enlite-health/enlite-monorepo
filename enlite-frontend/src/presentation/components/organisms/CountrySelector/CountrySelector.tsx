import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms';

interface CountrySelectorProps {
  className?: string;
  showLabel?: boolean;
}

export function CountrySelector({ className = '', showLabel = true }: CountrySelectorProps): JSX.Element {
  const { t } = useTranslation();

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <svg width="28" height="20" viewBox="0 0 28 20" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M28 16.9231C28 17.7391 27.6722 18.5218 27.0888 19.0988C26.5053 19.6758 25.714 20 24.8889 20H3.11111C2.28599 20 1.49467 19.6758 0.911223 19.0988C0.327777 18.5218 0 17.7391 0 16.9231V3.07692C0 2.26087 0.327777 1.47824 0.911223 0.90121C1.49467 0.324175 2.28599 0 3.11111 0H24.8889C25.714 0 26.5053 0.324175 27.0888 0.90121C27.6722 1.47824 28 2.26087 28 3.07692V16.9231Z" fill="#75AADB"/>
        <path d="M0 6.15625H28V13.8486H0V6.15625Z" fill="#EEEEEE"/>
        <path d="M14 6.15625L14.3795 8.11625L15.4886 6.44933L15.0803 8.40317L16.7494 7.2824L15.6162 8.93394L17.5925 8.53087L15.9071 9.62702L17.8889 10.0024L15.9071 10.3778L17.5925 11.4747L15.6162 11.0709L16.7494 12.7216L15.0803 11.6009L15.4886 13.5555L14.3795 11.8886L14 13.8486L13.6205 11.8886L12.5122 13.5555L12.9197 11.6009L11.2498 12.7216L12.3831 11.0709L10.4075 11.4747L12.093 10.3778L10.1112 10.0024L12.093 9.62702L10.4075 8.53087L12.3831 8.93394L11.2498 7.2824L12.9197 8.40317L12.5122 6.44933L13.6205 8.11625L14 6.15625Z" fill="#FCBF49"/>
      </svg>
      {showLabel && (
        <Text as="span" size="sm" weight="medium" color="secondary">
          {t('common.country')}
        </Text>
      )}
    </div>
  );
}
