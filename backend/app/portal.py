"""Stable Portal entrypoint for the existing Hinaa backend application.

The production database already contains the canonical conversation/message
schema and routes in app.main. This module intentionally composes the same
application without introducing a second conversation model or router.
"""

from app.main import app
