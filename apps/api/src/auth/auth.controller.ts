import { Body, Controller, Get, HttpCode, Inject, Post } from '@nestjs/common';
import { AuthUser, LoginInput, LoginSchema } from '@clinic/shared';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { PrismaService } from '../prisma/prisma.module';
import { AUTH_PROVIDER, AuthProvider } from './auth.provider';
import { CurrentUser, Public, Roles } from './decorators';

@Controller()
export class AuthController {
  constructor(
    @Inject(AUTH_PROVIDER) private readonly auth: AuthProvider,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Post('auth/login')
  @HttpCode(200)
  login(@Body(new ZodValidationPipe(LoginSchema)) body: LoginInput) {
    return this.auth.login(body.email, body.password);
  }

  /** Anonymous patient session for the chat app. */
  @Public()
  @Post('auth/guest')
  @HttpCode(200)
  guest() {
    return this.auth.issueGuestToken();
  }

  @Get('auth/me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }

  @Roles('ADMIN')
  @Get('users')
  listUsers() {
    return this.prisma.user.findMany({
      select: { id: true, email: true, name: true, role: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
  }
}
