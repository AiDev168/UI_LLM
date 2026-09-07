"""add user status permissions and password state

Revision ID: 7d2b9c4a1e10
Revises: 53ccaaff04df
Create Date: 2026-09-06
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "7d2b9c4a1e10"
down_revision: Union[str, Sequence[str], None] = "53ccaaff04df"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "status",
            sa.String(length=32),
            nullable=False,
            server_default="active",
        ),
    )

    op.add_column(
        "users",
        sa.Column(
            "chat_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
    )

    op.add_column(
        "users",
        sa.Column(
            "api_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
    )

    op.add_column(
        "users",
        sa.Column(
            "mlops_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )

    op.add_column(
        "users",
        sa.Column(
            "must_change_password",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )

    op.create_index(
        "ix_users_status",
        "users",
        ["status"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_users_status", table_name="users")
    op.drop_column("users", "must_change_password")
    op.drop_column("users", "mlops_enabled")
    op.drop_column("users", "api_enabled")
    op.drop_column("users", "chat_enabled")
    op.drop_column("users", "status")
