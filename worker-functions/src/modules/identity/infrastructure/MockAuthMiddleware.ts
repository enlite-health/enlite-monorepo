import { Request, Response, NextFunction } from 'express';

/**
 * Middleware de autenticação mock para testes E2E
 * 
 * Este middleware permite que testes E2E se autentiquem sem precisar
 * de um servidor Firebase real. Ele verifica tokens no formato mock_
 * e extrai as informações do usuário.
 * 
 * Para usar em testes E2E, envie header:
 * Authorization: Bearer mock_<base64_encoded_user_data>
 */
export function mockAuthMiddleware(req: Request, res: Response, next: NextFunction) {
  // Só ativar quando USE_MOCK_AUTH=true
  if (process.env.USE_MOCK_AUTH !== 'true') {
    return next();
  }

  // Rotas públicas que não precisam de auth (incluindo webhooks com autenticação própria)
  const publicPaths = ['/health', '/api/test/auth/token', '/api/jobs', '/api/workers/init', '/api/workers/lookup', '/api/vacancies/', '/api/webhooks/', '/api/webhooks-test/', '/api/internal/', '/api/public/'];
  if (publicPaths.some(path => req.path === path || req.path.startsWith(path))) {
    return next();
  }

  const authHeader = req.headers.authorization;
  
  if (!authHeader) {
    return res.status(401).json({
      success: false,
      error: 'Authorization header required',
    });
  }

  const token = authHeader.replace('Bearer ', '');

  // Verificar se é um token mock
  if (!token.startsWith('mock_')) {
    // Em modo mock, apenas tokens mock_* são válidos — rejeitar tudo mais
    return res.status(401).json({
      success: false,
      error: 'Invalid credentials',
    });
  }

  try {
    // Extrair dados do token mock
    const base64Data = token.replace('mock_', '');
    const userData = JSON.parse(Buffer.from(base64Data, 'base64').toString());

    // Validar campos obrigatórios
    if (!userData.uid || !userData.email) {
      return res.status(401).json({
        success: false,
        error: 'Invalid mock token: uid and email required',
      });
    }

    // Adicionar usuário à requisição
    (req as any).user = {
      uid: userData.uid,
      email: userData.email,
      role: userData.role || 'worker',
    };

    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      error: 'Invalid mock token format',
    });
  }
}

/**
 * Endpoint para criar sessão de teste
 * Útil para testes automatizados criarem usuários de teste
 */
export function createMockAuthEndpoints(app: any) {
  if (process.env.USE_MOCK_AUTH !== 'true') {
    return;
  }

  // Endpoint para criar token de teste
  app.post('/api/test/auth/token', (req: Request, res: Response) => {
    const { uid, email, role } = req.body;

    if (!uid || !email) {
      return res.status(400).json({
        success: false,
        error: 'uid and email required',
      });
    }

    const tokenData = Buffer.from(JSON.stringify({
      uid,
      email,
      role: role || 'worker',
      iat: Date.now(),
      exp: Date.now() + 3600000, // 1 hora
    })).toString('base64');

    const mockToken = `mock_${tokenData}`;

    res.json({
      success: true,
      data: {
        token: mockToken,
        uid,
        email,
        role,
      },
    });
  });

  // Endpoint para verificar token
  app.get('/api/test/auth/verify', mockAuthMiddleware, (req: Request, res: Response) => {
    const user = (req as any).user;
    
    if (!user) {
      return res.status(401).json({
        success: false,
        error: 'Not authenticated',
      });
    }

    res.json({
      success: true,
      data: user,
    });
  });

  console.log('✅ Mock auth endpoints registered for E2E testing');
}
