import { z } from 'zod';
import { Role } from './enums';

export const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof LoginSchema>;

// What every guard and controller sees, whichever auth provider issued the token.
export const AuthUserSchema = z.object({
  id: z.string(),
  role: Role,
  email: z.string().email().optional(),
  // Guests are anonymous patients chatting before they have a patient record.
  isGuest: z.boolean().default(false),
});
export type AuthUser = z.infer<typeof AuthUserSchema>;

export interface AuthResponse {
  accessToken: string;
  user: AuthUser;
}
