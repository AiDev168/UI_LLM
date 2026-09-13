from __future__ import annotations

import asyncio
import base64
import json
import mimetypes
import os
from pathlib import Path
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any, AsyncGenerator

import fitz
import httpx
import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from cryptography.fernet import Fernet
from fastapi import Cookie, Depends, FastAPI, File, HTTPException, Response, UploadFile, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, create_engine, func, select
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
    status: Mapped[str] = mapped_column(
        String(32),
        default="active",
    )
    chat_enabled: Mapped[bool] = mapped_column(
        Boolean,
        default=True,
    )
    api_enabled: Mapped[bool] = mapped_column(
        Boolean,
        default=True,
    )
    mlops_enabled: Mapped[bool] = mapped_column(
        Boolean,
        default=False,
    )
    must_change_password: Mapped[bool] = mapped_column(
        Boolean,
        default=False,
    )
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


class ChangePasswordIn(BaseModel):
    current_password: str = Field(
        min_length=1,
        max_length=128,
    )
    new_password: str = Field(
        min_length=8,
        max_length=128,
    )


class AdminCreateUserIn(BaseModel):
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
    chat_enabled: bool = True
    api_enabled: bool = True
    mlops_enabled: bool = False


class AdminUserUpdateIn(BaseModel):
    status: str | None = None
    chat_enabled: bool | None = None
    api_enabled: bool | None = None
    mlops_enabled: bool | None = None
    role: str | None = None


class KeyCreateIn(BaseModel):
    alias: str = Field(
        min_length=1,
        max_length=120,
    )
    models: list[str] = Field(
        default_factory=lambda: ["Qwen3-VL-30B-A3B-Instruct"]
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
    budget_duration: str | None = "30d"


class BudgetUpdateIn(BaseModel):
    max_budget: float = Field(gt=0)
    budget_duration: str = Field(min_length=2, max_length=16)


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
def register(payload: RegisterIn) -> dict[str, Any]:
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
            role="user",
            status="pending",
            chat_enabled=False,
            api_enabled=False,
            mlops_enabled=False,
            must_change_password=False,
        )

        session.add(user)
        session.commit()
        session.refresh(user)

        return {
            "user": {
                "id": user.id,
                "name": user.name,
                "email": user.email,
                "role": user.role,
                "status": user.status,
            },
            "pending": True,
            "message": "درخواست ثبت‌نام شما ثبت شد و پس از تأیید مدیر فعال خواهد شد.",
        }


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

        if user.status == "pending":
            raise HTTPException(
                403,
                "حساب کاربری شما هنوز توسط مدیر تأیید نشده است",
            )

        if user.status in {"disabled", "rejected"}:
            raise HTTPException(
                403,
                "دسترسی این حساب غیرفعال است",
            )

        if user.status != "active":
            raise HTTPException(
                403,
                "وضعیت حساب کاربری معتبر نیست",
            )

        token = jwt_encode(user)

        data = {
            "id": user.id,
            "name": user.name,
            "email": user.email,
            "role": user.role,
            "status": user.status,
            "chat_enabled": user.chat_enabled,
            "api_enabled": user.api_enabled,
            "mlops_enabled": user.mlops_enabled,
            "must_change_password": user.must_change_password,
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

    return {
        "user": data,
        "must_change_password": user.must_change_password,
    }


def require_admin(
    user: User = Depends(get_current_user),
) -> User:
    if user.role != "admin":
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "دسترسی مدیر لازم است",
        )
    return user


def require_permission(permission: str):
    def dependency(
        user: User = Depends(get_current_user),
    ) -> User:
        if user.role == "admin":
            return user

        if user.must_change_password:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "ابتدا باید رمز عبور خود را تغییر دهید",
            )

        allowed = {
            "chat": user.chat_enabled,
            "api": user.api_enabled,
            "mlops": user.mlops_enabled,
        }

        if not allowed.get(permission, False):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                "دسترسی این سرویس برای حساب شما فعال نیست",
            )

        return user

    return dependency


