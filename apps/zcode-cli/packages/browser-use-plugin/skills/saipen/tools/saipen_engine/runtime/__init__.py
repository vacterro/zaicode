"""Portable runtime identity, capability and strategy projection.

Runtime metadata is session telemetry.  It never owns Work, replaces the
acting ``--agent`` seat, or becomes canonical project state.  Wave 2 adds the
executable strategy decision, which is also read-only.
"""

from .base import (
    CAPABILITY_NAMES,
    CHILD_PACKET_CEILINGS,
    CONTEXT_BUDGET_CLASSES,
    DEFAULT_STRATEGY,
    DEFAULT_TASK_CLASS,
    DEPTH_ENFORCEMENT,
    ENV_RUNTIME_INFO,
    HELPER_JUSTIFICATIONS,
    MAX_SUBAGENT_DEPTH,
    RUNTIME_INFO_SCHEMA_VERSION,
    STRATEGIES,
    STRATEGY_CAPABILITIES,
    TASK_CLASSES,
    RuntimeInfoError,
    StrategyError,
    load_runtime_info,
    runtime_projection,
    select_strategy,
    strategy_projection,
)

__all__ = (
    "CAPABILITY_NAMES",
    "CHILD_PACKET_CEILINGS",
    "CONTEXT_BUDGET_CLASSES",
    "DEFAULT_STRATEGY",
    "DEFAULT_TASK_CLASS",
    "DEPTH_ENFORCEMENT",
    "ENV_RUNTIME_INFO",
    "HELPER_JUSTIFICATIONS",
    "MAX_SUBAGENT_DEPTH",
    "RUNTIME_INFO_SCHEMA_VERSION",
    "STRATEGIES",
    "STRATEGY_CAPABILITIES",
    "TASK_CLASSES",
    "RuntimeInfoError",
    "StrategyError",
    "load_runtime_info",
    "runtime_projection",
    "select_strategy",
    "strategy_projection",
)
