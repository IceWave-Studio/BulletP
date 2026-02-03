from fastapi import FastAPI, HTTPException, BackgroundTasks, Request
from pydantic import BaseModel
from typing import Optional

from .emailer import send_verification_email
from .otp import gen_code, hash_code, verify_code

from sqlalchemy import select, update, and_
from sqlalchemy.orm import Session

from .database import Base, engine, SessionLocal
from .models import User, Identity, Bullet, gen_uuid

import random
from datetime import datetime, timedelta
from sqlalchemy import delete
from .models import EmailOTP

import os
from datetime import datetime, timedelta
from urllib.parse import urlencode

from .models import WeChatLoginState

from fastapi.middleware.cors import CORSMiddleware



class WeChatQRStartOut(BaseModel):
    state: str
    qr_url: str
    expires_in: int

WECHAT_APPID = os.getenv("WECHAT_APPID", "")
WECHAT_SECRET = os.getenv("WECHAT_SECRET", "")
WECHAT_REDIRECT_URI = os.getenv("WECHAT_REDIRECT_URI", "")  # 例如 https://xxx.com/api/auth/wechat/callback

def require_wechat_config():
    if not WECHAT_APPID or not WECHAT_REDIRECT_URI:
        raise HTTPException(status_code=500, detail="WECHAT_APPID/WECHAT_REDIRECT_URI not configured")

def create_wechat_state(db: Session) -> str:
    state = gen_uuid()
    row = WeChatLoginState(
        id=gen_uuid(),
        state=state,
        expires_at=datetime.utcnow() + timedelta(minutes=5),
        consumed_at=None,
    )
    db.add(row)
    db.flush()
    return state

def consume_wechat_state(db: Session, state: str):
    row = db.execute(
        select(WeChatLoginState)
        .where(
            WeChatLoginState.state == state,
            WeChatLoginState.consumed_at.is_(None),
            WeChatLoginState.expires_at > datetime.utcnow(),
        )
        .limit(1)
    ).scalar_one_or_none()

    if row is None:
        raise HTTPException(status_code=400, detail="invalid or expired state")

    row.consumed_at = datetime.utcnow()
    db.flush()


class EmailStartIn(BaseModel):
    email: str

class EmailVerifyIn(BaseModel):
    email: str
    code: str

OTP_EXPIRE_SECONDS = int(os.getenv("OTP_EXPIRE_SECONDS", "600"))
OTP_COOLDOWN_SECONDS = int(os.getenv("OTP_COOLDOWN_SECONDS", "60"))
OTP_IP_LIMIT_PER_HOUR = int(os.getenv("OTP_IP_LIMIT_PER_HOUR", "20"))

def get_client_ip(request: Request) -> str:
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    if request.client:
        return request.client.host
    return "unknown"

