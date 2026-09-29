import { Request } from 'express';
const { UserRole } = require('../../user/entities/user.entity');

/**
 * JWT payload structure stored in the token
 */
export interface JwtPayload {
  sub: number; // User ID (standard JWT claim for subject) - kept as number for consistency
  username: string;
  email: string;
  role: UserRole;
  /**
   * Optional scopes derived from the user role at issuance time.
   * Fine-grained guards can check these instead of coarse role checks.
   */
  scopes?: string[];
  /**
   * Session identifier bound to this token. Used for server-side
   * rotation and revocation. Missing on legacy tokens, which are
   * treated as invalid by the guard once session enforcement is enabled.
   */
  sid?: string;
  /**
   * Monotonic session version. Incremented on rotation / revocation
   * so replayed tokens fail even if the session record still exists.
   */
  sv?: number;
  iat?: number; // Issued at (optional, added by JWT)
  exp?: number; // Expiration (optional, added by JWT)
}

/**
 * Request user object attached to req.user after JWT validation
 * This is the canonical interface that should be used throughout the application
 */
export interface RequestUser {
  id: number; // Canonical user ID field
  sub?: number;
  username: string;
  email: string;
  role: UserRole;
  scopes?: string[];
  /**
   * Session identifier for the authenticated request. Present when the
   * token was issued with session binding enabled.
   */
  sid?: string;
  /**
   * Session version attached to the request for audit / debugging.
   */
  sv?: number;
}

/**
 * Type for authenticated HTTP requests
 */
export interface AuthenticatedRequest extends Request {
  user: RequestUser;
}
