import { Request, Response } from 'express';
import { DeleteUserUseCase } from '../../application/DeleteUserUseCase';
import { UserRepository } from '../../infrastructure/UserRepository';
import { GoogleIdentityService } from '../../infrastructure/GoogleIdentityService';

/**
 * UserController - Handles user management operations
 * 
 * HIPAA Compliance: 
 * - No PII in logs
 * - No PII in error messages
 * - All errors are sanitized
 */
export class UserController {
  private deleteUserUseCase: DeleteUserUseCase;

  constructor() {
    const userRepository = new UserRepository();
    const googleIdentityService = new GoogleIdentityService();

    this.deleteUserUseCase = new DeleteUserUseCase(
      userRepository,
      googleIdentityService
    );
  }

  /**
   * DELETE /api/users/me
   * 
   * Deletes the authenticated user completely:
   * 1. Removes from Google Identity Platform
   * 2. Removes worker record and all related data (cascading delete)
   * 
   * Requires x-auth-uid header
   */
  async deleteUser(req: Request, res: Response): Promise<void> {
    try {
      const authUid = req.headers['x-auth-uid'] as string;

      if (!authUid) {
        res.status(401).json({
          success: false,
          error: 'Authentication required',
        });
        return;
      }

      // Execute deletion
      const result = await this.deleteUserUseCase.execute({
        authUid,
      });

      if (result.isFailure) {
        res.status(400).json({
          success: false,
          error: result.error,
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: {
          message: 'User deleted successfully',
        },
      });
    } catch (error: any) {
      // No PII logging
      console.error('Error in deleteUser endpoint');
      res.status(500).json({
        success: false,
        error: 'Internal server error',
      });
    }
  }

  /**
   * DELETE /api/users/:userId
   * 
   * Admin endpoint to delete a specific user by ID
   * Requires appropriate authorization (to be implemented)
   */
  async deleteUserById(req: Request, res: Response): Promise<void> {
    try {
      // TODO: Add admin authorization check
      const { userId } = req.params;
      const authUid = req.headers['x-auth-uid'] as string;

      if (!userId) {
        res.status(400).json({
          success: false,
          error: 'User ID is required',
        });
        return;
      }

      // For now, require authUid for this endpoint as well
      if (!authUid) {
        res.status(401).json({
          success: false,
          error: 'Authentication required',
        });
        return;
      }

      // Execute deletion
      const result = await this.deleteUserUseCase.execute({
        authUid,
        userId,
      });

      if (result.isFailure) {
        res.status(400).json({
          success: false,
          error: result.error,
        });
        return;
      }

      res.status(200).json({
        success: true,
        data: {
          message: 'User deleted successfully',
        },
      });
    } catch (error: any) {
      // No PII logging
      console.error('Error in deleteUserById endpoint');
      res.status(500).json({
        success: false,
        error: 'Internal server error',
      });
    }
  }
}