app = FastAPI(title="BulletP Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)




# ✅ 只在开发环境自动建表；生产环境请用 Alembic 或手动迁移
ENV = os.getenv("ENV", "dev").lower()
if ENV != "prod":
    Base.metadata.create_all(bind=engine)


DEFAULT_USER = "default"
HOME_TEXT = "Home"


# -----------------------------
# Pydantic Schemas (MVP)
# -----------------------------
class CreateNodeIn(BaseModel):
    parent_id: Optional[str] = None
    text: str = ""

class UpdateNodeIn(BaseModel):
    text: str

class MoveNodeIn(BaseModel):
    new_parent_id: str
    new_order_index: int



class BootstrapReq(BaseModel):
    provider: str   # "email" / "wechat"
    subject: str    # email 或 openid/unionid


# -----------------------------
# Helpers
# -----------------------------
def norm_user_id(user_id: Optional[str]) -> str:
    return (user_id or DEFAULT_USER).strip() or DEFAULT_USER


def ensure_user_exists(db: Session, user_id: str):
    u = db.get(User, user_id)
    if u is None:
        u = User(id=user_id)
        db.add(u)
        db.flush()
    return u


def ensure_home(db: Session, user_id: str) -> Bullet:
    """
    Ensure this user has exactly one Home(root) and return it.
    Uses is_root=True as the canonical root marker.
    """
    user_id = norm_user_id(user_id)
    ensure_user_exists(db, user_id)

    home = db.execute(
        select(Bullet)
        .where(
            Bullet.user_id == user_id,
            Bullet.is_root == True,
            Bullet.is_deleted == False,
        )
        .order_by(Bullet.created_at.asc())
        .limit(1)
    ).scalar_one_or_none()

    if home is None:
        home = Bullet(
            id=gen_uuid(),
            user_id=user_id,
            parent_id=None,
            text=HOME_TEXT,
            order_index=0,
            is_root=True,
            is_deleted=False,
        )
        db.add(home)
        db.flush()

    return home


def get_or_create_user_by_identity(db: Session, provider: str, subject: str) -> User:
    provider = (provider or "").strip()
    subject = (subject or "").strip()
    if not provider or not subject:
        raise HTTPException(status_code=400, detail="provider/subject required")

    if provider == "email":
        subject = subject.lower()

    ident = db.execute(
        select(Identity).where(
            Identity.provider == provider,
            Identity.provider_subject == subject,
        )
    ).scalar_one_or_none()

    if ident:
        user = db.get(User, ident.user_id)
        if not user:
            raise HTTPException(status_code=500, detail="identity points to missing user")
        return user

    # create: user + identity + home (single transaction controlled by caller)
    user = User(id=gen_uuid())
    db.add(user)
    db.flush()

    ident = Identity(
        id=gen_uuid(),
        user_id=user.id,
        provider=provider,
        provider_subject=subject,
    )
    db.add(ident)

    ensure_home(db, user.id)
    return user


def build_subtree(db: Session, user_id: str, root_id: str, depth: int):
    user_id = norm_user_id(user_id)

    root = db.get(Bullet, root_id)
    if root is None or root.is_deleted or root.user_id != user_id:
        return None

    def build(node: Bullet, d: int):
        has_children = (
            db.execute(
                select(Bullet.id)
                .where(
                    Bullet.user_id == user_id,
                    Bullet.parent_id == node.id,
                    Bullet.is_deleted == False,
                )
                .limit(1)
            ).scalar_one_or_none()
            is not None
        )

        out = {
            "id": node.id,
            "parent_id": node.parent_id,
            "text": node.text,
            "order_index": node.order_index,
            "has_children": has_children,
            "children": [],
        }

        if d <= 0:
            return out

        kids = db.execute(
            select(Bullet)
            .where(
                Bullet.user_id == user_id,
                Bullet.parent_id == node.id,
                Bullet.is_deleted == False,
            )
            .order_by(Bullet.order_index.asc(), Bullet.created_at.asc())
        ).scalars().all()

        out["children"] = [build(k, d - 1) for k in kids]
        return out

    return build(root, depth)


# -----------------------------
# Routes
# -----------------------------
@app.get("/")
def root():
    return {"name": "BulletP Backend", "status": "running", "docs": "/docs"}

@app.post("/api/auth/email/start")
def email_start(payload: EmailStartIn, background_tasks: BackgroundTasks, request: Request):
    email = (payload.email or "").strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="invalid email")

    ip = get_client_ip(request)
    now = datetime.utcnow()

    db = SessionLocal()
    try:
        with db.begin():
            # 1) 邮箱冷却：最近一次发送 < cooldown 秒则拒绝
            last = db.execute(
                select(EmailOTP)
                .where(EmailOTP.email == email)
                .order_by(EmailOTP.created_at.desc())
                .limit(1)
            ).scalar_one_or_none()

            if last is not None:
                delta = (now - last.created_at).total_seconds()
                if delta < OTP_COOLDOWN_SECONDS:
                    raise HTTPException(status_code=429, detail="too frequent, try later")

            # 2) IP 限流：过去 1 小时内同 IP 次数
            one_hour_ago = now - timedelta(hours=1)
            ip_count = db.execute(
                select(EmailOTP.id)
                .where(
                    EmailOTP.ip == ip,
                    EmailOTP.created_at >= one_hour_ago,
                )
            ).scalars().all()
            if len(ip_count) >= OTP_IP_LIMIT_PER_HOUR:
                raise HTTPException(status_code=429, detail="rate limit")

            # 3) 生成验证码并入库（只存 hash）
            code = gen_code()
            row = EmailOTP(
                id=gen_uuid(),
                email=email,
                code=None,                  # 旧字段不再使用
                code_hash=hash_code(code),  # ✅ 只存 hash
                ip=ip,
                expires_at=now + timedelta(seconds=OTP_EXPIRE_SECONDS),
                consumed_at=None,
            )
            db.add(row)

        # 4) 后台发邮件（不阻塞请求）
        background_tasks.add_task(send_verification_email, email, code)

        return {"ok": True}
    finally:
        db.close()

