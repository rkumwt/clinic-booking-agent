import { ExecutionContext, SetMetadata, createParamDecorator } from '@nestjs/common';
import { AuthUser, Role } from '@clinic/shared';

export const IS_PUBLIC = 'isPublic';
/** Skips the global auth guard. A valid token is still attached if one is sent. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ROLES = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser | undefined => {
  return ctx.switchToHttp().getRequest().user;
});
