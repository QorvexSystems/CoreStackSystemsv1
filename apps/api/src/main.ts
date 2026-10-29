import { createCoreStackApiApp, listenCoreStackApi } from './bootstrap';

async function bootstrap() {
  const app = await createCoreStackApiApp();
  await listenCoreStackApi(app);
}

void bootstrap();
