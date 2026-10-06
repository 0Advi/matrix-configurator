"""Adapter host — runs adapter hooks for the generic runtime and enforces the contract (Task 5).

The runtime calls ``AdapterHost.run(hook, ctx, declared_hooks)`` at fixed points. The host:

1. runs only hooks that BOTH the installed descriptor implements AND the case's PINNED release manifest
   declares (``module.adapter.hooks``) — nothing runs that the manifest does not show;
2. loads the adapter VERSION pinned by that release (release pinning applies to code too);
3. enforces a time budget per call;
4. checks every output against the descriptor and the rules (own-module commands only, own event namespace,
   declared subject fields only, no release override, no anonymous submissions, deterministic outcomes);
5. applies the failure policy: before*/validate/computeOutcome FAIL CLOSED (the human action is refused,
   nothing changes); after*/sync effects are rejected as a whole and dead-lettered (the committed human action
   stands; an alert is raised).
"""
from __future__ import annotations

import concurrent.futures as cf
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence, Tuple

from .sdk import (COMMAND_KINDS, HOOKS, Adapter, AfterContext, BaseContext, Command, Decision, Descriptor, Effects,
                  OutcomeContext, SubmitContext, SubmitResult, SyncContext, Violation)

FAIL_CLOSED = ("beforeOpen", "beforeSubmit", "validateBusinessRule", "beforeApprove", "computeOutcome")
EFFECT_HOOKS = ("afterSubmit", "afterApprove", "syncExternalState")
ACTOR_COMMANDS = ("submit_stage", "reopen_case")      # must run on behalf of a real person


