import crypto from "node:crypto";
import { config } from "./config.js";

const stageUrl = "https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5";
const productionUrl = "https://payment.ecpay.com.tw/Cashier/AioCheckOut/V5";

export function ecpayCheckoutUrl() {
  return config.ecpay.isProduction ? productionUrl : stageUrl;
}

function ecpayUrlEncode(value) {
  return encodeURIComponent(value)
    .replace(/%20/g, "+")
    .replace(/%2d/g, "-")
    .replace(/%5f/g, "_")
    .replace(/%2e/g, ".")
    .replace(/%21/g, "!")
    .replace(/%2a/g, "*")
    .replace(/%28/g, "(")
    .replace(/%29/g, ")")
    .toLowerCase();
}

export function generateCheckMacValue(params) {
  const entries = Object.entries(params)
    .filter(([key, value]) => key !== "CheckMacValue" && value !== undefined && value !== null)
    .sort(([a], [b]) => a.localeCompare(b, "en", { sensitivity: "base" }));

  const query = entries.map(([key, value]) => `${key}=${value}`).join("&");
  const raw = `HashKey=${config.ecpay.hashKey}&${query}&HashIV=${config.ecpay.hashIV}`;
  return crypto.createHash("sha256").update(ecpayUrlEncode(raw)).digest("hex").toUpperCase();
}

export function verifyCheckMacValue(params) {
  if (!params.CheckMacValue) return false;
  return generateCheckMacValue(params) === String(params.CheckMacValue).toUpperCase();
}

export function paymentForm(params) {
  const fields = { ...params, CheckMacValue: generateCheckMacValue(params) };
  return { action: ecpayCheckoutUrl(), fields };
}
