import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { query } from "./db.js";

const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const lower = "abcdefghijklmnopqrstuvwxyz";
const digits = "0123456789";
const symbols = "!@#$%^&*()-_=+[]{};:,.?";
const randomPasswordChars = upper + lower + digits + symbols;

export async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password, hash) {
  if (!hash) return false;
  return bcrypt.compare(password, hash);
}

export function generateRandomPassword(length = 16) {
  const password = [
    upper[crypto.randomInt(0, upper.length)],
    lower[crypto.randomInt(0, lower.length)],
    digits[crypto.randomInt(0, digits.length)],
    symbols[crypto.randomInt(0, symbols.length)]
  ];
  while (password.length < length) {
    password.push(randomPasswordChars[crypto.randomInt(0, randomPasswordChars.length)]);
  }
  return password.sort(() => crypto.randomInt(0, 3) - 1).join("");
}

export function requireAuth(req, res, next) {
  if (req.session.userId) return next();
  req.session.nextUrl = req.originalUrl;
  return res.redirect("/login");
}

export async function currentUser(req) {
  if (!req.session.userId) return null;
  const rows = await query("SELECT * FROM customers WHERE id = :id", { id: req.session.userId });
  return rows[0] ?? null;
}

export function consumeNextUrl(req) {
  const nextUrl = req.session.nextUrl || "/account";
  delete req.session.nextUrl;
  return nextUrl.startsWith("/") ? nextUrl : "/account";
}
