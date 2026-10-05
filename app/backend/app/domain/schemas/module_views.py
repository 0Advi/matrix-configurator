"""Pydantic schemas for role-scoped saved views of custom-module pages (Phase 2b, G3 #4).

A view's ``filter`` only NARROWS what the caller may already see — the server applies the
tenant + role scope (executives: own / assigned / delegated / creator-scoped cases) first and the
filter on top, so no filter can widen access. Unknown keys are refused (extra="forbid"): a crafted
filter cannot smuggle a tenant id, a user id or a role.
"""
from __future__ import annotations

from typing import Annotated, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

_UUID = Annotated[str, StringConstraints(pattern=r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")]

AUDIENCE_ROLES = ("executive", "supervisor", "business_admin", "observer")
COLUMNS = ("site", "stage", "next_step", "status", "assigned_to", "opened_by", "opened_at", "closed_at", "release")
CaseStatus = Literal["open", "in_progress", "completed", "rejected", "parked"]
AudienceRole = Literal["executive", "supervisor", "business_admin", "observer"]
Column = Literal["site", "stage", "next_step", "status", "assigned_to", "opened_by", "opened_at", "closed_at", "release"]


class ViewFilter(BaseModel):
    """Every key is optional; keys AND together. A boolean ``false`` negates (e.g. assigned=false)."""

    model_config = ConfigDict(extra="forbid")

    stage: Optional[list[Annotated[int, Field(ge=1)]]] = Field(default=None, max_length=50,
                                                                description="current stage order is one of")
    status: Optional[list[CaseStatus]] = Field(default=None, max_length=5, description="case status is one of")
    closed: Optional[bool] = Field(default=None, description="completed / rejected / parked")
    assigned_to_me: Optional[bool] = Field(default=None, description="case or BD site assigned to me")
    created_by_me: Optional[bool] = Field(default=None, description="I opened the case or created the site")
    mine: Optional[bool] = Field(default=None, description="assigned to me, created by me or delegated to me")
    awaiting: Optional[Literal["my_tier", "executive", "supervisor", "business_admin"]] = Field(
        default=None, description="the next step belongs to this tier (my_tier = my role in the module)")
    actionable: Optional[bool] = Field(default=None, description="I can act on the case now")
    assigned: Optional[bool] = Field(default=None, description="the case has an assignee")
    site_ids: Optional[list[_UUID]] = Field(default=None, max_length=200)
    kind: Optional[Literal["submit", "approve"]] = Field(default=None, description="next step kind")


class ViewIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]
    filter: ViewFilter = Field(default_factory=ViewFilter)
    columns: list[Column] = Field(default_factory=lambda: ["site", "stage", "next_step", "status", "opened_at"],
                                  max_length=len(COLUMNS))
    audience: list[AudienceRole] = Field(default_factory=lambda: list(AUDIENCE_ROLES), min_length=1, max_length=4)
    position: int = Field(default=100, ge=0, le=10000)
    is_default: bool = False
    all_modules: bool = Field(default=False, description="true = the view applies to every custom module")


class ViewPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Optional[Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=80)]] = None
    filter: Optional[ViewFilter] = None
    columns: Optional[list[Column]] = Field(default=None, max_length=len(COLUMNS))
    audience: Optional[list[AudienceRole]] = Field(default=None, min_length=1, max_length=4)
    position: Optional[int] = Field(default=None, ge=0, le=10000)
    is_default: Optional[bool] = None
