"""Dynamic speaker endpoint fleet protocol, audio, and concurrency foundation.

This package is intentionally isolated from the live Voice Lab loop until the
fleet milestones have passed their hermetic gates.
"""

from .service import GatewayControlPlane

__all__ = ["GatewayControlPlane"]