MULTIMODAL_MAX_IMAGE = 20 * 1024 * 1024
MULTIMODAL_MAX_VIDEO = 50 * 1024 * 1024
MULTIMODAL_MAX_PDF = 25 * 1024 * 1024
MULTIMODAL_MAX_TEXT = 5 * 1024 * 1024
MULTIMODAL_MAX_PDF_PAGES = 8


def _data_url(data: bytes, mime: str) -> str:
    encoded = base64.b64encode(data).decode("ascii")
    return f"data:{mime};base64,{encoded}"


@app.post(
    "/files/prepare",
    dependencies=[Depends(require_permission("chat"))],
)
async def prepare_file(
    file: UploadFile = File(...),
) -> dict[str, Any]:
    filename = file.filename or "file"
    lower = filename.lower()
    mime = (
        file.content_type
        or mimetypes.guess_type(filename)[0]
        or "application/octet-stream"
    )

    data = await file.read()
    size = len(data)

    if mime.startswith("image/"):
        if size > MULTIMODAL_MAX_IMAGE:
            raise HTTPException(
                status_code=413,
                detail="حجم تصویر نباید بیشتر از ۲۰ مگابایت باشد.",
            )

        return {
            "filename": filename,
            "mime": mime,
            "parts": [
                {
                    "type": "image_url",
                    "image_url": {
                        "url": _data_url(data, mime)
                    },
                }
            ],
        }

    if mime.startswith("video/"):
        if size > MULTIMODAL_MAX_VIDEO:
            raise HTTPException(
                status_code=413,
                detail="حجم ویدئو نباید بیشتر از ۵۰ مگابایت باشد.",
            )

        return {
            "filename": filename,
            "mime": mime,
            "parts": [
                {
                    "type": "video_url",
                    "video_url": {
                        "url": _data_url(data, mime)
                    },
                }
            ],
        }

    if mime == "application/pdf" or lower.endswith(".pdf"):
        if size > MULTIMODAL_MAX_PDF:
            raise HTTPException(
                status_code=413,
                detail="حجم PDF نباید بیشتر از ۲۵ مگابایت باشد.",
            )

        document = None

        try:
            document = fitz.open(stream=data, filetype="pdf")
            total_pages = len(document)

            parts: list[dict[str, Any]] = [
                {
                    "type": "text",
                    "text": (
                        f"فایل PDF با نام «{filename}» پیوست شده است. "
                        f"صفحات و متن استخراج‌شده را بررسی کن."
                    ),
                }
            ]

            pages_to_process = min(
                total_pages,
                MULTIMODAL_MAX_PDF_PAGES,
            )

            for index in range(pages_to_process):
                page = document.load_page(index)

                text = page.get_text("text").strip()
                if text:
                    parts.append(
                        {
                            "type": "text",
                            "text": (
                                f"--- متن صفحه {index + 1} ---\n"
                                f"{text[:120000]}"
                            ),
                        }
                    )

                # vLLM is configured with --limit-mm-per-prompt.image 1.
                # Keep at most one rendered PDF page as an image; send the
                # remaining pages as extracted text only.
                if index == 0:
                    pix = page.get_pixmap(
                        matrix=fitz.Matrix(1.5, 1.5),
                        alpha=False,
                    )

                    parts.append(
                        {
                            "type": "image_url",
                            "image_url": {
                                "url": _data_url(
                                    pix.tobytes("png"),
                                    "image/png",
                                )
                            },
                        }
                    )

            if total_pages > MULTIMODAL_MAX_PDF_PAGES:
                parts.append(
                    {
                        "type": "text",
                        "text": (
                            f"فقط {MULTIMODAL_MAX_PDF_PAGES} صفحه اول "
                            f"از {total_pages} صفحه ارسال شده است."
                        ),
                    }
                )

            return {
                "filename": filename,
                "mime": "application/pdf",
                "parts": parts,
            }

        except Exception as exc:
            raise HTTPException(
                status_code=415,
                detail=f"خواندن PDF ناموفق بود: {exc}",
            ) from exc

        finally:
            if document is not None:
                document.close()

    text_extensions = {
        ".txt", ".md", ".markdown", ".json", ".csv", ".tsv",
        ".log", ".py", ".js", ".jsx", ".ts", ".tsx",
        ".html", ".css", ".scss", ".xml", ".yaml", ".yml",
        ".ini", ".conf", ".sh", ".bash", ".sql", ".toml", ".env",
    }

    if mime.startswith("text/") or Path(lower).suffix in text_extensions:
        if size > MULTIMODAL_MAX_TEXT:
            raise HTTPException(
                status_code=413,
                detail="حجم فایل متنی نباید بیشتر از ۵ مگابایت باشد.",
            )

        text = data.decode("utf-8", errors="replace")

        return {
            "filename": filename,
            "mime": mime,
            "parts": [
                {
                    "type": "text",
                    "text": (
                        f"فایل متنی «{filename}» پیوست شده است.\n\n"
                        f"--- BEGIN FILE ---\n{text}\n--- END FILE ---"
                    ),
                }
            ],
        }

    raise HTTPException(
        status_code=415,
        detail="فرمت‌های مجاز: تصویر، ویدئو، PDF و فایل‌های متنی/کد.",
    )



