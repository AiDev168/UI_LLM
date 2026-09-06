from __future__ import annotations

import asyncio
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
from fastapi import Cookie, Depends, FastAPI, HTTPException, Response
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, create_engine, func, select
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, relationship, sessionmaker


# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

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

engine = create_engine(
    settings.database_url,
    pool_pre_ping=True,
)

SessionLocal = sessionmaker(
    bind=engine,
    autoflush=False,
    autocommit=False,
)


# ---------------------------------------------------------------------------
# Database models
# ---------------------------------------------------------------------------

class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(
        String(64),
        primary_key=True,
        default=lambda: secrets.token_hex(16),
    )
    email: Mapped[str] = mapped_column(
        String(255),
        unique=True,
        index=True,
    )
    name: Mapped[str] = mapped_column(String(120))
    password_hash: Mapped[str] = mapped_column(Text)
    role: Mapped[str] = mapped_column(String(32), default="user")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
    )

    keys: Mapped[list["PortalKey"]] = relationship(
        back_populates="user",
        cascade="all, delete-orphan",
    )

    conversations: Mapped[list["Conversation"]] = relationship(
        back_populates="user",
        cascade="all, delete-orphan",
    )


class PortalKey(Base):
    __tablename__ = "portal_keys"

    id: Mapped[str] = mapped_column(
        String(64),
        primary_key=True,
        default=lambda: secrets.token_hex(16),
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
    )
    alias: Mapped[str] = mapped_column(String(120))
    token_encrypted: Mapped[str] = mapped_column(Text)
    token_suffix: Mapped[str] = mapped_column(String(8))
    models_json: Mapped[str] = mapped_column(Text, default="[]")
    rpm_limit: Mapped[int | None] = mapped_column(Integer, nullable=True)
    duration: Mapped[str | None] = mapped_column(String(32), nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
    )
    last_seen_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    status: Mapped[str] = mapped_column(
        String(32),
        default="active",
    )

    user: Mapped[User] = relationship(back_populates="keys")


class Conversation(Base):
    __tablename__ = "conversations"

    id: Mapped[str] = mapped_column(
        String(64),
        primary_key=True,
        default=lambda: secrets.token_hex(16),
    )
    user_id: Mapped[str] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"),
        index=True,
    )
    title: Mapped[str] = mapped_column(String(180))
    model: Mapped[str] = mapped_column(String(120))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
    )

    user: Mapped[User] = relationship(back_populates="conversations")

    messages: Mapped[list["Message"]] = relationship(
        back_populates="conversation",
        cascade="all, delete-orphan",
        order_by="Message.created_at",
    )


class Message(Base):
    __tablename__ = "messages"

    id: Mapped[str] = mapped_column(
        String(64),
        primary_key=True,
        default=lambda: secrets.token_hex(16),
    )
    conversation_id: Mapped[str] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"),
        index=True,
    )
    role: Mapped[str] = mapped_column(String(32))
    content: Mapped[str] = mapped_column(Text)

    prompt_tokens: Mapped[int | None] = mapped_column(
        Integer,
        nullable=True,
    )
    completion_tokens: Mapped[int | None] = mapped_column(
        Integer,
        nullable=True,
    )
    total_tokens: Mapped[int | None] = mapped_column(
        Integer,
        nullable=True,
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
    )

    conversation: Mapped[Conversation] = relationship(
        back_populates="messages"
    )


# IMPORTANT:
# This does not perform migrations or alter existing tables.
# It only creates missing tables in a fresh installation.