class ContractViolation(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(f"{code}: {message}")
        self.code, self.message = code, message


@dataclass
class HostResult:
    ok: bool
    hook: str
    value: Any = None                       # Decision | SubmitResult | list[Violation] | str | Effects
    error: Optional[str] = None             # adapter_error | adapter_timeout | contract code
    message: Optional[str] = None
    dead_letter: bool = False               # effect hooks: rejected effects to be parked + alerted
    skipped: bool = False                   # hook not declared → not run


@dataclass
class Installed:
    descriptor: Descriptor
    impl: Adapter


@dataclass
class AdapterHost:
    installed: Dict[Tuple[str, str], Installed] = field(default_factory=dict)   # (key, version) -> adapter
    _pool: cf.ThreadPoolExecutor = field(default_factory=lambda: cf.ThreadPoolExecutor(max_workers=4), repr=False)

    def install(self, descriptor: Descriptor, impl: Adapter) -> None:
        unknown = set(descriptor.hooks) - set(HOOKS)
        if unknown:
            raise ContractViolation("unknown_hook", f"descriptor declares unknown hooks {sorted(unknown)}")
        if not set(descriptor.commands) <= set(COMMAND_KINDS):
            raise ContractViolation("unknown_command", f"descriptor declares unknown commands {descriptor.commands}")
        if any(not e.startswith(descriptor.namespace + ".") for e in descriptor.emits):
            raise ContractViolation("event_namespace", "every emitted event type must start with the adapter namespace")
        self.installed[(descriptor.key, descriptor.version)] = Installed(descriptor, impl)

    def registry(self) -> Dict[str, Dict[str, Any]]:
        """The shape packages/manifest validate(adapters=...) expects."""
        reg: Dict[str, Dict[str, Any]] = {}
        for (key, ver), inst in self.installed.items():
            e = reg.setdefault(key, {"versions": [], "hooks": list(inst.descriptor.hooks)})
            e["versions"].append(ver)
        return reg

    # ────────────────────────────────────────────────────────────────────────── run ──
    def run(self, hook: str, ctx: BaseContext, declared_hooks: Sequence[str]) -> HostResult:
        if hook not in HOOKS:
            raise ValueError(hook)
        if hook not in declared_hooks:
            return HostResult(True, hook, value=_neutral(hook, ctx), skipped=True)
        inst = self.installed.get((ctx.adapter_key, ctx.adapter_version))
        if inst is None:
            return self._fail(hook, "adapter_missing", f"adapter {ctx.adapter_key}@{ctx.adapter_version} (pinned by release "
                                                       f"v{ctx.case.release_version}) is not installed")
        if hook not in inst.descriptor.hooks:
            return self._fail(hook, "hook_not_implemented", f"{ctx.adapter_key} does not implement {hook}")
        try:
            value = self._call(inst, hook, ctx)
            if hook == "computeOutcome":                       # determinism: same input, same output
                again = self._call(inst, hook, ctx)
                if again != value:
                    raise ContractViolation("nondeterministic_outcome", f"computeOutcome returned {value!r} then {again!r}")
            self._check(inst.descriptor, hook, ctx, value)
            return HostResult(True, hook, value=value)
        except ContractViolation as cv:
            return self._fail(hook, cv.code, cv.message)
        except cf.TimeoutError:
            return self._fail(hook, "adapter_timeout", f"{hook} exceeded {inst.descriptor.timeout_ms} ms")
        except Exception as exc:  # noqa: BLE001 — any adapter bug is contained here
            return self._fail(hook, "adapter_error", f"{type(exc).__name__}: {exc}")

    def _call(self, inst: Installed, hook: str, ctx: BaseContext) -> Any:
        fut = self._pool.submit(getattr(inst.impl, hook), ctx)
        return fut.result(timeout=inst.descriptor.timeout_ms / 1000)

    def _fail(self, hook: str, code: str, message: str) -> HostResult:
        if hook in EFFECT_HOOKS:
            return HostResult(False, hook, value=Effects.none(), error=code, message=message, dead_letter=True)
        refusal = {"beforeOpen": Decision.refuse(code, message), "beforeApprove": Decision.refuse(code, message),
                   "beforeSubmit": SubmitResult(violations=(Violation(None, code, message),)),
                   "validateBusinessRule": [Violation(None, code, message)],
                   "computeOutcome": None}[hook]
        return HostResult(False, hook, value=refusal, error=code, message=message)

    # ─────────────────────────────────────────────────────────────── output checks ──
    def _check(self, d: Descriptor, hook: str, ctx: BaseContext, value: Any) -> None:
        if hook in ("beforeOpen", "beforeApprove"):
            if not isinstance(value, Decision):
                raise ContractViolation("bad_return", f"{hook} must return a Decision")
        elif hook == "beforeSubmit":
            if not isinstance(value, SubmitResult):
                raise ContractViolation("bad_return", "beforeSubmit must return a SubmitResult")
            if value.values is not None:
                own = _stage_field_keys(ctx.module, ctx.stage, approval=False)   # type: ignore[attr-defined]
                extra = set(value.values) - own
                if extra:
                    raise ContractViolation("foreign_values", f"beforeSubmit may only normalise fields of stage "
                                                              f"{ctx.stage!r}; got {sorted(extra)}")  # type: ignore[attr-defined]
        elif hook == "validateBusinessRule":
            if not isinstance(value, list) or not all(isinstance(v, Violation) for v in value):
                raise ContractViolation("bad_return", "validateBusinessRule must return a list of Violation")
        elif hook == "computeOutcome":
            allowed = ctx.allowed  # type: ignore[attr-defined]
            if value not in allowed:
                raise ContractViolation("outcome_not_allowed", f"computeOutcome returned {value!r}; allowed: {list(allowed)}")
        else:
            self._check_effects(d, hook, ctx, value)

    def _check_effects(self, d: Descriptor, hook: str, ctx: BaseContext, eff: Any) -> None:
        if not isinstance(eff, Effects):
            raise ContractViolation("bad_return", f"{hook} must return Effects")
        if hook == "syncExternalState" and ctx.event_type not in d.consumes:  # type: ignore[attr-defined]
            raise ContractViolation("not_subscribed", f"{d.key} does not consume {ctx.event_type!r}")  # type: ignore[attr-defined]
        for e in eff.events:
            if not e.type.startswith(d.namespace + ".") or e.type not in d.emits:
                raise ContractViolation("event_not_declared", f"event {e.type!r} is not in {d.key}'s namespace/emits")
            if not e.key:
                raise ContractViolation("missing_effect_key", f"event {e.type!r} has no idempotency key")
        allowed_actor = (ctx.event_actor.id if isinstance(ctx, SyncContext) and ctx.event_actor else
                         ctx.actor.id if isinstance(ctx, AfterContext) else None)
        for c in eff.commands:
            if c.kind not in d.commands:
                raise ContractViolation("command_not_declared", f"command {c.kind!r} is not declared by {d.key}")
            if c.module != ctx.case.module:
                raise ContractViolation("cross_module_write", f"command targets module {c.module!r}; adapters may only "
                                                              f"act on their own module ({ctx.case.module!r}) — use an event")
            if c.release_version is not None:
                raise ContractViolation("release_override", "commands always run on the case's pinned release")
            if c.kind in ACTOR_COMMANDS:
                if not c.on_behalf_of:
                    raise ContractViolation("anonymous_command", f"{c.kind} must run on behalf of a person")
                if c.on_behalf_of != allowed_actor:
                    raise ContractViolation("impersonation", f"{c.kind} may only run on behalf of the person who caused "
                                                             f"the triggering event ({allowed_actor})")
            if not c.key:
                raise ContractViolation("missing_effect_key", f"command {c.kind!r} has no idempotency key")
        for u in eff.subject_updates:
            extra = set(u.fields) - set(d.subject_fields)
            if extra:
                raise ContractViolation("subject_field_not_declared", f"subject fields {sorted(extra)} are not declared by {d.key}")
            if not u.key:
                raise ContractViolation("missing_effect_key", "subject update has no idempotency key")


def _stage_field_keys(module: Mapping[str, Any], stage_key: str, *, approval: bool) -> set:
    for s in module.get("stages", ()):
        if s.get("key") == stage_key:
            keys = {f.get("key") for f in s.get("fields", ())}
            if approval:
                keys |= {f.get("key") for a in s.get("approvals", ()) for f in a.get("fields", ())}
            return keys
    return set()


def _neutral(hook: str, ctx: BaseContext) -> Any:
    return {"beforeOpen": Decision.ok(), "beforeApprove": Decision.ok(), "beforeSubmit": SubmitResult(),
            "validateBusinessRule": [], "computeOutcome": getattr(ctx, "default_outcome", None),
            "afterSubmit": Effects.none(), "afterApprove": Effects.none(), "syncExternalState": Effects.none()}[hook]
