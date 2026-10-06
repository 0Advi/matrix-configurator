"""Example adapter for the Matrix-bd BD template (templates/matrix-bd/bd.template.json).

Reproduces the BD behaviour the manifest cannot express yet:
  beforeSubmit          switching away from 'staggered' clears the schedule; the schedule is stored canonically
                        (Matrix-bd bd_service._apply_staggered_escalation)
  validateBusinessRule  rent-terms rules (rent-terms.json; schemas/site.py CreateDraftRequest._staggered_requirements;
                        DB is_valid_staggered_escalation): staggered needs a base rent and 1..N schedule rows with
                        unique integer years >= 1, 0 <= percent <= 100, mg >= 0, 0 <= dine_in/delivery <= 100
  afterApprove          on the details approval, the supervisor's expected_loi_days becomes an LOI deadline event

Every stage/field key comes from adapter.config — nothing is hard-coded to a workspace. No role is read:
whoever reaches these hooks was already authorised by the runtime.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

from workspace_adapters.sdk import (Adapter, AfterContext, Effects, Event, RuleContext, SubmitContext, SubmitResult,
                                    Violation, effect_key)

SCHEDULE = "staggered_escalation"
RENT_TYPE = "rent_type"
BASE_RENT = "expected_rent"


def _parse_schedule(raw: Any) -> Optional[List[Dict[str, Any]]]:
    if raw in (None, "", []):
        return None
    rows = json.loads(raw) if isinstance(raw, str) else [dict(r) for r in raw]
    if not isinstance(rows, list):
        raise ValueError("the schedule must be a list of rows")
    return rows


def _num(x: Any) -> Optional[float]:
    return float(x) if isinstance(x, (int, float)) and not isinstance(x, bool) else None


class BdAdapter(Adapter):
    def beforeSubmit(self, ctx: SubmitContext) -> SubmitResult:
        if ctx.stage != ctx.config["rent_stage"]:
            return SubmitResult()
        values = dict(ctx.values)
        if values.get(RENT_TYPE) != "staggered":
            if values.get(SCHEDULE) in (None, ""):
                return SubmitResult()
            values[SCHEDULE] = None                       # switching away from staggered clears the schedule
            return SubmitResult(values=values)
        try:
            rows = _parse_schedule(values.get(SCHEDULE))
        except (ValueError, TypeError):
            return SubmitResult()                         # left for validateBusinessRule to report
        if rows is not None:
            rows = sorted(rows, key=lambda r: (r.get("year") if isinstance(r.get("year"), int) else 0))
            values[SCHEDULE] = json.dumps(rows, sort_keys=True, separators=(",", ":"))
            return SubmitResult(values=values)
        return SubmitResult()

    def validateBusinessRule(self, ctx: RuleContext) -> List[Violation]:
        if ctx.action != "submit" or ctx.stage != ctx.config["rent_stage"]:
            return []
        v = ctx.values
        out: List[Violation] = []
        if v.get(RENT_TYPE) != "staggered":
            return out
        if _num(v.get(BASE_RENT)) is None:
            out.append(Violation(BASE_RENT, "required_for_staggered", "Base rent is required for staggered rent."))
        try:
            rows = _parse_schedule(v.get(SCHEDULE))
        except (ValueError, TypeError) as exc:
            return out + [Violation(SCHEDULE, "schedule_unreadable", f"The escalation schedule is not readable: {exc}")]
        max_rows = int(ctx.config.get("schedule_max_rows", 5))
        if not rows:
            return out + [Violation(SCHEDULE, "required_for_staggered", "Staggered rent needs an escalation schedule.")]
        if len(rows) > max_rows:
            out.append(Violation(SCHEDULE, "too_many_rows", f"At most {max_rows} schedule rows are allowed."))
        years = []
        for i, row in enumerate(rows, 1):
            if not isinstance(row, dict):
                out.append(Violation(SCHEDULE, "bad_row", f"Row {i} is not a {{year, percent}} entry."))
                continue
            year, pct = row.get("year"), _num(row.get("percent"))
            if not isinstance(year, int) or isinstance(year, bool) or year < 1:
                out.append(Violation(SCHEDULE, "bad_year", f"Row {i}: year must be a whole number from 1."))
            else:
                years.append(year)
            if pct is None or not 0 <= pct <= 100:
                out.append(Violation(SCHEDULE, "bad_percent", f"Row {i}: escalation percent must be between 0 and 100."))
            if "mg" in row and (_num(row["mg"]) is None or _num(row["mg"]) < 0):
                out.append(Violation(SCHEDULE, "bad_mg", f"Row {i}: minimum guarantee cannot be negative."))
            for k in ("dine_in_pct", "delivery_pct"):
                if k in row and (_num(row[k]) is None or not 0 <= _num(row[k]) <= 100):
                    out.append(Violation(SCHEDULE, f"bad_{k}", f"Row {i}: {k.replace('_', ' ')} must be between 0 and 100."))
        dup = sorted({y for y in years if years.count(y) > 1})
        if dup:
            out.append(Violation(SCHEDULE, "duplicate_year", f"Years must be unique; repeated: {dup}."))
        return out

    def afterApprove(self, ctx: AfterContext) -> Effects:
        if ctx.action != "approve" or ctx.stage != ctx.config["deadline_stage"]:
            return Effects.none()
        days = (ctx.case.values.get(ctx.stage) or {}).get(ctx.config["deadline_field"])
        if not isinstance(days, int) or isinstance(days, bool) or days <= 0:
            return Effects.none()
        due = datetime.fromisoformat(ctx.now) + timedelta(days=days)
        return Effects(events=(Event(type="matrix_bd.bd.loi_deadline_set",
                                     payload={"case_id": ctx.case.id, "days": days, "due_at": due.isoformat()},
                                     key=effect_key(ctx.event_id, "loi_deadline")),))