app = FastAPI(
    title="Hinaa Portal API",
    version="0.2.1",
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def db() -> Session:
    return SessionLocal()


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def jwt_encode(user: User) -> str:
    now = utcnow()

    payload = {
        "sub": user.id,
        "role": user.role,
        "iat": now,
        "exp": now + timedelta(days=7),
    }

    return jwt.encode(
        payload,
        settings.jwt_secret,
        algorithm="HS256",
    )


def get_current_user(
    hinaa_session: str | None = Cookie(default=None),
) -> User:
    if not hinaa_session:
        raise HTTPException(
            401,
            "وارد حساب کاربری نشده‌اید",
        )

    try:
        payload = jwt.decode(
            hinaa_session,
            settings.jwt_secret,
            algorithms=["HS256"],
        )
        user_id = payload.get("sub")
    except jwt.PyJWTError as exc:
        raise HTTPException(
            401,
            "نشست کاربری نامعتبر یا منقضی شده است",
        ) from exc

    if not user_id:
        raise HTTPException(
            401,
            "نشست کاربری نامعتبر است",
        )

    with db() as session:
        user = session.get(User, user_id)

        if not user:
            raise HTTPException(
                401,
                "کاربر پیدا نشد",
            )

        session.expunge(user)
        return user


def parse_duration(value: str | None) -> datetime | None:
    if not value:
        return None

    units = {
        "s": 1,
        "m": 60,
        "h": 3600,
        "d": 86400,
    }

    try:
        amount = int(value[:-1])
        suffix = value[-1]
        seconds = amount * units[suffix]
    except (ValueError, KeyError):
        return None

    return utcnow() + timedelta(seconds=seconds)


async def litellm_request(
    method: str,
    path: str,
    *,
    json_body: Any = None,
    params: Any = None,
) -> httpx.Response:
    url = settings.litellm_base_url.rstrip("/") + path

    headers = {
        "Authorization": f"Bearer {settings.litellm_master_key}",
    }

    async with httpx.AsyncClient(timeout=60) as client:
        response = await client.request(
            method,
            url,
            headers=headers,
            json=json_body,
            params=params,
        )

    if response.status_code >= 400:
        raise HTTPException(
            response.status_code,
            response.text,
        )

    return response


async def key_usage(token: str) -> dict[str, Any]:
    url = settings.litellm_base_url.rstrip("/") + "/key/info"
    headers = {
        "Authorization": f"Bearer {settings.litellm_master_key}",
    }

    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(10.0, connect=3.0)
        ) as client:
            response = await client.get(
                url,
                headers=headers,
                params={"key": token},
            )

        if response.status_code >= 400:
            return {}

        return response.json().get("info", {})
    except Exception:
        return {}


async def key_usage_many(tokens: list[str]) -> list[dict[str, Any]]:
    if not tokens:
        return []

    return await asyncio.gather(
        *(key_usage(token) for token in tokens)
    )


def key_view(
    item: PortalKey,
    usage: dict[str, Any] | None = None,
) -> dict[str, Any]:
    info = usage or {}

    return {
        "id": item.id,
        "alias": item.alias,
        "masked": f"sk-••••••••{item.token_suffix}",
        "models": json.loads(item.models_json or "[]"),
        "rpm_limit": item.rpm_limit,
        "duration": item.duration,
        "expires_at": info.get("expires")
        or (
            item.expires_at.isoformat()
            if item.expires_at
            else None
        ),
        "spend": info.get("spend", 0),
        "max_budget": info.get("max_budget"),
        "status": item.status,
        "created_at": item.created_at.isoformat(),
    }


def conversation_view(
    item: Conversation,
) -> dict[str, Any]:
    return {
        "id": item.id,
        "title": item.title,
        "model": item.model,
        "created_at": item.created_at.isoformat(),
        "updated_at": item.updated_at.isoformat(),
    }


def message_view(
    item: Message,
) -> dict[str, Any]:
    return {
        "id": item.id,
        "conversation_id": item.conversation_id,
        "role": item.role,
        "content": item.content,
        "prompt_tokens": item.prompt_tokens,
        "completion_tokens": item.completion_tokens,
        "total_tokens": item.total_tokens,
        "created_at": item.created_at.isoformat(),
    }


# ---------------------------------------------------------------------------
# Request models
# ---------------------------------------------------------------------------