def require_not_forced_change(
    user: User = Depends(get_current_user),
) -> User:
    if user.role != "admin" and user.must_change_password:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "ابتدا باید رمز عبور خود را تغییر دهید",
        )
    return user


@app.patch("/auth/profile")
def update_profile(
    payload: dict[str, Any],
    current_user: User = Depends(require_not_forced_change),
) -> dict[str, Any]:
    name = str(payload.get("name") or "").strip()

    if len(name) < 2:
        raise HTTPException(400, "نام باید حداقل ۲ کاراکتر باشد")

    if len(name) > 120:
        raise HTTPException(400, "نام بیش از حد طولانی است")

    with db() as session:
        user = session.get(User, current_user.id)

        if not user:
            raise HTTPException(401, "کاربر پیدا نشد")

        user.name = name
        session.commit()
        session.refresh(user)

        return {
            "ok": True,
            "message": "پروفایل با موفقیت به‌روزرسانی شد",
            "user": {
                "id": user.id,
                "name": user.name,
                "email": user.email,
                "role": user.role,
                "status": user.status,
            },
        }


@app.post("/auth/change-password")
def change_password(
    payload: ChangePasswordIn,
    current_user: User = Depends(get_current_user),
) -> dict[str, Any]:
    with db() as session:
        user = session.get(User, current_user.id)

        if not user:
            raise HTTPException(401, "کاربر پیدا نشد")

        try:
            ph.verify(
                user.password_hash,
                payload.current_password,
            )
        except VerifyMismatchError as exc:
            raise HTTPException(
                400,
                "رمز عبور فعلی نادرست است",
            ) from exc

        user.password_hash = ph.hash(payload.new_password)
        user.must_change_password = False
        session.commit()

        return {
            "ok": True,
            "message": "رمز عبور با موفقیت تغییر کرد",
        }


@app.get("/admin/users")
def admin_list_users(
    _admin: User = Depends(require_admin),
) -> dict[str, Any]:
    with db() as session:
        users = session.scalars(
            select(User).order_by(User.created_at.desc())
        ).all()

        return {
            "data": [
                {
                    "id": user.id,
                    "name": user.name,
                    "email": user.email,
                    "role": user.role,
                    "status": user.status,
                    "chat_enabled": user.chat_enabled,
                    "api_enabled": user.api_enabled,
                    "mlops_enabled": user.mlops_enabled,
                    "must_change_password": user.must_change_password,
                    "created_at": user.created_at,
                }
                for user in users
            ]
        }


