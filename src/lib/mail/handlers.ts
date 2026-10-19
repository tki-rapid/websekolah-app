import { registerHandler } from "@/lib/jobs";
import { env } from "@/lib/env";
import { invitationMail, passwordResetMail, sendMail } from "@/lib/mail/mailer";
import { INVITATION_TTL_HOURS } from "@/lib/auth/invitations";
import { RESET_TTL_MINUTES } from "@/lib/auth/password-reset";

/** Job handlers for outbound e-mail. Raw tokens come from the job's sealed `secret`, never from plaintext columns. */
let registered = false;
export function registerMailHandlers() {
  if (registered) return;
  registered = true;
  registerHandler("email.invitation", async (j) => {
    const { token } = j.secret as { token: string };
    const { to, schoolName } = j.payload as { to: string; schoolName: string };
    await sendMail(invitationMail({ to, schoolName, link: new URL(`/invite/${token}`, env().APP_URL).toString(), hours: INVITATION_TTL_HOURS }));
  });
  registerHandler("email.password_reset", async (j) => {
    const { token } = j.secret as { token: string };
    const { to } = j.payload as { to: string };
    await sendMail(passwordResetMail({ to, link: new URL(`/reset/${token}`, env().APP_URL).toString(), minutes: RESET_TTL_MINUTES }));
  });
}
