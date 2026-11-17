import { AuthResponse, AuthUser } from '@clinic/shared';

// The rest of the app depends only on this interface. LocalJwtAuthProvider
// implements it today; a CognitoAuthProvider can replace it by verifying
// Cognito-issued tokens in verifyToken() and delegating login to Cognito.
export interface AuthProvider {
  login(email: string, password: string): Promise<AuthResponse>;
  issueGuestToken(): Promise<AuthResponse>;
  verifyToken(token: string): Promise<AuthUser>;
}

export const AUTH_PROVIDER = Symbol('AUTH_PROVIDER');
