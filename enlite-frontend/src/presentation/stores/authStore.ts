import { create } from 'zustand';
import { User } from '@domain/entities/User';
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import { WorkerApiService } from '@infrastructure/http/WorkerApiService';
import { identifyClarity } from '@infrastructure/analytics/clarity';

interface AuthState {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  authService: FirebaseAuthService;
  
  // Actions
  setUser: (user: User | null) => void;
  setLoading: (isLoading: boolean) => void;
  login: (email: string, password: string) => Promise<void>;
  loginWithGoogle: () => Promise<User>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  initialize: () => () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  isLoading: true,
  isAuthenticated: false,
  authService: new FirebaseAuthService(),
  
  // Actions
  setUser: (user: User | null): void => set({ user, isAuthenticated: user !== null }),
  
  setLoading: (isLoading: boolean): void => set({ isLoading }),
  
  login: async (email: string, password: string): Promise<void> => {
    const { authService } = get();
    const { user } = await authService.signInWithEmail(email, password);
    set({ user, isAuthenticated: true });
    // Vincula o worker existente ao auth_uid do Firebase — não bloqueia navegação se falhar.
    WorkerApiService.initWorker({ authUid: user.id, email: user.email }).catch(() => undefined);
  },
  
  loginWithGoogle: async (): Promise<User> => {
    const { authService } = get();
    const { user } = await authService.signInWithGoogle();
    set({ user, isAuthenticated: true });
    // Vincula o worker existente ao Google Identity — não bloqueia navegação se falhar.
    try {
      await WorkerApiService.initWorker({ authUid: user.id, email: user.email });
    } catch {
      // Falha silenciosa — não bloqueia a navegação após login com Google.
    }
    return user;
  },

  register: async (email: string, password: string): Promise<void> => {
    const { authService } = get();
    const { user } = await authService.signUpWithEmail(email, password);
    set({ user, isAuthenticated: true });
    // Ensure worker record exists on fresh registration.
    WorkerApiService.initWorker({ authUid: user.id, email: user.email }).catch(() => undefined);
  },
  
  logout: async (): Promise<void> => {
    const { authService } = get();
    await authService.logout();
    set({ user: null, isAuthenticated: false });
  },
  
  initialize: (): (() => void) => {
    const { authService, setUser, setLoading } = get();
    
    const unsubscribe = authService.onAuthStateChanged((firebaseUser) => {
      setUser(firebaseUser);
      setLoading(false);
      if (firebaseUser) {
        // Amarra a sessão do Clarity ao uid opaco do Firebase (sem PII), para
        // que uma sessão anônima vire buscável no suporte. O workerId é somado
        // como tag depois, quando o perfil carrega (WorkerHome).
        identifyClarity(firebaseUser.id);
      }
    });
    
    return unsubscribe;
  },
}));
