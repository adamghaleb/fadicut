"""FastAPI routers for the Bridge core (batch A)."""

from .health import router as health_router
from .jobs import router as jobs_router
from .media import router as media_router
from .projects import router as projects_router
from .render import router as render_router

__all__ = [
    "health_router",
    "jobs_router",
    "media_router",
    "projects_router",
    "render_router",
]
