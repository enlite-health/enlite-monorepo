import { Link } from 'react-router-dom';
import { Text } from '@presentation/components/atoms';
import { GroupSimulationSelect } from '@presentation/components/features/access/GroupSimulationSelect';
import { getInitials } from '@presentation/utils/getInitials';
import { SidebarAvatar } from './SidebarAvatar';

export interface SidebarFooterProps {
  userName: string;
  userAvatar?: string;
  onMenuClick?: () => void;
  /**
   * Quando presente (só o painel admin passa), avatar + nome viram um link para o perfil, com o rótulo "Mi perfil"
   * numa segunda linha, e as iniciais seguem a regra do `PersonAvatar` (`getInitials`, até 2 letras). Ausente = o
   * rodapé de sempre (app do prestador: sem perfil admin, 1 letra).
   */
  profileHref?: string;
  /** Texto da segunda linha ("Mi perfil" / "Meu perfil"). */
  profileLabel?: string;
  /** `aria-label` do link ("Mi perfil — <nome>"). */
  profileAriaLabel?: string;
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
  profileHref,
  profileLabel,
  profileAriaLabel,
}: SidebarFooterProps): JSX.Element => {
  const initials = profileHref ? getInitials(userName) : userName.charAt(0).toUpperCase();
  const identity = (
    <>
      <SidebarAvatar initials={initials} photoUrl={userAvatar} sizeClass="w-8 h-8" showStatus />
      <span className="flex flex-col min-w-0">
        <Text as="span" size="xs" weight="medium" color="primary" className="truncate">
          {userName}
        </Text>
        {profileHref && profileLabel && (
          <Text as="span" size="2xs" color="inherit" className="truncate text-slate-700" data-testid="sidebar-profile-label">
            {profileLabel}
          </Text>
        )}
      </span>
    </>
  );

  return (
    <div className="flex flex-col border-t border-gray-200 bg-white">
      <div className="flex items-center justify-between px-3 py-3">
        {/* Só avatar + nome são o link; o ícone de sair fica FORA (outro alvo de clique). Hover em `primary/5` (o `gray-100`
            do tema é quase branco e não se vê); foco de teclado com anel `primary`. */}
        {profileHref ? (
          <Link
            to={profileHref}
            aria-label={profileAriaLabel}
            data-testid="sidebar-profile-link"
            className="flex items-center gap-2 flex-1 min-w-0 -ml-1.5 pl-1.5 pr-1 py-1 rounded-lg hover:bg-primary/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary transition-colors"
          >
            {identity}
          </Link>
        ) : (
          <div className="flex items-center gap-2 flex-1 min-w-0">{identity}</div>
        )}

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
