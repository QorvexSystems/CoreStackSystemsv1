// Barreras para que el importador no pueda apuntar a la base real por accidente.
// El modo por defecto es dry-run y no abre ninguna conexión. El modo "isolated" exige, a la vez:
//   - una URL explícita en el entorno (nunca se lee ningún .env),
//   - host de la propia máquina,
//   - nombre de base con marca de prueba,
//   - una confirmación textual.
export const ISOLATED_CONFIRMATION = 'I_UNDERSTAND_THIS_IS_NOT_THE_REAL_DATABASE';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const TEST_DATABASE_NAME = /(^|[_-])(test|isolated|sandbox|scratch|ensayo)([_-]|$)/i;
const FORBIDDEN_HOST = /supabase|pooler|neon\.tech|amazonaws|vercel|render\.com|railway/i;

export type TargetEnv = Record<string, string | undefined>;

function check(label: string, rawUrl: string | undefined, problems: string[]) {
  if (!rawUrl) {
    problems.push(`${label} no está definida en el entorno`);
    return;
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    problems.push(`${label} no es una URL válida`);
    return;
  }
  if (!['postgresql:', 'postgres:'].includes(url.protocol)) problems.push(`${label}: protocolo no PostgreSQL`);
  if (FORBIDDEN_HOST.test(url.hostname)) problems.push(`${label}: el host parece un servicio gestionado`);
  if (!LOCAL_HOSTS.has(url.hostname)) problems.push(`${label}: el host debe ser localhost (es ${url.hostname || 'vacío'})`);
  if (url.port === '6543') problems.push(`${label}: el puerto 6543 es de un pooler`);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ''));
  if (!TEST_DATABASE_NAME.test(database)) {
    problems.push(`${label}: el nombre de la base debe contener test, isolated, sandbox, scratch o ensayo`);
  }
}

/** Devuelve la URL validada o lanza un error con todos los motivos. */
export function assertIsolatedTarget(env: TargetEnv): string {
  const problems: string[] = [];
  if (env.WEB_CATALOG_IMPORT_ISOLATED !== ISOLATED_CONFIRMATION) {
    problems.push(`falta WEB_CATALOG_IMPORT_ISOLATED=${ISOLATED_CONFIRMATION}`);
  }
  check('DATABASE_URL', env.DATABASE_URL, problems);
  if (env.DIRECT_URL) check('DIRECT_URL', env.DIRECT_URL, problems);
  if (problems.length) {
    throw new Error(`Ejecución rechazada, la base no está aislada:\n - ${problems.join('\n - ')}`);
  }
  return env.DATABASE_URL as string;
}
