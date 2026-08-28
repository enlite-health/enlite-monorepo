import { HttpClient } from '../http/HttpClient';
import { TokenStorage } from '../storage/TokenStorage';
import { AuthRepository } from '../repositories/AuthRepository';
import { HttpUserRepository } from '../repositories/HttpUserRepository';
import { FirebaseAuthService } from '../services/FirebaseAuthService';
import { AuthenticateWithGoogleUseCase } from '@application/use-cases/AuthenticateWithGoogleUseCase';
import { GetCurrentUserUseCase } from '@application/use-cases/GetCurrentUserUseCase';
import { LogoutUseCase } from '@application/use-cases/LogoutUseCase';
import { RegisterUserUseCase } from '@application/use-cases/RegisterUserUseCase';
import { ENV } from '../config/env';

export class Container {
  private static instance: Container;
  
  private readonly tokenStorage: TokenStorage;
  private readonly httpClient: HttpClient;
  private readonly authRepository: AuthRepository;
  private readonly userRepository: HttpUserRepository;
  private readonly firebaseAuthService: FirebaseAuthService;

  private constructor() {
    this.tokenStorage = new TokenStorage();
    this.httpClient = new HttpClient({ baseURL: ENV.API_WORKER_FUNCTIONS_URL });
    
    this.authRepository = new AuthRepository(this.httpClient, this.tokenStorage);
    this.userRepository = new HttpUserRepository(this.httpClient);
    this.firebaseAuthService = new FirebaseAuthService();
  }

  static getInstance(): Container {
    if (!Container.instance) {
      Container.instance = new Container();
    }
    return Container.instance;
  }

  getAuthenticateWithGoogleUseCase(): AuthenticateWithGoogleUseCase {
    return new AuthenticateWithGoogleUseCase(this.authRepository);
  }

  getGetCurrentUserUseCase(): GetCurrentUserUseCase {
    return new GetCurrentUserUseCase(this.authRepository);
  }

  getLogoutUseCase(): LogoutUseCase {
    return new LogoutUseCase(this.authRepository);
  }

  getRegisterUserUseCase(): RegisterUserUseCase {
    return new RegisterUserUseCase(this.firebaseAuthService, this.userRepository);
  }
}
