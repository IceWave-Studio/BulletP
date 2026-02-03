# database.py
import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

# 1) 默认仍然允许本地用 sqlite（方便开发）
# 2) 上线到服务器后，用环境变量 DATABASE_URL 指向 MySQL
#
# MySQL 推荐连接串（注意 charset=utf8mb4）：
# mysql+pymysql://user:password@127.0.0.1:3306/bulletp?charset=utf8mb4
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///./bulletp.db")

engine_kwargs = {
    "pool_pre_ping": True,   # 避免 MySQL 断连导致的报错
    "pool_recycle": 280,     # MySQL 常见 wait_timeout 问题（可按需调整）
}

# 仅 SQLite 需要 check_same_thread
if DATABASE_URL.startswith("sqlite"):
    engine_kwargs = {
        "connect_args": {"check_same_thread": False},
    }

engine = create_engine(DATABASE_URL, **engine_kwargs)

SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine,
)

Base = declarative_base()
