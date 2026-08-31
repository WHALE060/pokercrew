import type { Mailer } from "./accounts.js";

/**
 * Sends one-time codes through Brevo's transactional email API.
 * Needs env: BREVO_API_KEY, MAIL_FROM (verified sender), optional MAIL_FROM_NAME.
 */
export class BrevoMailer implements Mailer {
  constructor(
    private apiKey: string,
    private from: string,
    private fromName = "PokerCrew"
  ) {}

  async sendOtp(email: string, code: string, purpose: "login" | "signup"): Promise<void> {
    const subject = purpose === "signup"
      ? `${code} is your PokerCrew sign-up code`
      : `${code} is your PokerCrew sign-in code`;
    const intro = purpose === "signup"
      ? "Welcome to PokerCrew. Enter this code to finish creating your account:"
      : "Enter this code to sign in to PokerCrew:";

    const html = `
      <div style="background:#150F1B;padding:32px 16px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;">
        <div style="max-width:440px;margin:0 auto;background:#241A2E;border-radius:16px;padding:28px 28px 24px;color:#F3EDE6;">
          <div style="font-family:Georgia,serif;font-size:22px;margin-bottom:4px;">Poker<span style="color:#E3B23C">Crew</span></div>
          <div style="font-size:11px;letter-spacing:3px;color:#A79AB3;margin-bottom:22px;">PRIVATE POKER CLUBS</div>
          <p style="margin:0 0 14px;font-size:15px;line-height:1.5;color:#F3EDE6;">${intro}</p>
          <div style="font-family:ui-monospace,Menlo,monospace;font-size:34px;letter-spacing:8px;color:#F3D580;background:#1A1220;border-radius:12px;padding:16px;text-align:center;margin:0 0 16px;">${code}</div>
          <p style="margin:0;font-size:13px;color:#A79AB3;line-height:1.5;">This code expires in 10 minutes. If you didn't request it, you can ignore this email.</p>
        </div>
      </div>`;

    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": this.apiKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: { email: this.from, name: this.fromName },
        to: [{ email }],
        subject,
        htmlContent: html,
        textContent: `${intro}\n\n${code}\n\nThis code expires in 10 minutes.`,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[mail] Brevo error ${res.status}: ${body}`);
      throw new Error("Could not send email. Try again in a moment.");
    }
  }
}
