import { useAuth } from '@presentation/hooks/useAuth';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

export function Header() {
  const { t } = useTranslation();
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate('/');
  };

  return (
    <header className="header">
      <div className="header-content">
        <h1>Enlite</h1>
        {user && (
          <div className="user-menu">
            <span>{user.name}</span>
            <button onClick={handleLogout}>{t('common.logout')}</button>
          </div>
        )}
      </div>
    </header>
  );
}
