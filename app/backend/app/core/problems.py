"""Structured API errors (Phase 2 — configurator integration).

``ApiProblem`` is an HTTPException whose ``detail`` stays a human-readable STRING
(what every existing frontend handler reads) and which carries extra machine-
readable keys next to it — e.g. ``code``, ``findings`` (publish validation),
``gate`` (why a module is locked) or ``errors`` (form validation). The handler in
app/main.py renders ``{"detail": <str>, **extra}``.
"""
from __future__ import annotations

from typing import Any, Optional

from fastapi import HTTPException


class ApiProblem(HTTPException):
    def __init__(self, status_code: int, detail: str, *, code: Optional[str] = None, **extra: Any) -> None:
        super().__init__(status_code=status_code, detail=detail)
        self.extra: dict[str, Any] = ({"code": code} if code else {}) | extra
