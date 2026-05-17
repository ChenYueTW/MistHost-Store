import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const configPath = path.join(rootDir, "config.json");

export const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
export const paths = { rootDir, configPath };

export function publicConfig() {
  return {
    site: config.site,
    ecpayMode: config.ecpay.isProduction ? "production" : "stage",
    pterodactylEnabled: Boolean(config.pterodactyl.enabled)
  };
}
