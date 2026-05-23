import nodemailer from "nodemailer";
import { config } from "./config.js";

function smtpConfig() {
  return config.smtp ?? {};
}

export function isSmtpEnabled() {
  const smtp = smtpConfig();
  return Boolean(smtp.enabled && smtp.host && smtp.port && smtp.auth?.user && smtp.auth?.pass);
}

export async function sendPasswordResetEmail({ to, resetUrl }) {
  if (!isSmtpEnabled()) {
    throw new Error("SMTP is not configured.");
  }

  const smtp = smtpConfig();
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: Number(smtp.port),
    secure: Boolean(smtp.secure),
    auth: {
      user: smtp.auth.user,
      pass: smtp.auth.pass
    }
  });

  await transporter.sendMail({
    from: smtp.from || smtp.auth.user,
    to,
    subject: `${config.site.name} 密碼重設`,
    text: `請使用以下連結重設密碼：\n\n${resetUrl}\n\n如果不是你本人操作，請忽略這封信。`,
    html: `
      <p>請使用以下連結重設密碼：</p>
      <p><a href="${resetUrl}">${resetUrl}</a></p>
      <p>如果不是你本人操作，請忽略這封信。</p>
    `
  });
}
