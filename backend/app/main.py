import os
from datetime import datetime, timedelta
from typing import Optional
from urllib.parse import urlencode

from fastapi import FastAPI, HTTPException, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from sqlalchemy import select, update, and_
from sqlalchemy.orm import Session

from .database import Base, engine, SessionLocal
from .models import (
    User,
    Identity,
    Bullet,
    EmailOTP,
    WeChatLoginState,
    gen_uuid,
)
from .emailer import send_verification_email
from .otp import gen_code, hash_code, verify_code


# =============================
# App init
# =============================
app = FastAPI(title="BulletP Backend")

# =============================
# CORS
# =============================
cors = os.getenv("CORS_ORIGINS", "")
allow_origins = [x.strip() for x in cors.split(",") if x.strip()] or [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ✅ 只在开发环境自动建表；生产环境请用 Alembic
ENV = os.getenv("ENV", "dev").lower()
if ENV != "prod":
    Base.metadata.create_all(bind=engine)

DEFAULT_USER = "default"
HOME_TEXT = "Home"

OTP_EXPIRE_SECONDS = int(os.getenv("OTP_EXPIRE_SECONDS", "600"))
OTP_COOLDOWN_SECONDS = int(os.getenv("OTP_COOLDOWN_SECONDS", "60"))
OTP_IP_LIMIT_PER_HOUR = int(os.getenv("OTP_IP_LIMIT_PER_HOUR", "20"))

WECHAT_APPID = os.getenv("WECHAT_APPID", "")
WECHAT_SECRET = os.getenv("WECHAT_SECRET", "")
WECHAT_REDIRECT_URI = os.getenv("WECHAT_REDIRECT_URI", "")


# =============================
# Schemas
# =============================
class EmailStartIn(BaseModel):
    email: str


class EmailVerifyIn(BaseModel):
    email: str
    code: str


class CreateNodeIn(BaseModel):
    parent_id: Optional[str] = None
    text: str = ""
    # ✅ 根治：插入到某个同级节点之后（同 parent_id）
    after_id: Optional[str] = None


class UpdateNodeIn(BaseModel):
    text: str


class MoveNodeIn(BaseModel):
    new_parent_id: str
    new_order_index: int


class BootstrapReq(BaseModel):
    provider: str   # "email" / "wechat"
    subject: str    # email/openid/unionid


# =============================
# Helpers
# =============================
def get_client_ip(request: Request) -> str:
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    if request.client:
        return request.client.host
    return "unknown"


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


def _max_order(db: Session, user_id: str, parent_id: Optional[str]) -> int:
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
    return int(max_order) if max_order is not None else -1


def _shift_siblings_right(db: Session, user_id: str, parent_id: str, start_from: int):
    """
    ✅ 根治：为插入腾位置
    把同一 parent 下 order_index >= start_from 的兄弟节点全部 +1
    """
    db.execute(
        update(Bullet)
        .where(
            Bullet.user_id == user_id,
            Bullet.parent_id == parent_id,
            Bullet.is_deleted == False,
            Bullet.order_index >= start_from,
        )
        .values(order_index=Bullet.order_index + 1)
    )


# =============================
# WeChat helpers
# =============================
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


# =============================
# Routes
# =============================
@app.get("/")
def root():
    return {"name": "BulletP Backend", "status": "running", "docs": "/docs"}


# -----------------------------
# Auth - Email OTP (ONLY ONE VERSION)
# -----------------------------
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

            code = gen_code()
            row = EmailOTP(
                id=gen_uuid(),
                email=email,
                code=None,
                code_hash=hash_code(code),
                ip=ip,
                expires_at=now + timedelta(seconds=OTP_EXPIRE_SECONDS),
                consumed_at=None,
            )
            db.add(row)

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

            ok = False
            if row.code_hash:
                ok = verify_code(code, row.code_hash)
            elif row.code:
                ok = (code == row.code)

            if not ok:
                raise HTTPException(status_code=400, detail="invalid code")

            row.consumed_at = now

            user = get_or_create_user_by_identity(db, "email", email)
            home = ensure_home(db, user.id)

        return {"ok": True, "user_id": user.id, "home_id": home.id}
    finally:
        db.close()


@app.post("/api/dev/bootstrap")
def dev_bootstrap(payload: BootstrapReq):
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


# -----------------------------
# Nodes CRUD
# -----------------------------
@app.post("/api/nodes")
def create_node(payload: CreateNodeIn, user_id: Optional[str] = None):
    """
    ✅ 根治：支持 after_id
    - parent_id 为空：默认插到 Home 下
    - after_id 不为空：插到 after 节点之后（必须同一 parent）
    - 否则：追加到末尾
    """
    db = SessionLocal()
    try:
        user_id = norm_user_id(user_id)
        parent_id = payload.parent_id
        after_id = payload.after_id

        with db.begin():
            # parent_id None => Home 下
            if parent_id is None:
                home = ensure_home(db, user_id)
                parent_id = home.id

            parent = db.get(Bullet, parent_id)
            if parent is None or parent.is_deleted or parent.user_id != user_id:
                raise HTTPException(status_code=404, detail="parent not found")

            # ✅ 核心：计算插入位置
            if after_id:
                after = db.get(Bullet, after_id)
                if after is None or after.is_deleted or after.user_id != user_id:
                    raise HTTPException(status_code=404, detail="after not found")
                if after.parent_id != parent_id:
                    raise HTTPException(status_code=400, detail="after_id parent mismatch")

                insert_index = int(after.order_index) + 1
                _shift_siblings_right(db, user_id, parent_id, insert_index)
                order_index = insert_index
            else:
                order_index = _max_order(db, user_id, parent_id) + 1

            node = Bullet(
                id=gen_uuid(),
                user_id=user_id,
                parent_id=parent_id,
                text=payload.text,
                order_index=order_index,
                is_root=None,
                is_deleted=False,
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
    """
    ✅ 根治：幂等删除
    - 节点不存在 / 已删除 / 不属于该 user：直接 ok（防止并发/重复触发导致 404 + 白屏）
    - root 仍然禁止删除
    """
    db = SessionLocal()
    try:
        user_id = norm_user_id(user_id)

        with db.begin():
            node = db.get(Bullet, node_id)

            # ✅ 幂等：不存在也当成功
            if node is None:
                return {"ok": True}
            if node.user_id != user_id:
                return {"ok": True}
            if node.is_deleted:
                return {"ok": True}

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

            new_order = max(0, min(new_order, n))

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
                raise HTTPException(status_code=400, detail="cannot indent top-level")

            old_parent_id = node.parent_id
            old_order = node.order_index

            # ✅ FIX: nearest previous sibling (order_index < old_order)
            prev_sibling = db.execute(
                select(Bullet)
                .where(
                    Bullet.user_id == user_id,
                    Bullet.parent_id == old_parent_id,
                    Bullet.is_deleted == False,
                    Bullet.order_index < old_order,
                )
                .order_by(Bullet.order_index.desc())
                .limit(1)
            ).scalar_one_or_none()

            if prev_sibling is None:
                raise HTTPException(status_code=400, detail="no previous sibling to indent under")

            new_parent_id = prev_sibling.id

            # close gap in old parent
            db.execute(
                update(Bullet)
                .where(
                    Bullet.user_id == user_id,
                    Bullet.parent_id == old_parent_id,
                    Bullet.is_deleted == False,
                    Bullet.order_index > old_order,
                )
                .values(order_index=Bullet.order_index - 1)
            )

            # append to new parent
            node.parent_id = new_parent_id
            node.order_index = _max_order(db, user_id, new_parent_id) + 1
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
                raise HTTPException(status_code=400, detail="cannot outdent top-level")

            parent = db.get(Bullet, node.parent_id)
            if parent is None or parent.is_deleted or parent.user_id != user_id:
                raise HTTPException(status_code=404, detail="parent not found")

            # ✅ FIX: cannot outdent beyond Home
            if parent.is_root is True:
                raise HTTPException(status_code=400, detail="cannot outdent beyond Home")

            grand_parent_id = parent.parent_id
            if grand_parent_id is None:
                raise HTTPException(status_code=400, detail="invalid tree state")

            old_parent_id = node.parent_id
            old_order = node.order_index

            insert_order = parent.order_index + 1

            # close gap in old parent
            db.execute(
                update(Bullet)
                .where(
                    Bullet.user_id == user_id,
                    Bullet.parent_id == old_parent_id,
                    Bullet.is_deleted == False,
                    Bullet.order_index > old_order,
                )
                .values(order_index=Bullet.order_index - 1)
            )

            # make space in grand parent
            db.execute(
                update(Bullet)
                .where(
                    Bullet.user_id == user_id,
                    Bullet.parent_id == grand_parent_id,
                    Bullet.is_deleted == False,
                    Bullet.order_index >= insert_order,
                )
                .values(order_index=Bullet.order_index + 1)
            )

            node.parent_id = grand_parent_id
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


@app.get("/api/nodes/{root_id}/subtree")
def get_subtree(root_id: str, depth: int = 5, user_id: Optional[str] = None):
    depth = max(0, min(depth, 5))
    db = SessionLocal()
    try:
        tree = build_subtree(db, norm_user_id(user_id), root_id, depth)
        if tree is None:
            raise HTTPException(status_code=404, detail="root not found")
        return tree
    finally:
        db.close()


# -----------------------------
# WeChat
# -----------------------------
@app.post("/api/auth/wechat/qr/start")
def wechat_qr_start():
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
    db = SessionLocal()
    try:
        with db.begin():
            consume_wechat_state(db, state)

            # TODO: 用 code 向微信换取 openid（生产必须真实换）
            openid = f"dev_openid_{code}"

            user = get_or_create_user_by_identity(db, "wechat", openid)
            home = ensure_home(db, user.id)

        return {"user_id": user.id, "home_id": home.id, "openid": openid}
    finally:
        db.close()
