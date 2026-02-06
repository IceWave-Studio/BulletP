# backend/app/database.py
import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

ENV = os.getenv("ENV", "dev").lower()

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    if ENV == "prod":
        raise RuntimeError("ENV=prod but DATABASE_URL is not set")
    DATABASE_URL = "sqlite:///./bulletp.db"

engine_kwargs = {
    "pool_pre_ping": True,
    "pool_recycle": 280,
}

if DATABASE_URL.startswith("sqlite"):
    engine_kwargs = {"connect_args": {"check_same_thread": False}}

engine = create_engine(DATABASE_URL, **engine_kwargs)

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()
