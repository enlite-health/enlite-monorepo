import { Text } from '@presentation/components/atoms';
import { GroupSimulationSelect } from '@presentation/components/features/access/GroupSimulationSelect';

export interface SidebarFooterProps {
  userName: string;
  userAvatar?: string;
  onMenuClick?: () => void;
}

/**
 * Correção de terreno (T3.3→ajuste A, spec 026, 23/09): este é o rodapé
 * REALMENTE montado (`AppSidebar` → `AdminLayout`) — `GroupSimulationSelect`
 * tinha sido montado antes em `templates/DashboardLayout/Sidebar/SidebarUserFooter.tsx`,
 * que não tem nenhum importador em `src/` (achado confirmado por `git log`
 * de um commit só, a importação inicial do subtree). Revertido de lá, montado
 * aqui.
 */
export const SidebarFooter = ({
  userName,
  userAvatar,
  onMenuClick,
}: SidebarFooterProps): JSX.Element => {
  return (
    <div className="flex flex-col border-t border-gray-200 bg-white">
      <div className="flex items-center justify-between px-3 py-3">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div className="relative w-8 h-8 flex-shrink-0">
            {userAvatar ? (
              <img src={userAvatar} alt={userName} className="w-full h-full rounded-full object-cover" />
            ) : (
              <div className="w-full h-full rounded-full bg-gray-300 flex items-center justify-center">
                <Text as="span" size="xs" weight="semibold" color="secondary">
                  {userName.charAt(0).toUpperCase()}
                </Text>
              </div>
            )}
            <div className="absolute bottom-0 right-0 w-2.5 h-2.5 bg-green-500 border-2 border-white rounded-full" />
          </div>
          <Text as="span" size="xs" weight="medium" color="primary" className="truncate">
            {userName}
          </Text>
        </div>

        <button
          onClick={onMenuClick}
          className="p-1.5 hover:bg-gray-100 rounded transition-colors flex-shrink-0"
          aria-label="Logout"
        >
          <svg className="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
          </svg>
        </button>
      </div>

      {/* F3 (spec 026), decisão #2: some sozinho pra quem não tem `canSimulate`
          (quase todo mundo) — pixel-igual ao rodapé de hoje nesse caso. */}
      <div className="px-3 pb-2 empty:hidden">
        <GroupSimulationSelect />
      </div>
    </div>
  );
};