@app.post("/api/auth/email/verify")
def email_verify(payload: EmailVerifyIn):
    email = (payload.email or "").strip().lower()
    code = (payload.code or "").strip()
    if not email or not code:
        raise HTTPException(status_code=400, detail="missing email/code")

    now = datetime.utcnow()

    db = SessionLocal()
    try:
        with db.begin():
            row = db.execute(
                select(EmailOTP)
                .where(
                    EmailOTP.email == email,
                    EmailOTP.consumed_at.is_(None),
                )
                .order_by(EmailOTP.created_at.desc())
                .limit(1)
            ).scalar_one_or_none()

            if row is None:
                raise HTTPException(status_code=400, detail="code not found")

            if row.expires_at <= now:
                raise HTTPException(status_code=400, detail="code expired")

            # ✅ 新逻辑：hash 校验；兼容旧数据：如果 code_hash 为空就退回明文比对
            ok = False
            if row.code_hash:
                ok = verify_code(code, row.code_hash)
            elif row.code:
                ok = (code == row.code)

            if not ok:
                raise HTTPException(status_code=400, detail="invalid code")

            row.consumed_at = now

            # 登录成功：创建/获取 user + identity，并确保 home 存在
            user = get_or_create_user_by_identity(db, "email", email)
            home = ensure_home(db, user.id)

        return {"ok": True, "user_id": user.id, "home_id": home.id}
    finally:
        db.close()

@app.post("/api/dev/bootstrap")
def dev_bootstrap(payload: BootstrapReq):
    """
    Dev 用：用 provider+subject 直接创建/登录用户，并返回 home_id
    """
    db = SessionLocal()
    try:
        with db.begin():
            user = get_or_create_user_by_identity(db, payload.provider, payload.subject)
            home = ensure_home(db, user.id)
        return {"user_id": user.id, "home_id": home.id}
    finally:
        db.close()



@app.get("/api/home")
def get_home(user_id: Optional[str] = None):
    db = SessionLocal()
    try:
        with db.begin():
            home = ensure_home(db, norm_user_id(user_id))
        return {
            "id": home.id,
            "text": home.text,
            "parent_id": home.parent_id,
            "user_id": home.user_id,
        }
    finally:
        db.close()


@app.post("/api/nodes")
def create_node(payload: CreateNodeIn, user_id: Optional[str] = None):
    db = SessionLocal()
    try:
        user_id = norm_user_id(user_id)
        parent_id = payload.parent_id

        with db.begin():
            if parent_id is None:
                home = ensure_home(db, user_id)
                parent_id = home.id

            parent = db.get(Bullet, parent_id)
            if parent is None or parent.is_deleted or parent.user_id != user_id:
                raise HTTPException(status_code=404, detail="parent not found")

            max_order = db.execute(
                select(Bullet.order_index)
                .where(
                    Bullet.user_id == user_id,
                    Bullet.parent_id == parent_id,
                    Bullet.is_deleted == False,
                )
                .order_by(Bullet.order_index.desc())
                .limit(1)
            ).scalar_one_or_none()

            order_index = (max_order + 1) if max_order is not None else 0

            node = Bullet(
                id=gen_uuid(),
                user_id=user_id,
                parent_id=parent_id,
                text=payload.text,
                order_index=order_index,
                is_root=None,
            )
            db.add(node)
            db.flush()

        return {
            "id": node.id,
            "parent_id": node.parent_id,
            "text": node.text,
            "order_index": node.order_index,
            "user_id": node.user_id,
        }
    finally:
        db.close()



@app.get("/api/nodes/{parent_id}/children")
def get_children(parent_id: str, user_id: Optional[str] = None):
    db = SessionLocal()
    try:
        user_id = norm_user_id(user_id)

        parent = db.get(Bullet, parent_id)
        if parent is None or parent.is_deleted or parent.user_id != user_id:
            raise HTTPException(status_code=404, detail="parent not found")

        rows = db.execute(
            select(Bullet)
            .where(
                Bullet.user_id == user_id,
                Bullet.parent_id == parent_id,
                Bullet.is_deleted == False,
            )
            .order_by(Bullet.order_index.asc(), Bullet.created_at.asc())
        ).scalars().all()

        out = []
        for b in rows:
            has_children = (
                db.execute(
                    select(Bullet.id)
                    .where(
                        Bullet.user_id == user_id,
                        Bullet.parent_id == b.id,
                        Bullet.is_deleted == False,
                    )
                    .limit(1)
                ).scalar_one_or_none()
                is not None
            )

            out.append(
                {
                    "id": b.id,
                    "parent_id": b.parent_id,
                    "text": b.text,
                    "order_index": b.order_index,
                    "has_children": has_children,
                    "user_id": b.user_id,
                }
            )

        return out
    finally:
        db.close()


