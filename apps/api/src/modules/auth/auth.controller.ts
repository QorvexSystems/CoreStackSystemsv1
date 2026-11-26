import { Body, Controller, Get, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Get('strategy')
  strategy() {
    return {
      currentPhase: 'jwt-email-password-and-membership-guards',
      tenantContext: 'x-tenant-id validated against authenticated memberships',
      implemented: [
        'Email/password login with bcrypt hash verification.',
        'JWT access token for API requests.',
        'Tenant membership validation before tenant-scoped API access.',
        'Role guard support per controller action.',
      ],
      nextPhase: ['Refresh token rotation.', 'Password recovery.', 'MFA-ready login events.'],
    };
  }
}