@app.post("/admin/users")
def admin_create_user(
    payload: AdminCreateUserIn,
    _admin: User = Depends(require_admin),
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
            role="user",
            status="active",
            chat_enabled=payload.chat_enabled,
            api_enabled=payload.api_enabled,
            mlops_enabled=payload.mlops_enabled,
            must_change_password=True,
        )

        session.add(user)
        session.commit()
        session.refresh(user)

        return {
            "user": {
                "id": user.id,
                "name": user.name,
                "email": user.email,
                "role": user.role,
                "status": user.status,
                "chat_enabled": user.chat_enabled,
                "api_enabled": user.api_enabled,
                "mlops_enabled": user.mlops_enabled,
                "must_change_password": user.must_change_password,
            }
        }


@app.patch("/admin/users/{user_id}")
def admin_update_user(
    user_id: str,
    payload: AdminUserUpdateIn,
    _admin: User = Depends(require_admin),
) -> dict[str, Any]:
    allowed_statuses = {"pending", "active", "disabled", "rejected"}
    allowed_roles = {"user", "admin"}

    updates = payload.model_dump(exclude_unset=True)

    if "status" in updates and updates["status"] not in allowed_statuses:
        raise HTTPException(400, "وضعیت کاربر نامعتبر است")

    if "role" in updates and updates["role"] not in allowed_roles:
        raise HTTPException(400, "نقش کاربر نامعتبر است")

    with db() as session:
        user = session.get(User, user_id)

        if not user:
            raise HTTPException(404, "کاربر پیدا نشد")

        for key, value in updates.items():
            setattr(user, key, value)

        session.commit()
        session.refresh(user)

        return {
            "user": {
                "id": user.id,
                "name": user.name,
                "email": user.email,
                "role": user.role,
                "status": user.status,
                "chat_enabled": user.chat_enabled,
                "api_enabled": user.api_enabled,
                "mlops_enabled": user.mlops_enabled,
                "must_change_password": user.must_change_password,
            }
        }


@app.get("/admin/users/{user_id}/api-keys")
async def admin_list_user_keys(
    user_id: str,
    _admin: User = Depends(require_admin),
) -> dict[str, Any]:
    with db() as session:
        target = session.get(User, user_id)
        if not target:
            raise HTTPException(404, "کاربر پیدا نشد")
        items = session.scalars(
            select(PortalKey)
            .where(PortalKey.user_id == user_id)
            .order_by(PortalKey.created_at.desc())
        ).all()
    pairs = []
    for item in items:
        try:
            token = fernet.decrypt(item.token_encrypted.encode()).decode()
        except Exception:
            token = None
        pairs.append((item, token))
    valid = [(item, token) for item, token in pairs if token]
    infos = await key_usage_many([token for _, token in valid])
    info_by_id = {item.id: info for (item, _), info in zip(valid, infos)}
    return {"data": [key_view(item, info_by_id.get(item.id, {})) for item, _ in pairs]}


@app.post("/admin/api-keys/{key_id}/budget")
async def admin_update_key_budget(
    key_id: str,
    payload: BudgetUpdateIn,
    _admin: User = Depends(require_admin),
) -> dict[str, Any]:
    with db() as session:
        item = session.get(PortalKey, key_id)
        if not item:
            raise HTTPException(404, "کلید پیدا نشد")
        try:
            token = fernet.decrypt(item.token_encrypted.encode()).decode()
        except Exception as exc:
            raise HTTPException(500, "رمز کلید قابل بازیابی نیست") from exc

    info = await key_usage(token)
    current_windows = info.get("budget_limits")
    window = {
        "max_budget": payload.max_budget,
        "budget_duration": payload.budget_duration,
    }
    if isinstance(current_windows, list) and current_windows:
        # Preserve existing windows. Update the matching duration when possible;
        # otherwise update the first window and keep its reset point.
        windows = []
        matched = False
        for existing in current_windows:
            if not isinstance(existing, dict):
                continue
            current = dict(existing)
            if current.get("budget_duration") == payload.budget_duration and not matched:
                current.update(window)
                if existing.get("reset_at"):
                    current["reset_at"] = existing["reset_at"]
                matched = True
            windows.append(current)
        if not matched and windows:
            current = dict(windows[0])
            current.update(window)
            if windows[0].get("reset_at"):
                current["reset_at"] = windows[0]["reset_at"]
            windows[0] = current
        elif not windows:
            windows = [window]
        body = {
            "key": token,
            "max_budget": payload.max_budget,
            "budget_duration": payload.budget_duration,
            "budget_limits": windows,
        }
    else:
        body = {
            "key": token,
            "max_budget": payload.max_budget,
            "budget_duration": payload.budget_duration,
        }

    await litellm_request("POST", "/key/update", json_body=body)
    updated = await key_usage(token)
    with db() as session:
        item = session.get(PortalKey, key_id)
    return {"data": key_view(item, updated)}


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
        "status": user.status,
        "chat_enabled": user.chat_enabled,
        "api_enabled": user.api_enabled,
        "mlops_enabled": user.mlops_enabled,
        "must_change_password": user.must_change_password,
    }


