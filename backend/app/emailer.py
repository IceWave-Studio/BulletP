import os
import smtplib
from email.mime.text import MIMEText
from email.header import Header

SMTP_HOST = os.getenv("ALIYUN_SMTP_HOST")
SMTP_PORT = int(os.getenv("ALIYUN_SMTP_PORT", "465"))
SMTP_USER = os.getenv("ALIYUN_SMTP_USER")
SMTP_PASS = os.getenv("ALIYUN_SMTP_PASS")
EMAIL_FROM = os.getenv("EMAIL_FROM")
SMTP_SSL = os.getenv("ALIYUN_SMTP_SSL", "true").lower() == "true"


class EmailSendError(RuntimeError):
    pass


def send_verification_email(to_email: str, code: str) -> None:
    if not all([SMTP_HOST, SMTP_USER, SMTP_PASS, EMAIL_FROM]):
        raise EmailSendError("SMTP env not fully configured")

    subject = "Your BulletP verification code"
    html = f"""
    <div style="font-family: Arial, sans-serif;">
      <h2>BulletP Verification</h2>
      <p>Your verification code is:</p>
      <p style="font-size:24px;font-weight:bold;letter-spacing:2px;">
        {code}
      </p>
      <p>This code will expire in 10 minutes.</p>
      <p>If you did not request this, please ignore this email.</p>
    </div>
    """

    msg = MIMEText(html, "html", "utf-8")
    msg["Subject"] = Header(subject, "utf-8")
    msg["From"] = EMAIL_FROM
    msg["To"] = to_email

    try:
        if SMTP_SSL:
            server = smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, timeout=15)
        else:
            server = smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=15)
            server.starttls()

        server.login(SMTP_USER, SMTP_PASS)
        server.sendmail(EMAIL_FROM, [to_email], msg.as_string())
        server.quit()
    except Exception as e:
        raise EmailSendError(str(e)) from e

