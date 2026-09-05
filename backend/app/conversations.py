from __future__ import annotations

from datetime import datetime, timezone
from typing import Any
import secrets

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, func, select
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.main import Base, User, db, get_current_user

router = APIRouter()


class Conversation(Base):
    __tablename__ = "conversations"
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: secrets.token_hex(16))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    title: Mapped[str] = mapped_column(String(200), default="گفتگوی جدید")
    model: Mapped[str] = mapped_column(String(120))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    messages: Mapped[list["ConversationMessage"]] = relationship(back_populates="conversation", cascade="all, delete-orphan", order_by="ConversationMessage.created_at")


class ConversationMessage(Base):
    __tablename__ = "conversation_messages"
    id: Mapped[str] = mapped_column(String(64), primary_key=True, default=lambda: secrets.token_hex(16))
    conversation_id: Mapped[str] = mapped_column(ForeignKey("conversations.id", ondelete="CASCADE"), index=True)
    role: Mapped[str] = mapped_column(String(32))
    content: Mapped[str] = mapped_column(Text)
    sequence: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    conversation: Mapped[Conversation] = relationship(back_populates="messages")


Base.metadata.create_all(db().bind)


class ConversationCreateIn(BaseModel):
    model: str = Field(min_length=1, max_length=120)
    title: str = Field(default="گفتگوی جدید", min_length=1, max_length=200)


class MessageIn(BaseModel):
    role: str = Field(pattern="^(user|assistant|system)$")
    content: str = Field(min_length=1, max_length=500000)


def owned_conversation(session, conversation_id: str, user_id: str) -> Conversation:
    item = session.scalar(select(Conversation).where(Conversation.id == conversation_id, Conversation.user_id == user_id))
    if not item:
        raise HTTPException(404, "گفتگو پیدا نشد")
    return item


@router.get("/conversations")
def list_conversations(user: User = Depends(get_current_user)) -> dict[str, Any]:
    with db() as session:
        items = session.scalars(select(Conversation).where(Conversation.user_id == user.id).order_by(Conversation.updated_at.desc())).all()
        return {"data": [{"id": x.id, "title": x.title, "model": x.model, "created_at": x.created_at.isoformat(), "updated_at": x.updated_at.isoformat()} for x in items]}


@router.post("/conversations")
def create_conversation(payload: ConversationCreateIn, user: User = Depends(get_current_user)) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    with db() as session:
        item = Conversation(user_id=user.id, title=payload.title, model=payload.model, created_at=now, updated_at=now)
        session.add(item)
        session.commit()
        session.refresh(item)
        return {"data": {"id": item.id, "title": item.title, "model": item.model, "created_at": item.created_at.isoformat(), "updated_at": item.updated_at.isoformat()}}


@router.get("/conversations/{conversation_id}")
def get_conversation(conversation_id: str, user: User = Depends(get_current_user)) -> dict[str, Any]:
    with db() as session:
        item = owned_conversation(session, conversation_id, user.id)
        messages = [{"id": m.id, "role": m.role, "content": m.content, "created_at": m.created_at.isoformat()} for m in item.messages]
        return {"data": {"id": item.id, "title": item.title, "model": item.model, "messages": messages}}


@router.post("/conversations/{conversation_id}/messages")
def append_message(conversation_id: str, payload: MessageIn, user: User = Depends(get_current_user)) -> dict[str, Any]:
    with db() as session:
        item = owned_conversation(session, conversation_id, user.id)
        count = session.scalar(select(func.count(ConversationMessage.id)).where(ConversationMessage.conversation_id == item.id)) or 0
        message = ConversationMessage(conversation_id=item.id, role=payload.role, content=payload.content, sequence=count)
        if payload.role == "user" and item.title == "گفتگوی جدید":
            compact = " ".join(payload.content.split())
            item.title = compact[:57] + ("…" if len(compact) > 57 else "")
        item.updated_at = datetime.now(timezone.utc)
        session.add(message)
        session.commit()
        session.refresh(message)
        return {"data": {"id": message.id, "role": message.role, "content": message.content}}


@router.delete("/conversations/{conversation_id}")
def delete_conversation(conversation_id: str, user: User = Depends(get_current_user)) -> dict[str, bool]:
    with db() as session:
        item = owned_conversation(session, conversation_id, user.id)
        session.delete(item)
        session.commit()
    return {"ok": True}


@router.get("/usage")
async def usage(user: User = Depends(get_current_user)) -> dict[str, Any]:
    # LiteLLM remains the source of truth for spend; portal DB owns user/key mapping.
    from app.main import fernet, key_usage, PortalKey
    with db() as session:
        keys = session.scalars(select(PortalKey).where(PortalKey.user_id == user.id)).all()
        total_spend = 0.0
        records = []
        for item in keys:
            try:
                token = fernet.decrypt(item.token_encrypted.encode()).decode()
                info = await key_usage(token)
            except Exception:
                info = {}
            spend = float(info.get("spend") or 0)
            total_spend += spend
            records.append({"id": item.id, "alias": item.alias, "spend": spend, "status": item.status})
        conversation_count = session.scalar(select(func.count(Conversation.id)).where(Conversation.user_id == user.id)) or 0
        message_count = session.scalar(select(func.count(ConversationMessage.id)).join(Conversation, Conversation.id == ConversationMessage.conversation_id).where(Conversation.user_id == user.id)) or 0
    return {"total_spend": total_spend, "keys": records, "conversations": conversation_count, "messages": message_count}
