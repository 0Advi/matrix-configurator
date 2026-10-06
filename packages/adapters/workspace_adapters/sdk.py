"""Adapter SDK — the only surface a module adapter sees (Task 5).

An adapter is a small, versioned plug-in for behaviour the manifest cannot express. It never gets a database
handle, never sees roles and never sees the live release: it receives a frozen snapshot of ONE case on its
pinned release and returns *decisions*, *violations*, *normalised values* or *effects*. The host
(``host.py``) checks every output against the adapter's descriptor and the rules in docs/adapters/README.md.

Hooks (all optional; an adapter declares the ones it implements, and the manifest lists the ones it uses):

  beforeOpen(OpenContext)              -> Decision                 may refuse opening a case (fail-closed)
  beforeSubmit(SubmitContext)          -> SubmitResult             may normalise / refuse the stage's own values
  validateBusinessRule(RuleContext)    -> list[Violation]          pure check before submit AND before every decision
  afterSubmit(AfterContext)            -> Effects                  after commit, via the outbox (at-least-once)
  beforeApprove(ApproveContext)        -> Decision                 may refuse approve / reject / send_back (fail-closed)
  afterApprove(AfterContext)           -> Effects                  after commit, via the outbox (at-least-once)
  computeOutcome(OutcomeContext)       -> str                      the case's exit outcome; must be deterministic
  syncExternalState(SyncContext)       -> Effects                  reacts to a consumed event (another module, a signal)
"""
from __future__ import annotations

from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple

HOOKS = ("beforeOpen", "beforeSubmit", "validateBusinessRule", "afterSubmit",
         "beforeApprove", "afterApprove", "computeOutcome", "syncExternalState")
COMMAND_KINDS = ("open_case", "submit_stage", "record_signal", "reopen_case")


def freeze(x: Any) -> Any:
    """Deep read-only view: dicts → MappingProxyType, lists → tuples. Adapters cannot mutate what they read."""
    if isinstance(x, Mapping):
        return MappingProxyType({k: freeze(v) for k, v in x.items()})
    if isinstance(x, (list, tuple)):
        return tuple(freeze(v) for v in x)
    return x


# ───────────────────────────────────────────────────────────── inputs (all frozen) ──
@dataclass(frozen=True)
class Actor:
    """WHO acts — never what they may do. Authorisation is decided by the runtime before any hook runs."""
    id: str
    display_name: str
    acting_as_delegate: bool = False
    is_override: bool = False


@dataclass(frozen=True)
class CaseSnapshot:
    id: str
    module: str
    release_version: int            # the PINNED release; adapters never see another one for this case
    subject_type: str
    subject_id: str
    subject: Mapping[str, Any]      # subject fields (read-only)
    status: str                     # open | in_progress | completed | rejected | parked
    current_stage: Optional[str]
    reached: Tuple[str, ...]
    values: Mapping[str, Mapping[str, Any]]   # stage key -> submitted values (incl. approval fields)
    created_by: str
    assigned_to: Optional[str] = None


@dataclass(frozen=True)
class ReadAPI:
    """Read-only, same-subject view of other modules' cases (outcomes, stage values). Never tables."""
    _cases: Callable[[str], Tuple[CaseSnapshot, ...]] = field(repr=False, default=lambda module: ())

    def cases(self, module: str) -> Tuple[CaseSnapshot, ...]:
        return self._cases(module)


@dataclass(frozen=True)
class BaseContext:
    adapter_key: str
    adapter_version: str
    config: Mapping[str, Any]               # adapter.config from the PINNED release manifest
    module: Mapping[str, Any]               # the module definition from the PINNED release
    case: CaseSnapshot
    actor: Actor
    read: ReadAPI
    locale: str = "en"
    currency: Optional[str] = None
    now: str = ""                           # ISO timestamp supplied by the host (deterministic replays)


@dataclass(frozen=True)
class OpenContext(BaseContext):
    pass


@dataclass(frozen=True)
class SubmitContext(BaseContext):
    stage: str = ""
    values: Mapping[str, Any] = field(default_factory=lambda: freeze({}))


@dataclass(frozen=True)
class RuleContext(BaseContext):
    stage: str = ""
    action: str = "submit"                  # submit | approve | reject | send_back
    tier: Optional[int] = None              # approval tier index for decisions
    values: Mapping[str, Any] = field(default_factory=lambda: freeze({}))   # values being submitted / approval fields


@dataclass(frozen=True)
class ApproveContext(BaseContext):
    stage: str = ""
    action: str = "approve"
    tier: int = 0
    values: Mapping[str, Any] = field(default_factory=lambda: freeze({}))


@dataclass(frozen=True)
class AfterContext(BaseContext):
    stage: str = ""
    action: str = "submit"
    event_id: str = ""                      # the runtime event this reacts to; effect keys derive from it


