import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AuthResponse, AuthUser, Role } from '@clinic/shared';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.module';
import { AuthProvider } from './auth.provider';

interface JwtPayload {
  sub: string;
  role: Role;
  email?: string;
  guest?: boolean;
}

@Injectable()
export class LocalJwtAuthProvider implements AuthProvider {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  async login(email: string, password: string): Promise<AuthResponse> {
    const user = await this.prisma.user.findUnique({ where: { email: email.toLowerCase() } });
    // Same error for unknown email and wrong password, so emails cannot be enumerated.
    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      throw new UnauthorizedException('Invalid email or password');
    }
    return this.sign({ id: user.id, role: user.role, email: user.email, isGuest: false });
  }

  async issueGuestToken(): Promise<AuthResponse> {
    return this.sign({ id: `guest_${randomUUID()}`, role: 'PATIENT', isGuest: true });
  }

  async verifyToken(token: string): Promise<AuthUser> {
    try {
      const payload = await this.jwt.verifyAsync<JwtPayload>(token);
      return { id: payload.sub, role: payload.role, email: payload.email, isGuest: payload.guest ?? false };
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  private async sign(user: AuthUser): Promise<AuthResponse> {
    const payload: JwtPayload = { sub: user.id, role: user.role, email: user.email, guest: user.isGuest };
    return { accessToken: await this.jwt.signAsync(payload), user };
  }
}