class RegisterIn(BaseModel):
    name: str = Field(
        min_length=2,
        max_length=120,
    )
    email: str = Field(
        min_length=5,
        max_length=255,
    )
    password: str = Field(
        min_length=8,
        max_length=128,
    )


class LoginIn(BaseModel):
    email: str
    password: str


class KeyCreateIn(BaseModel):
    alias: str = Field(
        min_length=1,
        max_length=120,
    )
    models: list[str] = Field(
        default_factory=lambda: ["Qwen3-32B"]
    )
    rpm_limit: int | None = Field(
        default=settings.default_rpm_limit,
        ge=1,
        le=100000,
    )
    duration: str | None = settings.default_duration
    max_budget: float | None = Field(
        default=None,
        ge=0,
    )


class ChatIn(BaseModel):
    model: str
    messages: list[dict[str, Any]]
    temperature: float | None = Field(
        default=None,
        ge=0,
        le=2,
    )
    max_tokens: int | None = Field(
        default=None,
        ge=1,
        le=200000,
    )
    stream: bool = True
    enable_thinking: bool = True


class ConversationCreateIn(BaseModel):
    model: str = Field(
        min_length=1,
        max_length=120,
    )
    title: str | None = Field(
        default=None,
        max_length=180,
    )


class MessageCreateIn(BaseModel):
    role: str = Field(
        min_length=1,
        max_length=32,
    )
    content: str = Field(
        min_length=1,
    )
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    total_tokens: int | None = None


# ---------------------------------------------------------------------------
# Health / Auth
# ---------------------------------------------------------------------------

@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": True,
        "service": "hinaa-portal-api",
    }


@app.post("/auth/register")
def register(
    payload: RegisterIn,
    response: Response,
) -> dict[str, Any]:
    email = payload.email.strip().lower()

    with db() as session:
        if session.scalar(
            select(User).where(User.email == email)
        ):
            raise HTTPException(
                409,
                "این ایمیل قبلاً ثبت شده است",
            )

        user = User(
            email=email,
            name=payload.name.strip(),
            password_hash=ph.hash(payload.password),
        )

        session.add(user)
        session.commit()
        session.refresh(user)

        token = jwt_encode(user)

        data = {
            "id": user.id,
            "name": user.name,
            "email": user.email,
            "role": user.role,
        }

    response.set_cookie(
        settings.cookie_name,
        token,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        max_age=7 * 86400,
        path="/",
    )

    return {"user": data}


@app.post("/auth/login")
def login(
    payload: LoginIn,
    response: Response,
) -> dict[str, Any]:
    email = payload.email.strip().lower()

    with db() as session:
        user = session.scalar(
            select(User).where(User.email == email)
        )

        if not user:
            raise HTTPException(
                401,
                "ایمیل یا رمز عبور نادرست است",
            )

        try:
            ph.verify(
                user.password_hash,
                payload.password,
            )
        except VerifyMismatchError as exc:
            raise HTTPException(
                401,
                "ایمیل یا رمز عبور نادرست است",
            ) from exc

        token = jwt_encode(user)

        data = {
            "id": user.id,
            "name": user.name,
            "email": user.email,
            "role": user.role,
        }

    response.set_cookie(
        settings.cookie_name,
        token,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        max_age=7 * 86400,
        path="/",
    )

    return {"user": data}


@app.post("/auth/logout")
def logout(response: Response) -> dict[str, bool]:
    response.delete_cookie(
        settings.cookie_name,
        path="/",
    )

    return {"ok": True}


