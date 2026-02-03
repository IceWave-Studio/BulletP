import uuid
from datetime import datetime

from sqlalchemy import (
    Column,
    String,
    Integer,
    DateTime,
    Boolean,
    ForeignKey,
    UniqueConstraint,
    Index,
)
from sqlalchemy.orm import relationship

from .database import Base

from sqlalchemy import Text



def gen_uuid() -> str:
    return str(uuid.uuid4())


class User(Base):
    __tablename__ = "users"

    id = Column(String(36), primary_key=True, default=gen_uuid)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)

    identities = relationship(
        "Identity", back_populates="user", cascade="all, delete-orphan"
    )
    bullets = relationship(
        "Bullet", back_populates="user", cascade="all, delete-orphan"
    )


class Identity(Base):
    """
    登录方式映射表：
    - provider: "wechat" / "email"
    - provider_subject: wechat=open_id/unionid, email=lowercase email
    """

    __tablename__ = "identities"

    id = Column(String(36), primary_key=True, default=gen_uuid)

    user_id = Column(String(36), ForeignKey("users.id"), nullable=False, index=True)
    provider = Column(String(36), nullable=False)
    provider_subject = Column(String(36), nullable=False)

    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)

    user = relationship("User", back_populates="identities")

    __table_args__ = (
        UniqueConstraint("provider", "provider_subject", name="uq_provider_subject"),
        Index("ix_identities_provider_subject", "provider", "provider_subject"),
    )


class Bullet(Base):
    __tablename__ = "bullets"

    id = Column(String(36), primary_key=True, default=gen_uuid)

    user_id = Column(String(36), ForeignKey("users.id"), nullable=False, index=True)

    parent_id = Column(String(36), ForeignKey("bullets.id"), nullable=True, index=True)

    text = Column(Text, nullable=False, default="")
    order_index = Column(Integer, nullable=False, default=0)

    # ✅ root 标记（SQLite-friendly）
    # root: True
    # others: NULL (allows many NULLs)
    is_root = Column(Boolean, nullable=True, default=None)

    is_deleted = Column(Boolean, nullable=False, default=False)

    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(
        DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow
    )

    user = relationship("User", back_populates="bullets")
    parent = relationship("Bullet", remote_side=[id], backref="children")

    __table_args__ = (
        # ✅ 每个 user 只能有一个 is_root=True；NULL 不受限
        UniqueConstraint("user_id", "is_root", name="uq_user_root"),
        Index("ix_bullets_user_parent_order", "user_id", "parent_id", "order_index"),
    )

class EmailOTP(Base):
    __tablename__ = "email_otps"

    id = Column(String(36), primary_key=True, default=gen_uuid)

    # ✅ email 必须够长
    email = Column(String(255), nullable=False, index=True)

    # ⚠️ 兼容旧数据：先保留 code（后面稳定了可以删）
    code = Column(String(36), nullable=True)

    # ✅ 上线用：存 hash，不存明文
    code_hash = Column(String(64), nullable=True)

    # ✅ 限流/风控用：记录请求 IP（IPv4/IPv6）
    ip = Column(String(45), nullable=True, index=True)

    expires_at = Column(DateTime, nullable=False)
    consumed_at = Column(DateTime, nullable=True)

    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)

    __table_args__ = (
        Index("ix_email_otps_email_expires", "email", "expires_at"),
        Index("ix_email_otps_ip_created", "ip", "created_at"),
    )

class WeChatLoginState(Base):
    __tablename__ = "wechat_login_states"

    id = Column(String(36), primary_key=True, default=gen_uuid)

    state = Column(String(36), nullable=False, unique=True, index=True)
    expires_at = Column(DateTime, nullable=False)
    consumed_at = Column(DateTime, nullable=True)

    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
