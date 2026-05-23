import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const configPath = process.env.CONFIG_PATH ? path.resolve(process.env.CONFIG_PATH) : path.join(rootDir, "config.json");

export const config = applyEnvironmentOverrides(JSON.parse(fs.readFileSync(configPath, "utf8")));
export const paths = { rootDir, configPath };

export function publicConfig() {
  return {
    site: config.site,
    ecpayMode: config.ecpay.isProduction ? "production" : "stage",
    pterodactylEnabled: Boolean(config.pterodactyl.enabled)
  };
}

function applyEnvironmentOverrides(baseConfig) {
  const nextConfig = structuredClone(baseConfig);

  if (process.env.PORT) nextConfig.port = parseNumber(process.env.PORT, nextConfig.port);
  if (process.env.DATABASE_FILE) {
    nextConfig.database = nextConfig.database || {};
    nextConfig.database.file = process.env.DATABASE_FILE;
  }

  const smtpOverrides = {
    enabled: parseBoolean(process.env.SMTP_ENABLED),
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT ? parseNumber(process.env.SMTP_PORT, nextConfig.smtp?.port) : undefined,
    secure: parseBoolean(process.env.SMTP_SECURE),
    from: process.env.SMTP_FROM,
    authUser: process.env.SMTP_USER,
    authPass: process.env.SMTP_PASS
  };

  if (Object.values(smtpOverrides).some((value) => value !== undefined)) {
    nextConfig.smtp = nextConfig.smtp || {};
    if (smtpOverrides.enabled !== undefined) nextConfig.smtp.enabled = smtpOverrides.enabled;
    if (smtpOverrides.host !== undefined) nextConfig.smtp.host = smtpOverrides.host;
    if (smtpOverrides.port !== undefined) nextConfig.smtp.port = smtpOverrides.port;
    if (smtpOverrides.secure !== undefined) nextConfig.smtp.secure = smtpOverrides.secure;
    if (smtpOverrides.from !== undefined) nextConfig.smtp.from = smtpOverrides.from;
    nextConfig.smtp.auth = nextConfig.smtp.auth || {};
    if (smtpOverrides.authUser !== undefined) nextConfig.smtp.auth.user = smtpOverrides.authUser;
    if (smtpOverrides.authPass !== undefined) nextConfig.smtp.auth.pass = smtpOverrides.authPass;
  }

  return nextConfig;
}

function parseNumber(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoolean(value) {
  if (value === undefined) return undefined;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}