@app.get("/mlops/access")
def mlops_access(
    user: User = Depends(require_permission("mlops")),
) -> dict[str, str]:
    return {
        "url": "https://app.hinaa.ir",
        "service": "clearml",
    }


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

@app.get("/models", dependencies=[Depends(require_permission("chat"))])
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

@app.get("/api-keys", dependencies=[Depends(require_permission("api"))])
async def list_keys(
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    with db() as session:
        items = session.scalars(
            select(PortalKey)
            .where(PortalKey.user_id == user.id)
            .order_by(PortalKey.created_at.desc())
        ).all()
        pairs = []
        for item in items:
            try:
                token = fernet.decrypt(item.token_encrypted.encode()).decode()
            except Exception:
                token = None
            pairs.append((item, token))

    valid = [(item, token) for item, token in pairs if token]
    infos = await key_usage_many([token for _, token in valid])
    info_by_id = {item.id: info for (item, _), info in zip(valid, infos)}
    records = [key_view(item, info_by_id.get(item.id, {})) for item, _ in pairs]
    return {"data": records}


@app.post("/api-keys", dependencies=[Depends(require_permission("api"))])
async def create_key(
    payload: KeyCreateIn,
    user: User = Depends(get_current_user),
) -> dict[str, Any]:
    models = payload.models or ["Qwen3-VL-30B-A3B-Instruct"]

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
        if payload.budget_duration:
            body["budget_duration"] = payload.budget_duration

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


@app.delete("/api-keys/{key_id}", dependencies=[Depends(require_permission("api"))])
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


@app.post("/api-keys/{key_id}/rotate", dependencies=[Depends(require_permission("api"))])
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
            or ["Qwen3-VL-30B-A3B-Instruct"]
        )

        try:
            old_info = await key_usage(old_token)
        except Exception:
            old_info = {}
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
        if old_info.get("max_budget") is not None:
            body["max_budget"] = old_info.get("max_budget")
            if old_info.get("budget_duration"):
                body["budget_duration"] = old_info.get("budget_duration")

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

@app.get("/conversations", dependencies=[Depends(require_permission("chat"))])
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


@app.post("/conversations", dependencies=[Depends(require_permission("chat"))])
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


@app.get("/conversations/{conversation_id}", dependencies=[Depends(require_permission("chat"))])
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


@app.delete("/conversations/{conversation_id}", dependencies=[Depends(require_permission("chat"))])
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


@app.post("/conversations/{conversation_id}/messages", dependencies=[Depends(require_permission("chat"))])
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

        max_budget = info.get("max_budget")
        try:
            remaining = max(0.0, float(max_budget) - spend) if max_budget is not None else None
        except (TypeError, ValueError):
            remaining = None
        key_records.append({
            "id": item.id,
            "alias": item.alias,
            "spend": spend,
            "max_budget": max_budget,
            "remaining_budget": remaining,
            "budget_duration": info.get("budget_duration"),
            "budget_reset_at": info.get("budget_reset_at"),
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


@app.post("/chat/completions", dependencies=[Depends(require_permission("chat"))])
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
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
