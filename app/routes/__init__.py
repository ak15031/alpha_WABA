"""Combined router for all API routes.

Each module in this package defines its own router. This __init__ combines
them into one for main.py to include. Add new routers here as you build.
"""
from fastapi import APIRouter

from app.routes.auth import router as auth_router
from app.routes.branches import router as branches_router
from app.routes.broadcasts import router as broadcasts_router
from app.routes.contacts import router as contacts_router
from app.routes.dashboard import router as dashboard_router
from app.routes.messages import router as messages_router
from app.routes.settings import router as settings_router
from app.routes.system import router as system_router
from app.routes.templates import router as templates_router
from app.routes.phone_numbers import router as phone_numbers_router
from app.routes.groups import router as groups_router

router = APIRouter()
router.include_router(auth_router)
router.include_router(branches_router)
router.include_router(templates_router)
router.include_router(contacts_router)
router.include_router(phone_numbers_router)
router.include_router(broadcasts_router)
router.include_router(dashboard_router)
router.include_router(messages_router)
router.include_router(settings_router)
router.include_router(system_router)
router.include_router(groups_router)