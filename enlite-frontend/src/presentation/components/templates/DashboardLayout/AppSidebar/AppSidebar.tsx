import { ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavItem } from '@presentation/components/shared/NavItem';
import { NavSection, type NavSectionItem } from '@presentation/components/shared/NavSection';
import { SidebarFooter } from '@presentation/components/shared/SidebarFooter';
import { Text } from '@presentation/components/atoms/Text';
import { NotificationBell } from '@presentation/components/features/notifications/NotificationBell';

export interface AppSidebarNavItem {
  icon: ReactNode;
  label: string;
  href?: string;
  subItems?: NavSectionItem[];
  enabled?: boolean;
  /** Quando presente, renderiza um separador visual + rótulo de seção ANTES deste item. */
  sectionStart?: string;
}

export interface AppSidebarProps {
  navItems: AppSidebarNavItem[];
  userName: string;
  userAvatar?: string;
  onMenuClick?: () => void;
  className?: string;
  defaultCollapsed?: boolean;
}

export const AppSidebar = ({
  navItems,
  userName,
  userAvatar,
  onMenuClick,
  className = '',
  defaultCollapsed = false,
}: AppSidebarProps): JSX.Element => {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);
  const { t } = useTranslation();

  const toggleSidebar = (): void => {
    setIsCollapsed(!isCollapsed);
  };

  return (
    <aside
      className={`fixed top-0 left-0 h-full hidden md:flex flex-col bg-white border-r border-gray-200 z-40 transition-all duration-300 ${
        isCollapsed ? 'w-16' : 'w-[200px]'
      } ${className}`}
    >
      {/* Header com Logo e Toggle */}
      <div className={`flex items-center border-b border-gray-100 ${isCollapsed ? 'flex-col py-3 px-2' : 'px-4 py-4 justify-between'}`}>
        {!isCollapsed && (
          <div className="flex items-center gap-2">
            <img className="h-8 w-8 object-contain" alt={t('sidebar.logoAlt', 'Enlite')} src="/EnliteMiniLogo.png" />
            <img className="h-7 w-auto object-contain" alt={t('sidebar.logoAlt', 'Enlite')} src="/EnliteNameLogo.png" />
          </div>
        )}
        {isCollapsed && (
          <img className="h-8 w-8 object-contain mb-2" alt={t('sidebar.logoAlt', 'Enlite')} src="/EnliteMiniLogo.png" />
        )}
        <button
          onClick={toggleSidebar}
          className="p-1 hover:bg-gray-100 rounded transition-colors bg-transparent"
          aria-label={isCollapsed ? t('sidebar.expandMenu', 'Expandir menu') : t('sidebar.collapseMenu', 'Recolher menu')}
        >
          <svg 
            className="w-5 h-5 text-gray-700"
            fill="none" 
            stroke="currentColor" 
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
      </div>

      {/* Sino de notificações (item 4, change 022-ux-mencao-e-notificacao, F17/F18) — 1º item da
          sidebar, ACIMA de `navItems`, SEMPRE montado (expandido ou recolhido — antes desmontava
          e o poll parava junto ao recolher). Global de staff (`own_notifications:*` nasce
          concedida a TODO staff, D-07), não uma rota de navegação — por isso nunca entra na lista
          `navItems`, igual antes. */}
      <NotificationBell isCollapsed={isCollapsed} />

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-2">
        {navItems
          .filter((item) => item.enabled !== false)
          .map((item, index) => (
            <div key={index}>
              {item.sectionStart && (
                <div
                  role="separator"
                  aria-label={item.sectionStart}
                  className={`mt-3 mb-1 mx-2 border-t border-gray-100 ${isCollapsed ? '' : 'pt-3 px-2'}`}
                >
                  {!isCollapsed && (
                    <span aria-hidden="true">
                      <Text
                        as="span"
                        size="xs"
                        weight="medium"
                        color="muted"
                        className="uppercase tracking-widest select-none"
                      >
                        {item.sectionStart}
                      </Text>
                    </span>
                  )}
                </div>
              )}
              {!isCollapsed && item.subItems && item.subItems.length > 0 ? (
                <NavSection
                  icon={item.icon}
                  label={item.label}
                  items={item.subItems}
                  defaultExpanded={false}
                />
              ) : (
                <NavItem
                  icon={item.icon}
                  label={item.label}
                  href={item.href}
                  isCollapsed={isCollapsed}
                />
              )}
            </div>
          ))}
      </nav>

      {/* Footer */}
      {!isCollapsed && (
        <SidebarFooter
          userName={userName}
          userAvatar={userAvatar}
          onMenuClick={onMenuClick}
        />
      )}
      
      {isCollapsed && userAvatar && (
        <div className="p-2 border-t border-gray-200">
          <img src={userAvatar} alt={t('sidebar.userAvatarAlt', userName)} className="w-10 h-10 rounded-full object-cover mx-auto" />
        </div>
      )}
    </aside>
  );
};
