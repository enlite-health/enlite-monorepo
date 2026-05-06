import { Text } from '@presentation/components/atoms';
import { ReactNode } from 'react';
import { Link, useMatch } from 'react-router-dom';

export interface NavItemProps {
  icon: ReactNode;
  label: string;
  href?: string;
  onClick?: () => void;
  isActive?: boolean;
  isSubItem?: boolean;
  isCollapsed?: boolean;
}

export const NavItem = ({
  icon,
  label,
  href,
  onClick,
  isActive = false,
  isSubItem = false,
  isCollapsed = false,
}: NavItemProps): JSX.Element => {
  const routeMatch = useMatch({ path: href || '__no_match__', end: !isSubItem });
  const isRouteActive = isActive || (!!href && !!routeMatch);

  const baseStyles = isCollapsed
    ? 'flex w-full items-center justify-center py-3 transition-colors duration-150'
    : isSubItem
    ? 'flex w-full items-center gap-2.5 pl-10 pr-3 py-2 transition-colors duration-150'
    : 'flex w-full items-center gap-3 px-4 py-2.5 transition-colors duration-150';

  const activeStyles = isRouteActive
    ? 'bg-purple-50 border-r-2 border-[#180149]'
    : 'bg-white hover:bg-gray-50';

  const content = isCollapsed ? (
    <div className="w-6 h-6 flex-shrink-0">{icon}</div>
  ) : (
    <>
      <div className={isSubItem ? 'w-4 h-4 flex-shrink-0' : 'w-5 h-5 flex-shrink-0'}>{icon}</div>
      <Text
        as="span"
        size={isSubItem ? 'xs' : 'sm'}
        weight={isRouteActive ? 'semibold' : 'medium'}
        color="inherit"
        className="flex-1"
      >
        {label}
      </Text>
    </>
  );

  if (href) {
    return (
      <Link to={href} className={`${baseStyles} ${activeStyles}`}>
        {content}
      </Link>
    );
  }

  return (
    <button onClick={onClick} className={`${baseStyles} ${activeStyles}`}>
      {content}
    </button>
  );
};
