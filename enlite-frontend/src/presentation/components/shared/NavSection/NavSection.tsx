import { Text } from '@presentation/components/atoms';
import { ReactNode, useState } from 'react';
import { NavItem } from '@presentation/components/shared/NavItem';

export interface NavSectionItem {
  icon: ReactNode;
  label: string;
  href?: string;
  enabled?: boolean;
}

export interface NavSectionProps {
  icon: ReactNode;
  label: string;
  items: NavSectionItem[];
  defaultExpanded?: boolean;
}

export const NavSection = ({
  icon,
  label,
  items,
  defaultExpanded = false,
}: NavSectionProps): JSX.Element => {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  const toggleExpanded = (): void => {
    setIsExpanded(!isExpanded);
  };

  return (
    <div className="w-full">
      <button
        onClick={toggleExpanded}
        className="flex w-full items-center gap-3 px-4 py-2.5 bg-white hover:bg-gray-50 transition-colors"
      >
        <div className="w-5 h-5 flex-shrink-0">{icon}</div>
        <Text as="span" size="sm" weight="medium" color="inherit" className="flex-1 text-left">
          {label}
        </Text>
        <svg
          className={`w-3 h-3 text-[#180149] transition-transform flex-shrink-0 ${
            isExpanded ? 'rotate-90' : ''
          }`}
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </button>

      {isExpanded &&
        items
          .filter((item) => item.enabled !== false)
          .map((item, index) => (
            <NavItem
              key={index}
              icon={item.icon}
              label={item.label}
              href={item.href}
              isSubItem={true}
            />
          ))}
    </div>
  );
};
