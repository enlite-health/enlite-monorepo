import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  signOut,
  onAuthStateChanged,
  User as FirebaseUser,
  getIdToken,
  sendEmailVerification,
} from 'firebase/auth';
import { getFirebaseAuth } from '../config/firebase';
import { User } from '@domain/entities/User';

// Interface para mock auth state (usado em testes E2E)
interface MockAuthState {
  uid: string;
  email: string;
  displayName?: string;
  roles?: string[];
  emailVerified?: boolean;
  stsTokenManager?: {
    accessToken: string;
    expirationTime: number;
  };
}

export class FirebaseAuthService {
  private readonly googleProvider: GoogleAuthProvider;

  constructor() {
    this.googleProvider = new GoogleAuthProvider();
    this.googleProvider.addScope('email');
    this.googleProvider.addScope('profile');
    
    // Check for mock auth state in localStorage (for E2E tests)
    this.checkForMockAuth();
  }

  /**
   * Check for mock auth in localStorage (E2E test mode)
   */
  private checkForMockAuth(): void {
    if (typeof window === 'undefined') return;
    
    // Search for mock auth state in any localStorage key
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.includes('firebase:authUser') || key?.includes('mock_auth')) {
        try {
          const value = localStorage.getItem(key);
          if (value) {
            const parsed = JSON.parse(value);
            // Check if it's a valid auth state
            if (parsed.uid && parsed.email) {
              // Check if it hasn't expired
              const expTime = parsed.stsTokenManager?.expirationTime;
              if (!expTime || expTime > Date.now()) {
                console.log('[FirebaseAuthService] Mock auth detected');
                break;
              }
            }
          }
        } catch {
          // Ignore parse errors
        }
      }
    }
  }

  /**
   * Converts mock auth state to User
   */
  private mapMockAuthToUser(mockState: MockAuthState): User {
    return {
      id: mockState.uid,
      email: mockState.email,
      name: mockState.displayName || mockState.email.split('@')[0],
      roles: mockState.roles || [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  async signInWithEmail(email: string, password: string): Promise<{ user: User; idToken: string }> {
    const auth = getFirebaseAuth();
    const credential = await signInWithEmailAndPassword(auth, email, password);
    const idToken = await getIdToken(credential.user);
    return {
      user: this.mapFirebaseUser(credential.user),
      idToken,
    };
  }

  async signUpWithEmail(email: string, password: string): Promise<{ user: User; idToken: string }> {
    const auth = getFirebaseAuth();
    const credential = await createUserWithEmailAndPassword(auth, email, password);
    
    // Send verification email with actionCodeSettings for Identity Platform
    const actionCodeSettings = {
      url: `${window.location.origin}/login?verified=true`,
      handleCodeInApp: true,
      // iOS and Android settings (optional, but helps with delivery)
      iOS: {
        bundleId: 'com.enlite.app'
      },
      android: {
        packageName: 'com.enlite.app',
        installApp: false,
        minimumVersion: '1'
      },
      // Dynamic link domain (if you have one configured)
      // dynamicLinkDomain: 'enlite.page.link'
    };
    
    try {
      await sendEmailVerification(credential.user, actionCodeSettings);
      console.log('[FirebaseAuthService] ✅ Verification email sent');
      console.log('[FirebaseAuthService] Please check your inbox and spam folder');
    } catch (emailError) {
      console.error('[FirebaseAuthService] ❌ Error sending verification email:', emailError);
      console.error('[FirebaseAuthService] Error details:', JSON.stringify(emailError, null, 2));
      // Don't block registration if email fails
    }
    
    const idToken = await getIdToken(credential.user);
    return {
      user: this.mapFirebaseUser(credential.user),
      idToken,
    };
  }

  async signInWithGoogle(): Promise<{ user: User; idToken: string }> {
    const auth = getFirebaseAuth();
    const credential = await signInWithPopup(auth, this.googleProvider);
    const idToken = await getIdToken(credential.user);
    return {
      user: this.mapFirebaseUser(credential.user),
      idToken,
    };
  }

  async logout(): Promise<void> {
    const auth = getFirebaseAuth();
    await signOut(auth);
    
    // Clear mock auth from localStorage
    if (typeof window !== 'undefined') {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const key = localStorage.key(i);
        if (key?.includes('firebase:authUser') || key?.includes('mock_auth')) {
          localStorage.removeItem(key);
        }
      }
    }
  }

  onAuthStateChanged(callback: (user: User | null) => void): () => void {
    const auth = getFirebaseAuth();

    /**
     * Reads mock auth state from localStorage.
     * Checks two sources:
     * 1. `enlite_e2e_mock_auth` — stable E2E key that the Firebase SDK never removes.
     * 2. `firebase:authUser:*` — standard Firebase persistence key (may be cleared by SDK).
     * Returns null when absent or expired.
     */
    const readMockAuth = (): User | null => {
      if (typeof window === 'undefined') return null;

      // Priority 1: stable E2E key (Firebase SDK cannot clear this)
      try {
        const e2eRaw = localStorage.getItem('enlite_e2e_mock_auth');
        if (e2eRaw) {
          const parsed: MockAuthState = JSON.parse(e2eRaw);
          if (parsed.uid && parsed.email) {
            const expTime = parsed.stsTokenManager?.expirationTime;
            if (!expTime || expTime > Date.now()) {
              return this.mapMockAuthToUser(parsed);
            }
          }
        }
      } catch {
        // Ignore parse errors
      }

      // Priority 2: standard Firebase persistence key
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.includes('firebase:authUser')) {
          try {
            const value = localStorage.getItem(key);
            if (value) {
              const parsed: MockAuthState = JSON.parse(value);
              if (parsed.uid && parsed.email) {
                const expTime = parsed.stsTokenManager?.expirationTime;
                if (!expTime || expTime > Date.now()) {
                  return this.mapMockAuthToUser(parsed);
                }
              }
            }
          } catch {
            // Ignore parse errors
          }
        }
      }
      return null;
    };

    /**
     * True ONLY for genuine E2E sessions, identified by the E2E-exclusive
     * `enlite_e2e_mock_auth` key. This key is never present in production, so
     * real users are never treated as mock sessions for null-suppression.
     */
    const isE2eMockSession = (): boolean => {
      if (typeof window === 'undefined') return false;
      try {
        return localStorage.getItem('enlite_e2e_mock_auth') != null;
      } catch {
        return false;
      }
    };

    // If a persisted/mock session is present in localStorage, dispatch it
    // synchronously so ProtectedRoute sees the user immediately on reload.
    const mockUser = readMockAuth();
    if (mockUser) {
      console.log('[FirebaseAuthService] Mock auth detected');
      // Dispatch synchronously so ProtectedRoute sees the user immediately.
      callback(mockUser);
      // Register the real listener but ignore null callbacks while mock auth is active.
      const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
        if (firebaseUser) {
          callback(this.mapFirebaseUser(firebaseUser));
        } else {
          // Suppress the null ONLY for genuine E2E sessions (E2E-exclusive key).
          // Real users MUST always receive null on sign-out / token revocation —
          // otherwise the UI would keep showing a logged-out user as authenticated.
          if (isE2eMockSession()) {
            // Keep the E2E session alive — do not propagate the fake-token null.
            return;
          }
          callback(null);
        }
      });
      return unsubscribe;
    }

    // Normal (non-mock) path — pass through all Firebase auth state changes.
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      callback(firebaseUser ? this.mapFirebaseUser(firebaseUser) : null);
    });

    return unsubscribe;
  }

  async getCurrentUser(): Promise<User | null> {
    const auth = getFirebaseAuth();
    const currentUser = auth.currentUser;
    if (!currentUser) {
      return null;
    }
    return this.mapFirebaseUser(currentUser);
  }

  async getIdToken(): Promise<string | null> {
    const auth = getFirebaseAuth();
    let currentUser = auth.currentUser;
    if (!currentUser) {
      currentUser = await this.waitForAuthReady(2000);
    }
    if (!currentUser) {
      return null;
    }
    return getIdToken(currentUser);
  }

  /**
   * Resolves when Firebase has hydrated its auth state from persistence,
   * with a short timeout. Avoids the race where a page mounts and fetches
   * before localStorage-backed credentials are restored on a fresh load.
   */
  private waitForAuthReady(timeoutMs: number): Promise<FirebaseUser | null> {
    const auth = getFirebaseAuth();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        unsubscribe();
        resolve(auth.currentUser);
      }, timeoutMs);
      const unsubscribe = onAuthStateChanged(auth, (user) => {
        if (user) {
          clearTimeout(timer);
          unsubscribe();
          resolve(user);
        }
      });
    });
  }

  async forceRefreshToken(): Promise<string | null> {
    const auth = getFirebaseAuth();
    const currentUser = auth.currentUser;
    if (!currentUser) {
      return null;
    }
    return getIdToken(currentUser, true);
  }

  private mapFirebaseUser(firebaseUser: FirebaseUser, _roles: string[] = []): User {
    return {
      id: firebaseUser.uid,
      email: firebaseUser.email || '',
      name: firebaseUser.displayName || '',
      roles: _roles,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }
}
