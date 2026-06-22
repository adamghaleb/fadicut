"""Bearer-token auth dependency.

Simple shared-secret model: the editor sends `Authorization: Bearer <token>` (or
`?token=<token>` for EventSource, which can't set headers). Constant-time compare.
The Bridge is localhost-only; the token defends against drive-by browser tabs and
CSRF-style cross-origin requests, not a determined local attacker.
"""

from __future__ import annotations

import secrets

from fastapi import HTTPException, Query, Request, status

from .config import get_settings


def _present_token(request: Request, token_qs: str | None) -> str | None:
    auth = request.headers.get("authorization")
    if auth and auth.lower().startswith("bearer "):
        return auth[7:].strip()
    if token_qs:
        return token_qs
    # X-Fadi-Token convenience header
    x = request.headers.get("x-fadi-token")
    if x:
        return x.strip()
    return None


async def require_token(
    request: Request,
    token: str | None = Query(default=None, description="Bearer token (for EventSource)."),
) -> None:
    """FastAPI dependency. Raises 401 unless a valid token is presented.

    Accepts the token via Authorization header, X-Fadi-Token header, or ?token= query
    param (the last is needed because the browser EventSource API can't set headers).
    """
    expected = get_settings().token
    presented = _present_token(request, token)
    if presented is None or not secrets.compare_digest(presented, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="missing or invalid bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )
