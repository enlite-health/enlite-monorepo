import { Text } from '@presentation/components/atoms';
import { getInitials } from '@presentation/utils/getInitials';

/** O círculo de iniciais (40px, índigo) do painel e do cartão do e-mail exato. */
export function AreaPersonAvatar({ name }: { name: string }): JSX.Element {
  return (
    <span className="w-10 h-10 rounded-full bg-primary flex items-center justify-center shrink-0" aria-hidden="true">
      <Text as="span" size="sm" weight="medium" color="white">{getInitials(name)}</Text>
    </span>
  );
}