@dataclass(frozen=True)
class OutcomeContext(BaseContext):
    default_outcome: str = ""               # what the manifest roll-up / exit would choose
    allowed: Tuple[str, ...] = ()           # outcomes the host will accept


@dataclass(frozen=True)
class SyncContext(BaseContext):
    event_type: str = ""
    event_id: str = ""
    payload: Mapping[str, Any] = field(default_factory=lambda: freeze({}))
    event_actor: Optional[Actor] = None     # the human whose action caused the event (commands run on their behalf)


# ───────────────────────────────────────────────────────────────────────── outputs ──
@dataclass(frozen=True)
class Decision:
    allow: bool
    code: Optional[str] = None
    message: Optional[str] = None

    @staticmethod
    def ok() -> "Decision":
        return Decision(True)

    @staticmethod
    def refuse(code: str, message: str) -> "Decision":
        return Decision(False, code, message)


@dataclass(frozen=True)
class Violation:
    field: Optional[str]
    code: str
    message: str


@dataclass(frozen=True)
class SubmitResult:
    values: Optional[Mapping[str, Any]] = None      # normalised values of THIS stage (None = unchanged)
    violations: Tuple[Violation, ...] = ()


@dataclass(frozen=True)
class Event:
    type: str                                        # "<namespace>.<name>", namespace = descriptor.namespace
    payload: Mapping[str, Any]
    key: str                                         # idempotency key (derive from ctx.event_id)


@dataclass(frozen=True)
class Command:
    kind: str                                        # open_case | submit_stage | record_signal | reopen_case
    module: str                                      # must be the adapter's OWN module
    case_id: Optional[str] = None
    stage: Optional[str] = None
    values: Mapping[str, Any] = field(default_factory=lambda: freeze({}))
    on_behalf_of: Optional[str] = None               # actor id; the runtime re-checks that person's permissions
    key: str = ""
    release_version: Optional[int] = None            # must stay None: commands always run on the pinned release


@dataclass(frozen=True)
class SubjectUpdate:
    fields: Mapping[str, Any]                        # only fields listed in descriptor.subject_fields
    key: str = ""


@dataclass(frozen=True)
class Effects:
    events: Tuple[Event, ...] = ()
    commands: Tuple[Command, ...] = ()
    subject_updates: Tuple[SubjectUpdate, ...] = ()

    @staticmethod
    def none() -> "Effects":
        return Effects()


# ─────────────────────────────────────────────────────────────── descriptor + base ──
@dataclass(frozen=True)
class Descriptor:
    """What an installed adapter declares (adapter.json). The host enforces every output against it."""
    key: str                                         # e.g. acme.permits
    version: str
    hooks: Tuple[str, ...]
    namespace: str                                   # event namespace it may emit into
    emits: Tuple[str, ...] = ()                      # full event types it may emit
    consumes: Tuple[str, ...] = ()                   # event types syncExternalState subscribes to
    commands: Tuple[str, ...] = ()                   # command kinds it may request
    subject_fields: Tuple[str, ...] = ()             # subject fields it may ask to update
    timeout_ms: int = 200
    config_schema: Mapping[str, Any] = field(default_factory=lambda: freeze({"type": "object"}))

    @staticmethod
    def from_json(d: Mapping[str, Any]) -> "Descriptor":
        return Descriptor(key=d["key"], version=d["version"], hooks=tuple(d["hooks"]), namespace=d["namespace"],
                          emits=tuple(d.get("emits", ())), consumes=tuple(d.get("consumes", ())),
                          commands=tuple(d.get("commands", ())), subject_fields=tuple(d.get("subject_fields", ())),
                          timeout_ms=int(d.get("timeout_ms", 200)), config_schema=freeze(d.get("config_schema", {"type": "object"})))


class Adapter:
    """Base class. Override only the hooks you declare; the defaults are neutral."""

    def beforeOpen(self, ctx: OpenContext) -> Decision:
        return Decision.ok()

    def beforeSubmit(self, ctx: SubmitContext) -> SubmitResult:
        return SubmitResult()

    def validateBusinessRule(self, ctx: RuleContext) -> List[Violation]:
        return []

    def afterSubmit(self, ctx: AfterContext) -> Effects:
        return Effects.none()

    def beforeApprove(self, ctx: ApproveContext) -> Decision:
        return Decision.ok()

    def afterApprove(self, ctx: AfterContext) -> Effects:
        return Effects.none()

    def computeOutcome(self, ctx: OutcomeContext) -> str:
        return ctx.default_outcome

    def syncExternalState(self, ctx: SyncContext) -> Effects:
        return Effects.none()


def effect_key(event_id: str, suffix: str) -> str:
    """Deterministic idempotency key: re-running an after* hook for the same event yields the same keys."""
    return f"{event_id}:{suffix}"


def as_dict(m: Mapping[str, Any]) -> Dict[str, Any]:
    return {k: (as_dict(v) if isinstance(v, Mapping) else list(v) if isinstance(v, tuple) else v) for k, v in m.items()}
