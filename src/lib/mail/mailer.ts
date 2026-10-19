import nodemailer, { type Transporter } from "nodemailer";
import { env, isProd } from "@/lib/env";

export type Mail = { to: string; subject: string; text: string; html: string };
export type Sender = (m: Mail) => Promise<void>;

let transport: Transporter | undefined;
let override: Sender | undefined;
/** Tests inject a capturing sender. */
export const setMailSender = (s: Sender | undefined) => { override = s; };

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export async function sendMail(m: Mail): Promise<void> {
  if (override) return override(m);
  const e = env();
  if (!e.SMTP_URL) {
    if (isProd()) throw new Error("SMTP not configured");
    // development: never print links/tokens in production logs, but it is the point of dev mode
    console.log(`\n[mail:dev] to=${m.to}\nsubject=${m.subject}\n${m.text}\n`);
    return;
  }
  transport ??= nodemailer.createTransport(e.SMTP_URL);
  await transport.sendMail({ from: e.MAIL_FROM, to: m.to, subject: m.subject, text: m.text, html: m.html });
}

const shell = (title: string, body: string) => `<!doctype html><html lang="id"><body style="margin:0;background:#faf7f3;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#14172b"><table role="presentation" width="100%"><tr><td align="center" style="padding:32px 16px"><table role="presentation" width="520" style="max-width:520px;background:#fff;border:1px solid #e5e3de;border-radius:12px"><tr><td style="padding:28px"><div style="font-weight:800;letter-spacing:.18em;font-size:12px;text-transform:uppercase">WebSekolah</div><h1 style="font-size:22px;margin:18px 0 8px">${esc(title)}</h1>${body}</td></tr></table><p style="font-size:12px;color:#6a6a6a;margin-top:16px">Email otomatis — jangan membalas.</p></td></tr></table></body></html>`;
const button = (href: string, label: string) => `<p style="margin:22px 0"><a href="${esc(href)}" style="background:#3730a3;color:#fff;text-decoration:none;padding:12px 22px;border-radius:99px;font-weight:700;display:inline-block">${esc(label)}</a></p>`;

export function invitationMail(o: { to: string; schoolName: string; link: string; hours: number }): Mail {
  return {
    to: o.to,
    subject: `Undangan admin website ${o.schoolName}`,
    text: `Anda diundang sebagai admin website ${o.schoolName} di WebSekolah.\n\nAktifkan akun Anda (berlaku ${o.hours} jam, sekali pakai):\n${o.link}\n\nJika Anda tidak merasa meminta ini, abaikan email ini.`,
    html: shell("Aktifkan akun admin", `<p>Anda diundang sebagai admin website <b>${esc(o.schoolName)}</b>.</p>${button(o.link, "Aktifkan akun")}<p style="font-size:13px;color:#555">Tautan berlaku ${o.hours} jam dan hanya dapat dipakai sekali. Jika Anda tidak merasa meminta ini, abaikan email ini.</p>`),
  };
}

export function passwordResetMail(o: { to: string; link: string; minutes: number }): Mail {
  return {
    to: o.to,
    subject: "Atur ulang kata sandi WebSekolah",
    text: `Kami menerima permintaan mengatur ulang kata sandi.\n\nBuka tautan ini (berlaku ${o.minutes} menit, sekali pakai):\n${o.link}\n\nJika bukan Anda, abaikan email ini — kata sandi tidak berubah.`,
    html: shell("Atur ulang kata sandi", `<p>Kami menerima permintaan mengatur ulang kata sandi akun Anda.</p>${button(o.link, "Atur ulang kata sandi")}<p style="font-size:13px;color:#555">Berlaku ${o.minutes} menit dan hanya sekali pakai. Jika bukan Anda, abaikan email ini.</p>`),
  };
}