@app.get("/api/nodes/{node_id}")
def get_node(node_id: str, user_id: Optional[str] = None):
    db = SessionLocal()
    try:
        user_id = norm_user_id(user_id)
        node = db.get(Bullet, node_id)
        if node is None or node.is_deleted or node.user_id != user_id:
            raise HTTPException(status_code=404, detail="node not found")

        return {
            "id": node.id,
            "parent_id": node.parent_id,
            "text": node.text,
            "order_index": node.order_index,
            "user_id": node.user_id,
        }
    finally:
        db.close()


@app.patch("/api/nodes/{node_id}")
def update_node(node_id: str, payload: UpdateNodeIn, user_id: Optional[str] = None):
    db = SessionLocal()
    try:
        user_id = norm_user_id(user_id)

        with db.begin():
            node = db.get(Bullet, node_id)
            if node is None or node.is_deleted or node.user_id != user_id:
                raise HTTPException(status_code=404, detail="node not found")

            node.text = payload.text
            db.flush()

        return {
            "id": node.id,
            "parent_id": node.parent_id,
            "text": node.text,
            "order_index": node.order_index,
            "user_id": node.user_id,
        }
    finally:
        db.close()


@app.delete("/api/nodes/{node_id}")
def delete_node(node_id: str, user_id: Optional[str] = None):
    db = SessionLocal()
    try:
        user_id = norm_user_id(user_id)

        with db.begin():
            node = db.get(Bullet, node_id)
            if node is None or node.is_deleted or node.user_id != user_id:
                raise HTTPException(status_code=404, detail="node not found")

            # 不允许删除 root
            if node.is_root is True:
                raise HTTPException(status_code=400, detail="cannot delete root")

            node.is_deleted = True
            db.flush()

        return {"ok": True}
    finally:
        db.close()


@app.post("/api/nodes/{node_id}/move")
def move_node(node_id: str, payload: MoveNodeIn, user_id: Optional[str] = None):
    db = SessionLocal()
    try:
        user_id = norm_user_id(user_id)

        with db.begin():
            node = db.get(Bullet, node_id)
            if node is None or node.is_deleted or node.user_id != user_id:
                raise HTTPException(status_code=404, detail="node not found")

            if node.is_root is True:
                raise HTTPException(status_code=400, detail="cannot move root")

            new_parent = db.get(Bullet, payload.new_parent_id)
            if new_parent is None or new_parent.is_deleted or new_parent.user_id != user_id:
                raise HTTPException(status_code=404, detail="new parent not found")

            old_parent_id = node.parent_id
            old_order = node.order_index

            new_parent_id = payload.new_parent_id
            new_order = payload.new_order_index

            sibling_ids = db.execute(
                select(Bullet.id)
                .where(
                    Bullet.user_id == user_id,
                    Bullet.parent_id == new_parent_id,
                    Bullet.is_deleted == False,
                )
            ).scalars().all()

            n = len(sibling_ids)
            if old_parent_id == new_parent_id:
                n = max(n - 1, 0)

            if new_order < 0:
                new_order = 0
            if new_order > n:
                new_order = n

            # Case 1: same parent reorder
            if old_parent_id == new_parent_id:
                if new_order == old_order:
                    return {
                        "id": node.id,
                        "parent_id": node.parent_id,
                        "text": node.text,
                        "order_index": node.order_index,
                        "user_id": node.user_id,
                    }

                if new_order > old_order:
                    db.execute(
                        update(Bullet)
                        .where(
                            and_(
                                Bullet.user_id == user_id,
                                Bullet.parent_id == old_parent_id,
                                Bullet.is_deleted == False,
                                Bullet.order_index > old_order,
                                Bullet.order_index <= new_order,
                            )
                        )
                        .values(order_index=Bullet.order_index - 1)
                    )
                else:
                    db.execute(
                        update(Bullet)
                        .where(
                            and_(
                                Bullet.user_id == user_id,
                                Bullet.parent_id == old_parent_id,
                                Bullet.is_deleted == False,
                                Bullet.order_index >= new_order,
                                Bullet.order_index < old_order,
                            )
                        )
                        .values(order_index=Bullet.order_index + 1)
                    )

                node.order_index = new_order
                db.flush()

                return {
                    "id": node.id,
                    "parent_id": node.parent_id,
                    "text": node.text,
                    "order_index": node.order_index,
                    "user_id": node.user_id,
                }

            # Case 2: move across parents
            if old_parent_id is not None:
                db.execute(
                    update(Bullet)
                    .where(
                        and_(
                            Bullet.user_id == user_id,
                            Bullet.parent_id == old_parent_id,
                            Bullet.is_deleted == False,
                            Bullet.order_index > old_order,
                        )
                    )
                    .values(order_index=Bullet.order_index - 1)
                )

            db.execute(
                update(Bullet)
                .where(
                    and_(
                        Bullet.user_id == user_id,
                        Bullet.parent_id == new_parent_id,
                        Bullet.is_deleted == False,
                        Bullet.order_index >= new_order,
                    )
                )
                .values(order_index=Bullet.order_index + 1)
            )

            node.parent_id = new_parent_id
            node.order_index = new_order
            db.flush()

        return {
            "id": node.id,
            "parent_id": node.parent_id,
            "text": node.text,
            "order_index": node.order_index,
            "user_id": node.user_id,
        }
    finally:
        db.close()


