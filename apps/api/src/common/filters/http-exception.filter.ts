import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
} from '@nestjs/common';

type HttpResponse = {
  status: (code: number) => {
    json: (body: unknown) => void;
  };
};

type HttpRequest = {
  url?: string;
};

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const context = host.switchToHttp();
    const response = context.getResponse<HttpResponse>();
    const request = context.getRequest<HttpRequest>();
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const exceptionResponse =
      exception instanceof HttpException ? exception.getResponse() : 'Internal server error';
    const message =
      typeof exceptionResponse === 'string'
        ? exceptionResponse
        : (exceptionResponse as { message?: string | string[] }).message;

    // Solo se reenvían estos dos campos opcionales (códigos de negocio del canal); el resto no se expone.
    const extra = typeof exceptionResponse === 'object' ? (exceptionResponse as Record<string, unknown>) : {};

    response.status(status).json({
      statusCode: status,
      message: message ?? 'Unexpected error',
      ...(typeof extra.code === 'string' ? { code: extra.code } : {}),
      ...(Array.isArray(extra.variantIds) && extra.variantIds.every((id) => typeof id === 'string')
        ? { variantIds: extra.variantIds }
        : {}),
      path: request.url ?? '',
      timestamp: new Date().toISOString(),
    });
  }
}
