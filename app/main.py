"""FastAPI app factory. Entry point for uvicorn (locally + Render).

Run locally:
    uvicorn app.main:app --reload --host 127.0.0.1 --port 8000

On Render, the startCommand in render.yaml points here:
    uvicorn app.main:app --host 0.0.0.0 --port $PORT
"""
from __future__ import annotations

import logging
import os
import traceback
import uuid as _uuid
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api import router as api_router
from app.config import settings
from app.db import dispose_engine, ping
from app.routes import router as routes_router
from app.routes import plateform as platform_routes
from app.routes import users as users_routes
from app.webhooks import router as webhooks_router

logging.basicConfig(
    level=settings.log_level,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
logger = logging.getLogger("app.main")
_EXPOSE_ERROR_DETAILS = os.getenv("EXPOSE_ERROR_DETAILS", "false").lower() == "true"


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    """Startup: ping DB. Shutdown: dispose the engine + close arq pool."""
    if not await ping():
        logger.error("Database unreachable at startup")
        raise RuntimeError("Database unreachable at startup")
    logger.info("Startup complete (env=%s)", settings.app_env)
    yield
    await dispose_engine()
    # Close arq Redis pool if it was ever opened (lazy singleton)
    from app.workers.router import close_arq_pool

    await close_arq_pool()
    logger.info("Shutdown complete")


def create_app() -> FastAPI:
    app = FastAPI(
        title="Alpha WABA API",
        version="0.1.0",
        lifespan=lifespan,

    )

    # CORS — the frontend will call from a different origin. Configured via
    # ALLOWED_CORS_ORIGINS env var (comma-separated).
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.allowed_cors_origins_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
        request_id = str(_uuid.uuid4())
        tb_tail = traceback.format_exc().splitlines()[-6:]

        logger.error(
            "Unhandled exception on %s %s | request_id=%s | %s: %s\n%s",
            request.method,
            request.url.path,
            request_id,
            type(exc).__name__,
            str(exc),
            "\n".join(tb_tail),
        )

        return JSONResponse(
            status_code=500,
            content=(
                {
                    "detail": "Internal server error",
                    "error_type": type(exc).__name__,
                    "error_message": str(exc)[:500],
                    "request_id": request_id,
                    "path": request.url.path,
                }
                if _EXPOSE_ERROR_DETAILS
                else {"detail": "Internal server error", "request_id": request_id}
            ),
        )

    app.include_router(webhooks_router)
    app.include_router(api_router)
    app.include_router(routes_router)
    app.include_router(users_routes.router)
    app.include_router(platform_routes.router)

    return app


app = create_app()