@app.post("/api/nodes/{node_id}/outdent")
def outdent_node(node_id: str, user_id: Optional[str] = None):
    db = SessionLocal()
    try:
        user_id = norm_user_id(user_id)

        with db.begin():
            node = db.get(Bullet, node_id)
            if node is None or node.is_deleted or node.user_id != user_id:
                raise HTTPException(status_code=404, detail="node not found")
            if node.is_root is True:
                raise HTTPException(status_code=400, detail="cannot outdent root")

            if node.parent_id is None:
                raise HTTPException(status_code=400, detail="cannot outdent root-level")

            parent = db.get(Bullet, node.parent_id)
            if parent is None or parent.is_deleted or parent.user_id != user_id:
                raise HTTPException(status_code=404, detail="parent not found")

            old_parent_id = node.parent_id
            old_order = node.order_index

            new_parent_id = parent.parent_id
            insert_order = parent.order_index + 1

            db.execute(
                update(Bullet)
                .where(
                    and_(
                        Bullet.user_id == user_id,
                        Bullet.parent_id == old_parent_id,
                        Bullet.is_deleted == False,
                        Bullet.order_index > old_order,
                    )
                )
                .values(order_index=Bullet.order_index - 1)
            )

            db.execute(
                update(Bullet)
                .where(
                    and_(
                        Bullet.user_id == user_id,
                        Bullet.parent_id == new_parent_id,
                        Bullet.is_deleted == False,
                        Bullet.order_index >= insert_order,
                    )
                )
                .values(order_index=Bullet.order_index + 1)
            )

            node.parent_id = new_parent_id
            node.order_index = insert_order
            db.flush()

        return {
            "id": node.id,
            "parent_id": node.parent_id,
            "text": node.text,
            "order_index": node.order_index,
            "user_id": node.user_id,
        }
    finally:
        db.close()


@app.post("/api/nodes/{node_id}/indent")
def indent_node(node_id: str, user_id: Optional[str] = None):
    db = SessionLocal()
    try:
        user_id = norm_user_id(user_id)

        with db.begin():
            node = db.get(Bullet, node_id)
            if node is None or node.is_deleted or node.user_id != user_id:
                raise HTTPException(status_code=404, detail="node not found")
            if node.is_root is True:
                raise HTTPException(status_code=400, detail="cannot indent root")

            if node.parent_id is None:
                raise HTTPException(status_code=400, detail="cannot indent root-level")

            prev_sibling = db.execute(
                select(Bullet)
                .where(
                    Bullet.user_id == user_id,
                    Bullet.parent_id == node.parent_id,
                    Bullet.is_deleted == False,
                    Bullet.order_index == node.order_index - 1,
                )
                .limit(1)
            ).scalar_one_or_none()

            if prev_sibling is None:
                raise HTTPException(status_code=400, detail="no previous sibling to indent under")

            old_parent_id = node.parent_id
            old_order = node.order_index
            new_parent_id = prev_sibling.id

            db.execute(
                update(Bullet)
                .where(
                    and_(
                        Bullet.user_id == user_id,
                        Bullet.parent_id == old_parent_id,
                        Bullet.is_deleted == False,
                        Bullet.order_index > old_order,
                    )
                )
                .values(order_index=Bullet.order_index - 1)
            )

            max_order = db.execute(
                select(Bullet.order_index)
                .where(
                    Bullet.user_id == user_id,
                    Bullet.parent_id == new_parent_id,
                    Bullet.is_deleted == False,
                )
                .order_by(Bullet.order_index.desc())
                .limit(1)
            ).scalar_one_or_none()

            new_order = (max_order + 1) if max_order is not None else 0

            node.parent_id = new_parent_id
            node.order_index = new_order
            db.flush()

        return {
            "id": node.id,
            "parent_id": node.parent_id,
            "text": node.text,
            "order_index": node.order_index,
            "user_id": node.user_id,
        }
    finally:
        db.close()


