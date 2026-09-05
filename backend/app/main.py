from __future__ import annotations

import json
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, AsyncGenerator

import httpx
import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from cryptography.fernet import Fernet
from fastapi import Cookie, Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import DateTime, ForeignKey, String, Text, create_engine, select
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship, sessionmaker


class Settings(BaseSettings):
    model_config = SettingsConfigDict(extra="ignore")
    app_name: str = "Hinaa"
    database_url: str
    jwt_secret: str
    fernet_key: str
    cookie_secure: bool = True
    cookie_name: str = "hinaa_session"
    litellm_base_url: str = "http://litellm:4000"
    litellm_master_key: str
    default_rpm_limit: int = 30
    default_duration: str = "30d"


settings = Settings()
ph = PasswordHasher()
fernet = Fernet(settings.fernet_key.encode())
engine = create_engine(settings.database_url, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: secrets.token_hex(16))
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120))
    password_hash: Mapped[str] = mapped_column(Text)
    role: Mapped[str] = mapped_column(String(32), default="user")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    keys: Mapped[list["PortalKey"]] = relationship(back_populates="user", cascade="all, delete-orphan")


class PortalKey(Base):
    __tablename__ = "portal_keys"
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: secrets.token_hex(16))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    alias: Mapped[str] = mapped_column(String(120))
    token_encrypted: Mapped[str] = mapped_column(Text)
    token_suffix: Mapped[str] = mapped_column(String(8))
    models_json: Mapped[str] = mapped_column(Text, default="[]")
    rpm_limit: Mapped[int | None] = mapped_column()
    duration: Mapped[str | None] = mapped_column(String(32), nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(String(32), default="active")
    user: Mapped[User] = relationship(back_populates="keys")


Base.metadata.create_all(engine)

app = FastAPI(title="Hinaa Portal API", version="0.1.0")


def db() -> Session:
    return SessionLocal()


def jwt_encode(user: User) -> str:
    now = datetime.now(timezone.utc)
    payload = {"sub": user.id, "role": user.role, "iat": now, "exp": now + timedelta(days=7)}
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


def get_current_user(hinaa_session: str | None = Cookie(default=None)) -> User:
    if not hinaa_session:
        raise HTTPException(401, "وارد حساب کاربری نشده‌اید")
    try:
        payload = jwt.decode(hinaa_session, settings.jwt_secret, algorithms=["HS256"])
        user_id = payload.get("sub")
    except jwt.PyJWTError as exc:
        raise HTTPException(401, "نشست کاربری نامعتبر یا منقضی شده است") from exc
    with db() as session:
        user = session.get(User, user_id)
        if not user:
            raise HTTPException(401, "کاربر پیدا نشد")
        session.expunge(user)
        return user


class RegisterIn(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    email: str = Field(min_length=5, max_length=255)
    password: str = Field(min_length=8, max_length=128)


class LoginIn(BaseModel):
    email: str
    password: str


class KeyCreateIn(BaseModel):
    alias: str = Field(min_length=1, max_length=120)
    models: list[str] = Field(default_factory=lambda: ["Qwen3-32B"])
    rpm_limit: int | None = Field(default=settings.default_rpm_limit, ge=1, le=100000)
    duration: str | None = settings.default_duration
    max_budget: float | None = Field(default=None, ge=0)


class ChatIn(BaseModel):
    model: str
    messages: list[dict[str, Any]]
    temperature: float | None = Field(default=None, ge=0, le=2)
    max_tokens: int | None = Field(default=None, ge=1, le=200000)
    stream: bool = True
    enable_thinking: bool = True


async def litellm_request(method: str, path: str, *, json_body: Any = None, params: Any = None) -> httpx.Response:
    url = settings.litellm_base_url.rstrip("/") + path
    headers = {"Authorization": f"Bearer {settings.litellm_master_key}"}
    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.request(method, url, headers=headers, json=json_body, params=params)
    if response.status_code >= 400:
        raise HTTPException(response.status_code, response.text)
    return response


def parse_duration(value: str | None) -> datetime | None:
    if not value:
        return None
    units = {"s": 1, "m": 60, "h": 3600, "d": 86400}
    try:
        amount, suffix = int(value[:-1]), value[-1]
        seconds = amount * units[suffix]
    except (ValueError, KeyError):
        return None
    return datetime.now(timezone.utc) + timedelta(seconds=seconds)


@app.get("/health")
def health() -> dict[str, Any]:
    return {"status": True, "service": "hinaa-portal-api"}


@app.post("/auth/register")
def register(payload: RegisterIn, response: Response) -> dict[str, Any]:
    email = payload.email.strip().lower()
    with db() as session:
        if session.scalar(select(User).where(User.email == email)):
            raise HTTPException(409, "این ایمیل قبلاً ثبت شده است")
        user = User(email=email, name=payload.name.strip(), password_hash=ph.hash(payload.password))
        session.add(user)
        session.commit()
        session.refresh(user)
        token = jwt_encode(user)
    response.set_cookie(settings.cookie_name, token, httponly=True, secure=settings.cookie_secure, samesite="lax", max_age=7 * 86400, path="/")
    return {"user": {"id": user.id, "name": user.name, "email": user.email, "role": user.role}}


@app.post("/auth/login")
def login(payload: LoginIn, response: Response) -> dict[str, Any]:
    email = payload.email.strip().lower()
    with db() as session:
        user = session.scalar(select(User).where(User.email == email))
        if not user:
            raise HTTPException(401, "ایمیل یا رمز عبور نادرست است")
        try:
            ph.verify(user.password_hash, payload.password)
        except VerifyMismatchError as exc:
            raise HTTPException(401, "ایمیل یا رمز عبور نادرست است") from exc
        token = jwt_encode(user)
        data = {"id": user.id, "name": user.name, "email": user.email, "role": user.role}
    response.set_cookie(settings.cookie_name, token, httponly=True, secure=settings.cookie_secure, samesite="lax", max_age=7 * 86400, path="/")
    return {"user": data}


@app.post("/auth/logout")
def logout(response: Response) -> dict[str, bool]:
    response.delete_cookie(settings.cookie_name, path="/")
    return {"ok": True}


@app.get("/me")
def me(user: User = Depends(get_current_user)) -> dict[str, Any]:
    return {"id": user.id, "name": user.name, "email": user.email, "role": user.role}


@app.get("/models")
async def models(_: User = Depends(get_current_user)) -> Any:
    response = await litellm_request("GET", "/v1/models")
    payload = response.json()
    return {"data": payload.get("data", [])}


async def key_usage(token: str) -> dict[str, Any]:
    response = await litellm_request("GET", "/key/info", params={"key": token})
    return response.json().get("info", {})


def key_view(item: PortalKey, usage: dict[str, Any] | None = None) -> dict[str, Any]:
    info = usage or {}
    return {
        "id": item.id,
        "alias": item.alias,
        "masked": f"sk-••••••••{item.token_suffix}",
        "models": json.loads(item.models_json or "[]"),
        "rpm_limit": item.rpm_limit,
        "duration": item.duration,
        "expires_at": info.get("expires") or (item.expires_at.isoformat() if item.expires_at else None),
        "spend": info.get("spend", 0),
        "max_budget": info.get("max_budget"),
        "status": item.status,
        "created_at": item.created_at.isoformat(),
    }


@app.get("/api-keys")
async def list_keys(user: User = Depends(get_current_user)) -> dict[str, Any]:
    with db() as session:
        items = session.scalars(select(PortalKey).where(PortalKey.user_id == user.id).order_by(PortalKey.created_at.desc())).all()
        records = []
        for item in items:
            try:
                token = fernet.decrypt(item.token_encrypted.encode()).decode()
                usage = await key_usage(token)
            except Exception:
                usage = {}
            records.append(key_view(item, usage))
    return {"data": records}


@app.post("/api-keys")
async def create_key(payload: KeyCreateIn, user: User = Depends(get_current_user)) -> dict[str, Any]:
    models = payload.models or ["Qwen3-32B"]
    body: dict[str, Any] = {
        "key_alias": f"hinaa-user-{user.id[:8]}-{secrets.token_hex(3)}",
        "user_id": user.id,
        "models": models,
        "rpm_limit": payload.rpm_limit,
        "duration": payload.duration,
        "metadata": {"portal_alias": payload.alias, "service": "hinaa-portal"},
    }
    if payload.max_budget is not None:
        body["max_budget"] = payload.max_budget
    response = await litellm_request("POST", "/key/generate", json_body=body)
    data = response.json()
    token = data.get("key") or data.get("token")
    if not token:
        raise HTTPException(502, "LiteLLM کلید جدید برنگرداند")
    item = PortalKey(
        user_id=user.id,
        alias=payload.alias,
        token_encrypted=fernet.encrypt(token.encode()).decode(),
        token_suffix=token[-4:],
        models_json=json.dumps(models, ensure_ascii=False),
        rpm_limit=payload.rpm_limit,
        duration=payload.duration,
        expires_at=parse_duration(payload.duration),
    )
    with db() as session:
        session.add(item)
        session.commit()
        session.refresh(item)
    return {"key": token, "data": key_view(item, data)}


@app.delete("/api-keys/{key_id}")
async def delete_key(key_id: str, user: User = Depends(get_current_user)) -> dict[str, Any]:
    with db() as session:
        item = session.scalar(select(PortalKey).where(PortalKey.id == key_id, PortalKey.user_id == user.id))
        if not item:
            raise HTTPException(404, "کلید پیدا نشد")
        token = fernet.decrypt(item.token_encrypted.encode()).decode()
    await litellm_request("POST", "/key/delete", json_body={"keys": [token]})
    with db() as session:
        item = session.get(PortalKey, key_id)
        if item:
            item.status = "revoked"
            session.commit()
    return {"ok": True}


@app.post("/api-keys/{key_id}/rotate")
async def rotate_key(key_id: str, user: User = Depends(get_current_user)) -> dict[str, Any]:
    with db() as session:
        old = session.scalar(select(PortalKey).where(PortalKey.id == key_id, PortalKey.user_id == user.id))
        if not old:
            raise HTTPException(404, "کلید پیدا نشد")
        old_token = fernet.decrypt(old.token_encrypted.encode()).decode()
        models = json.loads(old.models_json or "[]") or ["Qwen3-32B"]
        body = {
            "key_alias": f"hinaa-user-{user.id[:8]}-{secrets.token_hex(3)}",
            "user_id": user.id,
            "models": models,
            "rpm_limit": old.rpm_limit,
            "duration": old.duration,
            "metadata": {"portal_alias": old.alias, "service": "hinaa-portal", "rotated_from": old.id},
        }
    response = await litellm_request("POST", "/key/generate", json_body=body)
    data = response.json()
    new_token = data.get("key") or data.get("token")
    if not new_token:
        raise HTTPException(502, "LiteLLM کلید جدید برنگرداند")
    await litellm_request("POST", "/key/delete", json_body={"keys": [old_token]})
    with db() as session:
        item = session.get(PortalKey, key_id)
        if item:
            item.token_encrypted = fernet.encrypt(new_token.encode()).decode()
            item.token_suffix = new_token[-4:]
            item.expires_at = parse_duration(item.duration)
            item.status = "active"
            session.commit()
            session.refresh(item)
            return {"key": new_token, "data": key_view(item, data)}
    raise HTTPException(500, "کلید ذخیره نشد")


@app.get("/dashboard")
async def dashboard(user: User = Depends(get_current_user)) -> dict[str, Any]:
    with db() as session:
        items = session.scalars(select(PortalKey).where(PortalKey.user_id == user.id, PortalKey.status == "active")).all()
        output = []
        total_spend = 0.0
        for item in items:
            try:
                token = fernet.decrypt(item.token_encrypted.encode()).decode()
                info = await key_usage(token)
                total_spend += float(info.get("spend") or 0)
            except Exception:
                pass
            output.append(item)
    return {"user": {"name": user.name}, "keys": len(output), "spend": total_spend, "models": sorted({m for item in output for m in json.loads(item.models_json or "[]")})}


async def proxy_stream(token: str, payload: dict[str, Any]) -> AsyncGenerator[bytes, None]:
    url = settings.litellm_base_url.rstrip("/") + "/v1/chat/completions"
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=None) as client:
        async with client.stream("POST", url, headers=headers, json=payload) as response:
            if response.status_code >= 400:
                text = await response.aread()
                raise HTTPException(response.status_code, text.decode(errors="replace"))
            async for chunk in response.aiter_bytes():
                yield chunk


@app.post("/chat/completions")
async def chat(payload: ChatIn, user: User = Depends(get_current_user)):
    with db() as session:
        item = session.scalar(
            select(PortalKey).where(PortalKey.user_id == user.id, PortalKey.status == "active").order_by(PortalKey.created_at.desc())
        )
        if not item:
            raise HTTPException(400, "ابتدا یک API Key فعال بسازید")
        models = json.loads(item.models_json or "[]")
        if payload.model not in models:
            raise HTTPException(403, "این مدل برای حساب شما فعال نیست")
        token = fernet.decrypt(item.token_encrypted.encode()).decode()
    body: dict[str, Any] = {
        "model": payload.model,
        "messages": payload.messages,
        "stream": payload.stream,
    }
    if payload.temperature is not None:
        body["temperature"] = payload.temperature
    if payload.max_tokens is not None:
        body["max_tokens"] = payload.max_tokens
    body["extra_body"] = {"chat_template_kwargs": {"enable_thinking": payload.enable_thinking}}
    return StreamingResponse(proxy_stream(token, body), media_type="text/event-stream")
