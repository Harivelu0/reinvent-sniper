import nodemailer from 'nodemailer';

// Reports go to `mailTo` when one is set, otherwise to the sender's own address (the usual case: Gmail sending to itself).
export const mailRecipient = s => s.mailTo || s.smtpUser;
export function mailConfigured(s) { return Boolean(s.smtpHost && s.smtpUser && s.smtpPass); }

/** Never throws: a failed email must not stop a booking run. */
export async function sendMail(settings, subject, html, text) {
  if (!mailConfigured(settings)) return { ok: false, error: 'Email is not set up yet. Add it under Profile.' };
  try {
    const transport = nodemailer.createTransport({
      host: settings.smtpHost, port: Number(settings.smtpPort) || 465,
      secure: Number(settings.smtpPort) !== 587, auth: { user: settings.smtpUser, pass: settings.smtpPass },
    });
    await transport.sendMail({ from: settings.smtpUser, to: mailRecipient(settings), subject, html, text });
    return { ok: true };
  } catch (e) {
    // The most common failure by far: a normal Gmail password instead of an app password.
    const hint = /Invalid login|Username and Password not accepted|535|EAUTH/i.test(e.message)
      ? 'Gmail did not accept the password. It must be a 16-character app password created in your Google Account (Security, App passwords), not your normal Gmail password.'
      : e.message;
    return { ok: false, error: hint };
  }
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const COLORS = { reserved: '#1a7f4b', backup: '#9a6200', full: '#b3261e', other: '#5a6b78' };

/** rows: [{ code, title, when, status, note }] */
export function reportEmail({ heading, rows, footer }) {
  const body = rows.map(r => `<tr><td style="padding:6px 8px;font-family:monospace">${esc(r.code)}</td><td style="padding:6px 8px">${esc(r.title)}<br><span style="color:#5a6b78;font-size:12px">${esc(r.when || '')}</span></td><td style="padding:6px 8px;font-weight:600;color:${COLORS[r.kind] || COLORS.other}">${esc(r.status)}${r.note ? `<br><span style="font-weight:400;color:#5a6b78;font-size:12px">${esc(r.note)}</span>` : ''}</td></tr>`).join('');
  const html = `<div style="font-family:system-ui,sans-serif;max-width:640px"><h2 style="margin:0 0 12px">${esc(heading)}</h2><table style="border-collapse:collapse;width:100%;font-size:14px">${body}</table><p style="color:#5a6b78;font-size:13px">${esc(footer || '')}</p></div>`;
  const text = `${heading}\n\n` + rows.map(r => `${r.code}  ${r.title}  [${r.status}]${r.note ? ' ' + r.note : ''}`).join('\n') + `\n\n${footer || ''}`;
  return { html, text };
}