@app.get("/me")
def me(
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    return {
        "id": user.id,
        "name": user.name,
        "email": user.email,
        "role": user.role,
    }


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

@app.get("/models")
async def models(
    _: User = Depends(get_current_user),
) -> Any:
    response = await litellm_request(
        "GET",
        "/v1/models",
    )

    payload = response.json()

    return {
        "data": payload.get("data", []),
    }


# ---------------------------------------------------------------------------
# API Keys
# ---------------------------------------------------------------------------

@app.get("/api-keys")
def list_keys(
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    with db() as session:
        items = session.scalars(
            select(PortalKey)
            .where(PortalKey.user_id == user.id)
            .order_by(PortalKey.created_at.desc())
        ).all()

        records = [
            key_view(item)
            for item in items
        ]

    return {"data": records}


@app.post("/api-keys")
async def create_key(
    payload: KeyCreateIn,
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    models = payload.models or ["Qwen3-32B"]

    body: dict[str, Any] = {
        "key_alias": (
            f"hinaa-user-{user.id[:8]}-"
            f"{secrets.token_hex(3)}"
        ),
        "user_id": user.id,
        "models": models,
        "rpm_limit": payload.rpm_limit,
        "duration": payload.duration,
        "metadata": {
            "portal_alias": payload.alias,
            "service": "hinaa-portal",
        },
    }

    if payload.max_budget is not None:
        body["max_budget"] = payload.max_budget

    response = await litellm_request(
        "POST",
        "/key/generate",
        json_body=body,
    )

    data = response.json()

    token = data.get("key") or data.get("token")

    if not token:
        raise HTTPException(
            502,
            "LiteLLM کلید جدید برنگرداند",
        )

    item = PortalKey(
        user_id=user.id,
        alias=payload.alias,
        token_encrypted=fernet.encrypt(
            token.encode()
        ).decode(),
        token_suffix=token[-4:],
        models_json=json.dumps(
            models,
            ensure_ascii=False,
        ),
        rpm_limit=payload.rpm_limit,
        duration=payload.duration,
        expires_at=parse_duration(
            payload.duration
        ),
    )

    with db() as session:
        session.add(item)
        session.commit()
        session.refresh(item)

    return {
        "key": token,
        "data": key_view(item, data),
    }


@app.delete("/api-keys/{key_id}")
async def delete_key(
    key_id: str,
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    with db() as session:
        item = session.scalar(
            select(PortalKey).where(
                PortalKey.id == key_id,
                PortalKey.user_id == user.id,
            )
        )

        if not item:
            raise HTTPException(
                404,
                "کلید پیدا نشد",
            )

        token = fernet.decrypt(
            item.token_encrypted.encode()
        ).decode()

    await litellm_request(
        "POST",
        "/key/delete",
        json_body={"keys": [token]},
    )

    with db() as session:
        item = session.get(
            PortalKey,
            key_id,
        )

        if item:
            item.status = "revoked"
            session.commit()

    return {"ok": True}


@app.post("/api-keys/{key_id}/rotate")
async def rotate_key(
    key_id: str,
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    with db() as session:
        old = session.scalar(
            select(PortalKey).where(
                PortalKey.id == key_id,
                PortalKey.user_id == user.id,
            )
        )

        if not old:
            raise HTTPException(
                404,
                "کلید پیدا نشد",
            )

        old_token = fernet.decrypt(
            old.token_encrypted.encode()
        ).decode()

        models = (
            json.loads(old.models_json or "[]")
            or ["Qwen3-32B"]
        )

        body = {
            "key_alias": (
                f"hinaa-user-{user.id[:8]}-"
                f"{secrets.token_hex(3)}"
            ),
            "user_id": user.id,
            "models": models,
            "rpm_limit": old.rpm_limit,
            "duration": old.duration,
            "metadata": {
                "portal_alias": old.alias,
                "service": "hinaa-portal",
                "rotated_from": old.id,
            },
        }

    response = await litellm_request(
        "POST",
        "/key/generate",
        json_body=body,
    )

    data = response.json()

    new_token = (
        data.get("key")
        or data.get("token")
    )

    if not new_token:
        raise HTTPException(
            502,
            "LiteLLM کلید جدید برنگرداند",
        )

    await litellm_request(
        "POST",
        "/key/delete",
        json_body={"keys": [old_token]},
    )

    with db() as session:
        item = session.get(
            PortalKey,
            key_id,
        )

        if item:
            item.token_encrypted = (
                fernet.encrypt(
                    new_token.encode()
                ).decode()
            )
            item.token_suffix = new_token[-4:]
            item.expires_at = parse_duration(
                item.duration
            )
            item.status = "active"

            session.commit()
            session.refresh(item)

            return {
                "key": new_token,
                "data": key_view(item, data),
            }

    raise HTTPException(
        500,
        "کلید ذخیره نشد",
    )


# ---------------------------------------------------------------------------
# Dashboard
# ---------------------------------------------------------------------------

@app.get("/dashboard")
def dashboard(
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    with db() as session:
        items = session.scalars(
            select(PortalKey)
            .where(
                PortalKey.user_id == user.id,
                PortalKey.status == "active",
            )
        ).all()

    return {
        "user": {
            "name": user.name,
        },
        "keys": len(items),
        "spend": 0,
        "models": sorted(
            {
                model
                for item in items
                for model in json.loads(
                    item.models_json or "[]"
                )
            }
        ),
    }


# ---------------------------------------------------------------------------
# Conversations
# ---------------------------------------------------------------------------

@app.get("/conversations")
def list_conversations(
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    with db() as session:
        items = session.scalars(
            select(Conversation)
            .where(Conversation.user_id == user.id)
            .order_by(
                Conversation.updated_at.desc()
            )
        ).all()

        return {
            "data": [
                conversation_view(item)
                for item in items
            ]
        }


@app.post("/conversations")
def create_conversation(
    payload: ConversationCreateIn,
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    with db() as session:
        conversation = Conversation(
            user_id=user.id,
            title=(
                payload.title.strip()
                if payload.title
                and payload.title.strip()
                else "گفتگوی جدید"
            ),
            model=payload.model,
        )

        session.add(conversation)
        session.commit()
        session.refresh(conversation)

        return {
            "data": conversation_view(
                conversation
            )
        }


@app.get("/conversations/{conversation_id}")
def get_conversation(
    conversation_id: str,
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    with db() as session:
        conversation = session.scalar(
            select(Conversation).where(
                Conversation.id == conversation_id,
                Conversation.user_id == user.id,
            )
        )

        if not conversation:
            raise HTTPException(
                404,
                "گفتگو پیدا نشد",
            )

        messages = session.scalars(
            select(Message)
            .where(
                Message.conversation_id
                == conversation.id
            )
            .order_by(Message.created_at.asc())
        ).all()

        return {
            "data": {
                **conversation_view(conversation),
                "messages": [
                    message_view(message)
                    for message in messages
                ],
            }
        }


@app.delete("/conversations/{conversation_id}")
def delete_conversation(
    conversation_id: str,
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    with db() as session:
        conversation = session.scalar(
            select(Conversation).where(
                Conversation.id == conversation_id,
                Conversation.user_id == user.id,
            )
        )

        if not conversation:
            raise HTTPException(
                404,
                "گفتگو پیدا نشد",
            )

        session.delete(conversation)
        session.commit()

    return {"ok": True}


@app.post("/conversations/{conversation_id}/messages")
def create_message(
    conversation_id: str,
    payload: MessageCreateIn,
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    allowed_roles = {
        "user",
        "assistant",
        "system",
    }

    if payload.role not in allowed_roles:
        raise HTTPException(
            400,
            "نقش پیام نامعتبر است",
        )

    with db() as session:
        conversation = session.scalar(
            select(Conversation).where(
                Conversation.id == conversation_id,
                Conversation.user_id == user.id,
            )
        )

        if not conversation:
            raise HTTPException(
                404,
                "گفتگو پیدا نشد",
            )

        message = Message(
            conversation_id=conversation.id,
            role=payload.role,
            content=payload.content,
            prompt_tokens=payload.prompt_tokens,
            completion_tokens=payload.completion_tokens,
            total_tokens=payload.total_tokens,
        )

        conversation.updated_at = utcnow()

        # Give an empty/new conversation a useful title
        # based on its first user message.
        if (
            payload.role == "user"
            and (
                not conversation.title
                or conversation.title
                == "گفتگوی جدید"
            )
        ):
            title = " ".join(
                payload.content.strip().split()
            )

            if len(title) > 180:
                title = title[:177] + "..."

            if title:
                conversation.title = title

        session.add(message)
        session.commit()
        session.refresh(message)
        session.refresh(conversation)

        return {
            "data": {
                "message": message_view(message),
                "conversation": conversation_view(
                    conversation
                ),
            }
        }


# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------

@app.get("/usage")
async def usage(
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    with db() as session:
        keys = session.scalars(
            select(PortalKey)
            .where(PortalKey.user_id == user.id)
            .order_by(PortalKey.created_at.desc())
        ).all()

        message_count = session.scalar(
            select(func.count(Message.id))
            .join(
                Conversation,
                Message.conversation_id == Conversation.id,
            )
            .where(Conversation.user_id == user.id)
        ) or 0

        key_data: list[tuple[PortalKey, str | None]] = []

        for item in keys:
            try:
                token = fernet.decrypt(
                    item.token_encrypted.encode()
                ).decode()
            except Exception:
                token = None

            key_data.append((item, token))

    valid_pairs = [
        (item, token)
        for item, token in key_data
        if token
    ]

    infos = await key_usage_many(
        [token for _, token in valid_pairs]
    )

    info_by_id = {
        item.id: info
        for (item, _), info in zip(valid_pairs, infos)
    }

    key_records = []
    total_spend = 0.0

    for item, _ in key_data:
        info = info_by_id.get(item.id, {})
        spend = float(info.get("spend") or 0)

        total_spend += spend

        key_records.append({
            "id": item.id,
            "alias": item.alias,
            "spend": spend,
            "status": item.status,
        })

    return {
        "total_spend": total_spend,
        "spend": total_spend,
        "messages": int(message_count),
        "keys": key_records,
    }


# ---------------------------------------------------------------------------
# Chat proxy
# ---------------------------------------------------------------------------

async def proxy_stream(
    token: str,
    payload: dict[str, Any],
) -> AsyncGenerator[bytes, None]:
    url = (
        settings.litellm_base_url.rstrip("/")
        + "/v1/chat/completions"
    )

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }

    async with httpx.AsyncClient(
        timeout=None
    ) as client:
        async with client.stream(
            "POST",
            url,
            headers=headers,
            json=payload,
        ) as response:
            if response.status_code >= 400:
                text = await response.aread()

                raise HTTPException(
                    response.status_code,
                    text.decode(
                        errors="replace"
                    ),
                )

            async for chunk in response.aiter_bytes():
                yield chunk


@app.post("/chat/completions")
async def chat(
    payload: ChatIn,
    user: User = Depends(get_current_user),
):
    with db() as session:
        item = session.scalar(
            select(PortalKey)
            .where(
                PortalKey.user_id == user.id,
                PortalKey.status == "active",
            )
            .order_by(
                PortalKey.created_at.desc()
            )
        )

        if not item:
            raise HTTPException(
                400,
                "ابتدا یک API Key فعال بسازید",
            )

        models = json.loads(
            item.models_json or "[]"
        )

        if payload.model not in models:
            raise HTTPException(
                403,
                "این مدل برای حساب شما فعال نیست",
            )

        token = fernet.decrypt(
            item.token_encrypted.encode()
        ).decode()

    body: dict[str, Any] = {
        "model": payload.model,
        "messages": payload.messages,
        "stream": payload.stream,
    }

    if payload.temperature is not None:
        body["temperature"] = payload.temperature

    if payload.max_tokens is not None:
        body["max_tokens"] = payload.max_tokens

    body["extra_body"] = {
        "chat_template_kwargs": {
            "enable_thinking": payload.enable_thinking,
        }
    }

    return StreamingResponse(
        proxy_stream(token, body),
        media_type="text/event-stream",
    )
