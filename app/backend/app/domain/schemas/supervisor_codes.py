"""Pydantic schemas for per-supervisor invite codes + pending-executive approvals."""
from __future__ import annotations

from datetime import datetime
from pydantic import BaseModel, ConfigDict

# Was a fixed Literal of six built-ins; now a shape-validated key whose tenant
# registration/enablement is checked by the service (see business_admin.Module).
from app.domain.schemas.business_admin import Module  # noqa: F401  (re-exported)


class InviteCodeOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    module: Module
    code: str
    created_at: datetime
    rotated_at: datetime | None = None


class PendingExecOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    email: str
    module: Module
    created_at: datetime


class AvailableExecutiveOut(BaseModel):
    """An executive in this module who is NOT yet on the caller's team.

    Deliberately not TeamMemberOut: that carries `joined_at`, which is the date
    they joined MY team — and the whole point of this list is that they have not.
    Reusing it made the endpoint 500 on any non-empty result while validating
    fine when empty, so it looked healthy right up until it had something to say.
    """
    model_config = ConfigDict(from_attributes=True)
    id: str
    email: str
    name: str | None = None
    module: Module


class TeamMemberOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    email: str
    name: str | None = None
    module: Module
    joined_at: datetime
