import { Request, Response } from 'express';
import { DeleteUserByEmailUseCase } from '../../application/DeleteUserByEmailUseCase';
import { CreateAdminUserUseCase } from '../../application/CreateAdminUserUseCase';
import { ListAdminUsersUseCase } from '../../application/ListAdminUsersUseCase';
import { DeleteAdminUserUseCase } from '../../application/DeleteAdminUserUseCase';
import { ResetAdminPasswordUseCase } from '../../application/ResetAdminPasswordUseCase';
import { GetAdminProfileUseCase } from '../../application/GetAdminProfileUseCase';
import { UpdateAdminRoleUseCase } from '../../application/UpdateAdminRoleUseCase';
import { AdminRepository } from '../../infrastructure/AdminRepository';
import { UserRepository } from '../../infrastructure/UserRepository';
import { GoogleIdentityService } from '../../infrastructure/GoogleIdentityService';
import { EventDispatcher } from '@shared/services/EventDispatcher';
import { isStaffRole } from '../../domain/EnliteRole';

export class AdminController {
  private deleteUserByEmailUseCase: DeleteUserByEmailUseCase;
  private createAdminUseCase = new CreateAdminUserUseCase();
  private listAdminsUseCase = new ListAdminUsersUseCase();
  private deleteAdminUseCase = new DeleteAdminUserUseCase();
  private resetPasswordUseCase = new ResetAdminPasswordUseCase();
  private getProfileUseCase = new GetAdminProfileUseCase();
  private updateRoleUseCase = new UpdateAdminRoleUseCase();
  private adminRepo = new AdminRepository();

  constructor() {
    const userRepository = new UserRepository();
    const googleIdentityService = new GoogleIdentityService();
    const eventDispatcher = new EventDispatcher();

    this.deleteUserByEmailUseCase = new DeleteUserByEmailUseCase(
      userRepository,
      googleIdentityService,
      eventDispatcher
    );
  }

  /**
   * DELETE /api/admin/users/by-email
   *
   * Deletes a user completely by email address:
   * 1. Finds user in database by email
   * 2. Removes from Google Identity Platform
   * 3. Removes all database records (cascading delete)
   *
   * Body: { email: string }
   * Requires admin role
   */
  async deleteUserByEmail(req: Request, res: Response): Promise<void> {
    try {
      const { email } = req.body;

      if (!email || typeof email !== 'string') {
        res.status(400).json({
          success: false,
          error: 'Email is required',
        });
        return;
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        res.status(400).json({
          success: false,
          error: 'Invalid email format',
        });
        return;
      }

      const result = await this.deleteUserByEmailUseCase.execute({ email });

      if (result.isFailure) {
        res.status(400).json({ success: false, error: result.error });
        return;
      }

      res.status(200).json({
        success: true,
        data: { message: 'User and all associated data deleted successfully' },
      });
    } catch (error: unknown) {
      console.error('Error in deleteUserByEmail endpoint');
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  // ========== Admin CRUD ==========

  /** POST /api/admin/setup — public bootstrap (auto-disables after first admin) */
  async setup(req: Request, res: Response): Promise<void> {
    try {
      const count = await this.adminRepo.countAdmins();
      if (count > 0) {
        res.status(403).json({ success: false, error: 'Setup already completed' });
        return;
      }

      const { email, displayName, department } = req.body;
      if (!email || !displayName) {
        res.status(400).json({ success: false, error: 'email and displayName are required' });
        return;
      }

      const result = await this.createAdminUseCase.execute({ email, displayName, department });
      if (result.isFailure) {
        res.status(400).json({ success: false, error: result.error });
        return;
      }

      res.status(201).json({ success: true, data: result.getValue() });
    } catch (error) {
      console.error('Error in admin setup:', error);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  /** POST /api/admin/users */
  async createAdminUser(req: Request, res: Response): Promise<void> {
    try {
      const { email, displayName, department, role } = req.body;
      if (!email || !displayName) {
        res.status(400).json({ success: false, error: 'email and displayName are required' });
        return;
      }

      if (role !== undefined && !isStaffRole(role)) {
        res.status(400).json({ success: false, error: `Invalid role: ${role}` });
        return;
      }

      const result = await this.createAdminUseCase.execute({ email, displayName, department, role });
      if (result.isFailure) {
        res.status(400).json({ success: false, error: result.error });
        return;
      }

      res.status(201).json({ success: true, data: result.getValue() });
    } catch (error) {
      console.error('Error creating admin user');
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  /** PATCH /api/admin/users/:id/role */
  async updateAdminRole(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const { role, department } = req.body;

      if (!role || !isStaffRole(role)) {
        res.status(400).json({ success: false, error: `Invalid or missing role: ${role}` });
        return;
      }

      const result = await this.updateRoleUseCase.execute({
        firebaseUid: id,
        newRole: role,
        department,
      });

      if (result.isFailure) {
        res.status(400).json({ success: false, error: result.error });
        return;
      }

      res.status(200).json({ success: true, data: result.getValue() });
    } catch (error) {
      console.error('Error updating admin role');
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  /** GET /api/admin/users */
  async listAdminUsers(req: Request, res: Response): Promise<void> {
    try {
      const limit = Math.min(parseInt(String(req.query.limit ?? '50')), 200);
      const offset = parseInt(String(req.query.offset ?? '0'));

      const result = await this.listAdminsUseCase.execute(limit, offset);
      if (result.isFailure) {
        res.status(400).json({ success: false, error: result.error });
        return;
      }

      const data = result.getValue();
      res.status(200).json({
        success: true,
        data: data.admins,
        pagination: { limit, offset, total: data.total },
      });
    } catch (error) {
      console.error('Error listing admin users');
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  /** DELETE /api/admin/users/:id */
  async deleteAdminUser(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const result = await this.deleteAdminUseCase.execute(id);
      if (result.isFailure) {
        res.status(400).json({ success: false, error: result.error });
        return;
      }

      res.status(200).json({ success: true, data: { message: 'Admin user deleted' } });
    } catch (error) {
      console.error('Error deleting admin user');
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  /**
   * POST /api/admin/users/:id/reset-password
   * Generates a Firebase password-reset link and emails it to the user.
   * Returns the resetLink as fallback for the UI.
   */
  async resetAdminPassword(req: Request, res: Response): Promise<void> {
    try {
      const { id } = req.params;
      const result = await this.resetPasswordUseCase.execute(id);
      if (result.isFailure) {
        res.status(400).json({ success: false, error: result.error });
        return;
      }

      res.status(200).json({
        success: true,
        data: {
          resetLink: result.getValue().resetLink,
          message: 'Password reset link generated',
        },
      });
    } catch (error) {
      console.error('Error resetting admin password');
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }

  /** GET /api/admin/auth/profile */
  async getProfile(req: Request, res: Response): Promise<void> {
    try {
      const uid = (req as any).user?.uid;
      if (!uid) {
        console.warn('[ADMIN-AUTH] /profile called without authenticated uid — returning 401');
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const result = await this.getProfileUseCase.execute(uid);
      if (result.isFailure) {
        console.warn(`[ADMIN-AUTH] /profile denied | uid=${uid} reason=${result.error}`);
        res.status(404).json({ success: false, error: result.error });
        return;
      }

      res.status(200).json({ success: true, data: result.getValue() });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[ADMIN-AUTH] /profile error | ${msg}`);
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }
}
