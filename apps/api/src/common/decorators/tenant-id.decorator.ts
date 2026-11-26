import { BadRequestException, createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthenticatedRequest } from '../types/authenticated-request';

export const TenantId = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
  if (request.tenantId) {
    return request.tenantId;
  }

  const headerValue = request.headers['x-tenant-id'];
  const tenantId = Array.isArray(headerValue) ? headerValue[0] : headerValue;

  if (!tenantId) {
    throw new BadRequestException('Missing x-tenant-id header for tenant-scoped request.');
  }

  return tenantId;
});
