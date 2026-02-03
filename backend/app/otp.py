# app/otp.py
import os
import hmac
import hashlib
import secrets

OTP_SECRET = os.getenv("OTP_SECRET", "dev_secret_change_me")

def gen_code() -> str:
    """6-digit numeric code"""
    return f"{secrets.randbelow(10**6):06d}"

def hash_code(code: str) -> str:
    """HMAC-SHA256 hex digest (64 chars)"""
    return hmac.new(OTP_SECRET.encode("utf-8"), code.encode("utf-8"), hashlib.sha256).hexdigest()

def verify_code(code: str, code_hash: str) -> bool:
    if not code_hash:
        return False
    return hmac.compare_digest(hash_code(code), code_hash)