@app.get("/api/nodes/{root_id}/subtree")
def get_subtree(root_id: str, depth: int = 5, user_id: Optional[str] = None):
    if depth < 0:
        depth = 0
    if depth > 5:
        depth = 5

    db = SessionLocal()
    try:
        tree = build_subtree(db, norm_user_id(user_id), root_id, depth)
        if tree is None:
            raise HTTPException(status_code=404, detail="root not found")
        return tree
    finally:
        db.close()

@app.post("/api/auth/email/start")
def email_start(payload: EmailStartIn):
    email = payload.email.strip().lower()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="invalid email")

    code = gen_otp_code()
    expires_at = datetime.utcnow() + timedelta(minutes=10)

    db = SessionLocal()
    try:
        with db.begin():
            # 清理该邮箱旧的未使用验证码（可选，但建议）
            db.execute(
                delete(EmailOTP).where(
                    EmailOTP.email == email,
                    EmailOTP.consumed_at.is_(None),
                )
            )

            row = EmailOTP(
                id=gen_uuid(),
                email=email,
                code=code,
                expires_at=expires_at,
                consumed_at=None,
            )
            db.add(row)

        # 开发期：直接打印（你可以复制到前端输入）
        print(f"[Email OTP] email={email} code={code} expires_at={expires_at.isoformat()}Z")

        return {"ok": True, "expires_in": 600}
    finally:
        db.close()


@app.post("/api/auth/email/verify")
def email_verify(payload: EmailVerifyIn):
    email = payload.email.strip().lower()
    code = payload.code.strip()

    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="invalid email")
    if not code or len(code) != 6 or not code.isdigit():
        raise HTTPException(status_code=400, detail="invalid code")

    db = SessionLocal()
    try:
        with db.begin():
            otp = db.execute(
                select(EmailOTP)
                .where(
                    EmailOTP.email == email,
                    EmailOTP.code == code,
                    EmailOTP.consumed_at.is_(None),
                    EmailOTP.expires_at > datetime.utcnow(),
                )
                .order_by(EmailOTP.created_at.desc())
                .limit(1)
            ).scalar_one_or_none()

            if otp is None:
                raise HTTPException(status_code=401, detail="code incorrect or expired")

            otp.consumed_at = datetime.utcnow()
            db.flush()

            user = get_or_create_user_by_identity(db, "email", email)
            home = ensure_home(db, user.id)

        return {"user_id": user.id, "home_id": home.id}
    finally:
        db.close()

@app.post("/api/auth/wechat/qr/start")
def wechat_qr_start():
    """
    返回一个可用于展示二维码的 url + state
    前端把 qr_url 生成二维码展示即可（可以用 qrcode 库/组件）
    """
    require_wechat_config()

    db = SessionLocal()
    try:
        with db.begin():
            state = create_wechat_state(db)

        params = {
            "appid": WECHAT_APPID,
            "redirect_uri": WECHAT_REDIRECT_URI,
            "response_type": "code",
            "scope": "snsapi_login",
            "state": state,
        }
        qr_url = "https://open.weixin.qq.com/connect/qrconnect?" + urlencode(params) + "#wechat_redirect"
        return {"state": state, "qr_url": qr_url, "expires_in": 300}
    finally:
        db.close()

@app.get("/api/auth/wechat/callback")
def wechat_callback(code: str, state: str):
    """
    微信扫码成功后会 redirect 到这里，带上 code + state
    我们校验 state，然后用 code 向微信换 openid，再创建/登录用户
    """
    db = SessionLocal()
    try:
        with db.begin():
            consume_wechat_state(db, state)

            # TODO: 用 code 向微信换取 openid
            # openid = exchange_code_for_openid(code)

            # ---- 临时开发：先用 code 当 openid 跑通（不要上生产）----
            openid = f"dev_openid_{code}"

            user = get_or_create_user_by_identity(db, "wechat", openid)
            home = ensure_home(db, user.id)

        # 实际上生产环境你会 redirect 回前端并带上 token/session
        return {"user_id": user.id, "home_id": home.id, "openid": openid}
    finally:
        db.close()
