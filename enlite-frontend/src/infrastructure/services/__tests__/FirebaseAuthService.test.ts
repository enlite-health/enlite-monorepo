import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FirebaseAuthService } from '../FirebaseAuthService';
import * as firebase from 'firebase/auth';

// Mock Firebase Auth
vi.mock('firebase/auth', () => ({
  signInWithEmailAndPassword: vi.fn(),
  createUserWithEmailAndPassword: vi.fn(),
  signInWithPopup: vi.fn(),
  GoogleAuthProvider: vi.fn(() => ({
    addScope: vi.fn(),
  })),
  signOut: vi.fn(),
  onAuthStateChanged: vi.fn(),
  getIdToken: vi.fn(),
  sendEmailVerification: vi.fn(),
}));

vi.mock('../../config/firebase', () => ({
  getFirebaseAuth: vi.fn(() => ({
    currentUser: null,
  })),
}));

describe('FirebaseAuthService', () => {
  let service: FirebaseAuthService;

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    service = new FirebaseAuthService();
  });

  describe('Constructor', () => {
    it('should initialize GoogleAuthProvider with correct scopes', () => {
      expect(firebase.GoogleAuthProvider).toHaveBeenCalled();
    });

    it('should check for mock auth in localStorage', () => {
      const mockAuth = {
        uid: 'test-uid',
        email: 'test@example.com',
        stsTokenManager: {
          accessToken: 'test-token',
          expirationTime: Date.now() + 3600000,
        },
      };
      
      localStorage.setItem('firebase:authUser:test', JSON.stringify(mockAuth));
      
      const newService = new FirebaseAuthService();
      expect(newService).toBeDefined();
    });
  });

  describe('signInWithEmail', () => {
    it('should sign in user with email and password', async () => {
      const mockUser = {
        uid: 'test-uid',
        email: 'test@example.com',
        displayName: 'Test User',
      };
      
      const mockCredential = { user: mockUser };
      
      vi.mocked(firebase.signInWithEmailAndPassword).mockResolvedValue(mockCredential as any);
      vi.mocked(firebase.getIdToken).mockResolvedValue('test-id-token');

      const result = await service.signInWithEmail('test@example.com', 'password123');

      expect(result.user.id).toBe('test-uid');
      expect(result.user.email).toBe('test@example.com');
      expect(result.idToken).toBe('test-id-token');
    });

    it('should handle sign in errors', async () => {
      vi.mocked(firebase.signInWithEmailAndPassword).mockRejectedValue(
        new Error('Invalid credentials')
      );

      await expect(
        service.signInWithEmail('test@example.com', 'wrong-password')
      ).rejects.toThrow('Invalid credentials');
    });
  });

  describe('signUpWithEmail', () => {
    it('should create user with email and password', async () => {
      const mockUser = {
        uid: 'new-uid',
        email: 'new@example.com',
        displayName: null,
      };
      
      const mockCredential = { user: mockUser };
      
      vi.mocked(firebase.createUserWithEmailAndPassword).mockResolvedValue(mockCredential as any);
      vi.mocked(firebase.sendEmailVerification).mockResolvedValue(undefined as any);
      vi.mocked(firebase.getIdToken).mockResolvedValue('new-id-token');

      const result = await service.signUpWithEmail('new@example.com', 'password123');

      expect(result.user.id).toBe('new-uid');
      expect(result.user.email).toBe('new@example.com');
      expect(result.idToken).toBe('new-id-token');
      expect(firebase.sendEmailVerification).toHaveBeenCalledWith(
        mockUser,
        expect.objectContaining({
          url: expect.stringContaining('/login?verified=true'),
          handleCodeInApp: true,
        })
      );
    });

    it('should handle sign up errors', async () => {
      vi.mocked(firebase.createUserWithEmailAndPassword).mockRejectedValue(
        new Error('Email already in use')
      );

      await expect(
        service.signUpWithEmail('existing@example.com', 'password123')
      ).rejects.toThrow('Email already in use');
    });
  });

  describe('signInWithGoogle', () => {
    it('should sign in user with Google popup', async () => {
      const mockUser = {
        uid: 'google-uid',
        email: 'google@example.com',
        displayName: 'Google User',
      };
      
      const mockCredential = { user: mockUser };
      
      vi.mocked(firebase.signInWithPopup).mockResolvedValue(mockCredential as any);
      vi.mocked(firebase.getIdToken).mockResolvedValue('google-id-token');

      const result = await service.signInWithGoogle();

      expect(result.user.id).toBe('google-uid');
      expect(result.user.email).toBe('google@example.com');
      expect(result.idToken).toBe('google-id-token');
    });

    it('should handle Google sign in cancellation', async () => {
      vi.mocked(firebase.signInWithPopup).mockRejectedValue(
        new Error('Popup closed by user')
      );

      await expect(service.signInWithGoogle()).rejects.toThrow('Popup closed by user');
    });
  });

  describe('logout', () => {
    it('should sign out user', async () => {
      vi.mocked(firebase.signOut).mockResolvedValue(undefined as any);

      await service.logout();

      expect(firebase.signOut).toHaveBeenCalled();
    });

    it('should handle logout errors', async () => {
      vi.mocked(firebase.signOut).mockRejectedValue(new Error('Logout failed'));

      await expect(service.logout()).rejects.toThrow('Logout failed');
    });
  });

  describe('onAuthStateChanged', () => {
    it('should call callback with user when authenticated', () => {
      const mockUser = {
        uid: 'test-uid',
        email: 'test@example.com',
        displayName: 'Test User',
      };

      const callback = vi.fn();
      
      vi.mocked(firebase.onAuthStateChanged).mockImplementation((_auth: any, cb: any) => {
        cb(mockUser as any);
        return () => {};
      });

      service.onAuthStateChanged(callback);

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'test-uid',
          email: 'test@example.com',
        })
      );
    });

    it('should call callback with null when not authenticated', () => {
      const callback = vi.fn();
      
      vi.mocked(firebase.onAuthStateChanged).mockImplementation((_auth: any, cb: any) => {
        cb(null);
        return () => {};
      });

      service.onAuthStateChanged(callback);

      expect(callback).toHaveBeenCalledWith(null);
    });

    it('should detect mock auth from localStorage', () => {
      const mockAuth = {
        uid: 'mock-uid',
        email: 'mock@example.com',
        displayName: 'Mock User',
        stsTokenManager: {
          accessToken: 'mock-token',
          expirationTime: Date.now() + 3600000,
        },
      };
      
      localStorage.setItem('firebase:authUser:test', JSON.stringify(mockAuth));
      
      const callback = vi.fn();
      service.onAuthStateChanged(callback);

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'mock-uid',
          email: 'mock@example.com',
        })
      );
    });

    it('should ignore expired mock auth', () => {
      const expiredMockAuth = {
        uid: 'expired-uid',
        email: 'expired@example.com',
        stsTokenManager: {
          accessToken: 'expired-token',
          expirationTime: Date.now() - 3600000, // Expired 1 hour ago
        },
      };
      
      localStorage.setItem('firebase:authUser:test', JSON.stringify(expiredMockAuth));
      
      const callback = vi.fn();
      
      vi.mocked(firebase.onAuthStateChanged).mockImplementation((_auth: any, cb: any) => {
        cb(null);
        return () => {};
      });
      
      service.onAuthStateChanged(callback);

      // Should fall back to Firebase auth, not use expired mock
      expect(firebase.onAuthStateChanged).toHaveBeenCalled();
    });

    it('should return unsubscribe function', () => {
      const unsubscribe = vi.fn();
      
      vi.mocked(firebase.onAuthStateChanged).mockReturnValue(unsubscribe);

      const result = service.onAuthStateChanged(() => {});

      expect(typeof result).toBe('function');
    });
  });

  describe('getCurrentUser', () => {
    it('should return current user when authenticated', async () => {
      const mockAuth = {
        currentUser: {
          uid: 'current-uid',
          email: 'current@example.com',
          displayName: 'Current User',
        },
      };
      
      const { getFirebaseAuth } = await import('../../config/firebase');
      vi.mocked(getFirebaseAuth).mockReturnValue(mockAuth as any);

      const result = await service.getCurrentUser();

      expect(result).toEqual(
        expect.objectContaining({
          id: 'current-uid',
          email: 'current@example.com',
        })
      );
    });

    it('should return null when not authenticated', async () => {
      const mockAuth = {
        currentUser: null,
      };
      
      const { getFirebaseAuth } = await import('../../config/firebase');
      vi.mocked(getFirebaseAuth).mockReturnValue(mockAuth as any);

      const result = await service.getCurrentUser();

      expect(result).toBeNull();
    });
  });

  describe('foto e provider da sessão', () => {
    const map = (u: object) => (service as unknown as { mapFirebaseUser: (x: object) => { photoUrl?: string | null; authProviders?: string[] } }).mapFirebaseUser(u);

    it('prefere o photoURL do provider google.com e expõe os providers', () => {
      const r = map({ uid: 'u', email: 'a@b.test', displayName: 'A', photoURL: 'https://fallback.test/p.png', providerData: [{ providerId: 'google.com', photoURL: 'https://google.test/p.png' }] });
      expect(r.photoUrl).toBe('https://google.test/p.png');
      expect(r.authProviders).toEqual(['google.com']);
    });

    it('sem provider google.com cai no user.photoURL; sem nenhum, null', () => {
      expect(map({ uid: 'u', email: 'a@b.test', photoURL: 'https://fallback.test/p.png', providerData: [{ providerId: 'password', photoURL: null }] }).photoUrl).toBe('https://fallback.test/p.png');
      expect(map({ uid: 'u', email: 'a@b.test', photoURL: null, providerData: [] }).photoUrl).toBeNull();
    });
  });

  describe('getIdToken', () => {
    it('should return id token when authenticated', async () => {
      const mockUser = {
        uid: 'test-uid',
        email: 'test@example.com',
      };
      
      const mockAuth = {
        currentUser: mockUser,
      };
      
      const { getFirebaseAuth } = await import('../../config/firebase');
      vi.mocked(getFirebaseAuth).mockReturnValue(mockAuth as any);
      vi.mocked(firebase.getIdToken).mockResolvedValue('test-token');

      const result = await service.getIdToken();

      expect(result).toBe('test-token');
    });

    it('should return null when not authenticated', async () => {
      const mockAuth = {
        currentUser: null,
      };
      
      const { getFirebaseAuth } = await import('../../config/firebase');
      vi.mocked(getFirebaseAuth).mockReturnValue(mockAuth as any);

      const result = await service.getIdToken();

      expect(result).toBeNull();
    });
  });

  describe('Mock Auth Detection', () => {
    it('should detect mock auth with mock_auth key', () => {
      const mockAuth = {
        uid: 'mock-uid',
        email: 'mock@example.com',
        stsTokenManager: {
          accessToken: 'mock-token',
          expirationTime: Date.now() + 3600000,
        },
      };
      
      localStorage.setItem('mock_auth_test', JSON.stringify(mockAuth));
      
      const newService = new FirebaseAuthService();
      expect(newService).toBeDefined();
    });

    it('should ignore invalid JSON in localStorage', () => {
      localStorage.setItem('firebase:authUser:test', 'invalid-json{');
      
      const newService = new FirebaseAuthService();
      expect(newService).toBeDefined();
    });

    it('should ignore auth state without uid', () => {
      const invalidAuth = {
        email: 'test@example.com',
      };
      
      localStorage.setItem('firebase:authUser:test', JSON.stringify(invalidAuth));
      
      const newService = new FirebaseAuthService();
      expect(newService).toBeDefined();
    });

    it('should ignore auth state without email', () => {
      const invalidAuth = {
        uid: 'test-uid',
      };
      
      localStorage.setItem('firebase:authUser:test', JSON.stringify(invalidAuth));
      
      const newService = new FirebaseAuthService();
      expect(newService).toBeDefined();
    });
  });

  describe('User Mapping', () => {
    it('should map Firebase user with display name', async () => {
      const mockUser = {
        uid: 'test-uid',
        email: 'test@example.com',
        displayName: 'Test User',
      };
      
      const mockCredential = { user: mockUser };
      
      vi.mocked(firebase.signInWithEmailAndPassword).mockResolvedValue(mockCredential as any);
      vi.mocked(firebase.getIdToken).mockResolvedValue('test-token');

      const result = await service.signInWithEmail('test@example.com', 'password');

      expect(result.user.name).toBe('Test User');
    });

    it('should map Firebase user without display name', async () => {
      const mockUser = {
        uid: 'test-uid',
        email: 'test@example.com',
        displayName: null,
      };
      
      const mockCredential = { user: mockUser };
      
      vi.mocked(firebase.signInWithEmailAndPassword).mockResolvedValue(mockCredential as any);
      vi.mocked(firebase.getIdToken).mockResolvedValue('test-token');

      const result = await service.signInWithEmail('test@example.com', 'password');

      expect(result.user.name).toBe('');
    });

    it('should map mock auth user with display name', () => {
      const mockAuth = {
        uid: 'mock-uid',
        email: 'mock@example.com',
        displayName: 'Mock User',
        stsTokenManager: {
          accessToken: 'mock-token',
          expirationTime: Date.now() + 3600000,
        },
      };
      
      localStorage.setItem('firebase:authUser:test', JSON.stringify(mockAuth));
      
      const callback = vi.fn();
      service.onAuthStateChanged(callback);

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Mock User',
        })
      );
    });

    it('should map mock auth user without display name', () => {
      const mockAuth = {
        uid: 'mock-uid',
        email: 'test@example.com',
        stsTokenManager: {
          accessToken: 'mock-token',
          expirationTime: Date.now() + 3600000,
        },
      };
      
      localStorage.setItem('firebase:authUser:test', JSON.stringify(mockAuth));
      
      const callback = vi.fn();
      service.onAuthStateChanged(callback);

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'test',
        })
      );
    });

    it('should map user without roles', () => {
      const mockAuth = {
        uid: 'mock-uid',
        email: 'mock@example.com',
        stsTokenManager: {
          accessToken: 'mock-token',
          expirationTime: Date.now() + 3600000,
        },
      };
      
      localStorage.setItem('firebase:authUser:test', JSON.stringify(mockAuth));
      
      const callback = vi.fn();
      service.onAuthStateChanged(callback);

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({
          roles: [],
        })
      );
    });
  });
});
