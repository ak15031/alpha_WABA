import uuid
from datetime import datetime
from fastapi import APIRouter, Depends, HTTPException, status
import re
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import (
    CurrentUser, TenantContext,
    get_active_tenant_context, get_current_user, get_tenant_scoped_session,
)
from app.models import UserTenantMembership, MembershipStatus, UserRole
from app.supabase_admin import get_supabase_admin, SupabaseAdminError

router = APIRouter(prefix="/users", tags=["users"])


# ---------------------- Permission guard ----------------------

async def require_tenant_admin(
    current_user: CurrentUser = Depends(get_current_user),
    ctx: TenantContext = Depends(get_active_tenant_context),
    session: AsyncSession = Depends(get_tenant_scoped_session),
) -> CurrentUser:
    membership = await session.scalar(
        select(UserTenantMembership).where(
            UserTenantMembership.user_id == current_user.id,
            UserTenantMembership.tenant_id == ctx.tenant_id,
        )
    )
    if not membership or membership.role != UserRole.tenant_admin:
        raise HTTPException(status_code=403, detail="Tenant admin required")
    return current_user


# ---------------------- Schemas ----------------------

class UserRow(BaseModel):
    id: str                 # membership id
    user_id: str            # auth user id
    email: str
    role: str
    status: str
    invited_at: str | None
    accepted_at: str | None


class InviteRequest(BaseModel):
    email: str
    role: str = Field(default="tenant_user", pattern="^(tenant_admin|tenant_user)$")

    @field_validator("email")
    @classmethod
    def _normalize_and_check(cls, v: str) -> str:
        v = v.strip().lower()
        if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", v):
            raise ValueError("Invalid email format")
        return v

class RoleUpdate(BaseModel):
    role: str = Field(pattern="^(tenant_admin|tenant_user)$")


# ---------------------- Endpoints ----------------------

@router.get("", response_model=list[UserRow])
async def list_users(
    _: CurrentUser = Depends(require_tenant_admin),
    session: AsyncSession = Depends(get_tenant_scoped_session),
) -> list[UserRow]:
    rows = (await session.execute(
        select(UserTenantMembership).order_by(UserTenantMembership.created_at.desc())
    )).scalars().all()
    return [
        UserRow(
            id=str(r.id),
            user_id=str(r.user_id),
            email=r.email or "",
            role=r.role.value,
            status=r.status.value,
            invited_at=r.invited_at.isoformat() if r.invited_at else None,
            accepted_at=r.accepted_at.isoformat() if r.accepted_at else None,
        )
        for r in rows
    ]


@router.post("/invite", status_code=status.HTTP_201_CREATED)
async def invite_user(
    body: InviteRequest,
    _: CurrentUser = Depends(require_tenant_admin),
    ctx: TenantContext = Depends(get_active_tenant_context),
    session: AsyncSession = Depends(get_tenant_scoped_session),
) -> dict:
    # Reject duplicate invite within same tenant
    existing = await session.scalar(
        select(UserTenantMembership).where(UserTenantMembership.email == body.email)
    )
    if existing:
        raise HTTPException(
            status_code=409,
            detail=f"{body.email} already has a membership in this tenant",
        )

    import os
    redirect_to = f"{os.environ['FRONTEND_URL']}/accept-invite"

    admin = get_supabase_admin()
    try:
        invited = await admin.invite_by_email(
            email=body.email,
            redirect_to=redirect_to,
            metadata={"tenant_id": str(ctx.tenant_id), "role": body.role},
        )
    except SupabaseAdminError as exc:
        raise HTTPException(status_code=502, detail=f"Supabase invite failed: {exc}")

    supabase_user_id = (invited.get("user") or {}).get("id") or invited.get("id")
    if not supabase_user_id:
        raise HTTPException(status_code=502, detail="Supabase did not return a user id")

    membership = UserTenantMembership(
        tenant_id=ctx.tenant_id,
        user_id=uuid.UUID(supabase_user_id),
        email=body.email,
        role=UserRole(body.role),
        status=MembershipStatus.invited,
        invited_at=datetime.utcnow(),
    )
    session.add(membership)
    await session.flush()
    return {"status": "invited", "email": body.email, "user_id": supabase_user_id}


@router.patch("/{membership_id}/role")
async def update_role(
    membership_id: str,
    body: RoleUpdate,
    current_user: CurrentUser = Depends(require_tenant_admin),
    session: AsyncSession = Depends(get_tenant_scoped_session),
) -> dict:
    try:
        mid = uuid.UUID(membership_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="membership_id must be a UUID")

    membership = await session.get(UserTenantMembership, mid)
    if not membership:
        raise HTTPException(status_code=404, detail="Membership not found")
    if membership.user_id == current_user.id:
        raise HTTPException(status_code=400, detail="You cannot change your own role")

    membership.role = UserRole(body.role)
    await session.flush()
    return {"status": "ok", "role": membership.role.value}


@router.delete("/{membership_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_user(
    membership_id: str,
    current_user: CurrentUser = Depends(require_tenant_admin),
    session: AsyncSession = Depends(get_tenant_scoped_session),
) -> None:
    try:
        mid = uuid.UUID(membership_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="membership_id must be a UUID")

    membership = await session.get(UserTenantMembership, mid)
    if not membership:
        raise HTTPException(status_code=404, detail="Membership not found")
    if membership.user_id == current_user.id:
        raise HTTPException(status_code=400, detail="You cannot remove yourself")

    membership.status = MembershipStatus.suspended
    await session.flush()