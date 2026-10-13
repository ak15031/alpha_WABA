"""Platform admin routes — tenant provisioning and lifecycle."""
from __future__ import annotations

import os
import re
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import (
    CurrentUser, require_platform_admin, get_platform_admin_session,
)
from app.models import (
    Branch, BranchType, PhoneNumber, Tenant, TenantStatus,
    User, UserRole, UserTenantMembership, MembershipStatus,
    Waba, WabaStatus, WabaType,
)
from app.supabase_admin import get_supabase_admin, SupabaseAdminError

router = APIRouter(prefix="/platform", tags=["platform"])


# ---------------------- Schemas ----------------------

_EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_SLUG_RE = re.compile(r"[^a-z0-9]+")


class PhoneNumberIn(BaseModel):
    display_phone_number: str = Field(min_length=4, max_length=32)
    meta_phone_number_id: str = Field(min_length=1, max_length=64)
    is_test_number: bool = False


class BranchIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    branch_type: str = Field(default="physical", pattern="^(physical|virtual)$")


class TenantCreateRequest(BaseModel):
    tenant_name: str = Field(min_length=1, max_length=200)
    admin_email: str
    admin_role: str = Field(default="tenant_admin", pattern="^(tenant_admin)$")

    meta_waba_id: str = Field(min_length=1, max_length=64)
    business_name: str = Field(min_length=1, max_length=200)
    waba_access_token: str | None = None   # None → shared platform token (BYOA otherwise)

    phone_numbers: list[PhoneNumberIn] = Field(min_length=1)
    branches: list[BranchIn] = Field(default_factory=list)   # optional; admin can add later

    @field_validator("admin_email")
    @classmethod
    def _check_email(cls, v: str) -> str:
        v = v.strip().lower()
        if not _EMAIL_RE.match(v):
            raise ValueError("Invalid admin_email format")
        return v

    @field_validator("tenant_name")
    @classmethod
    def _clean_tenant_name(cls, v: str) -> str:
        return v.strip()


class TenantCreateResponse(BaseModel):
    tenant_id: str
    tenant_slug: str
    waba_id: str
    phone_number_ids: list[str]
    branch_ids: list[str]
    admin_user_id: str
    admin_email: str
    invite_status: str


# ---------------------- Helpers ----------------------

def _slugify(name: str) -> str:
    s = _SLUG_RE.sub("-", name.lower()).strip("-")
    return s or "tenant"


async def _unique_slug(session: AsyncSession, base: str) -> str:
    """Append numeric suffix until the slug is unique."""
    candidate = base
    i = 2
    while True:
        exists = await session.scalar(select(Tenant.id).where(Tenant.slug == candidate))
        if exists is None:
            return candidate
        candidate = f"{base}-{i}"
        i += 1


# ---------------------- Endpoint ----------------------

@router.post(
    "/tenants",
    response_model=TenantCreateResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_tenant(
    body: TenantCreateRequest,
    _: CurrentUser = Depends(require_platform_admin),
    session: AsyncSession = Depends(get_platform_admin_session),
) -> TenantCreateResponse:
    """Provision a new tenant end-to-end:
      1. Insert tenant (slug derived from name)
      2. Insert WABA + phone numbers
      3. Insert any provided branches
      4. Supabase invite for first admin → get supabase user_id
      5. Ensure User row + create UserTenantMembership (tenant_admin, invited)
    All in one DB transaction. Supabase invite is best-effort: on failure we
    still complete the tenant provisioning and surface invite_status='failed'
    so you can retry via the Users screen later.
    """
    # 1. Slug + tenant row
    base_slug = _slugify(body.tenant_name)
    tenant_slug = await _unique_slug(session, base_slug)

    tenant = Tenant(name=body.tenant_name, slug=tenant_slug, status=TenantStatus.active)
    session.add(tenant)
    await session.flush()

    # 2. WABA
    waba_type = WabaType.byoa if body.waba_access_token else WabaType.shared
    # Reject duplicate meta_waba_id (unique constraint would raise, but let's 409 cleanly)
    dup = await session.scalar(select(Waba.id).where(Waba.meta_waba_id == body.meta_waba_id))
    if dup is not None:
        raise HTTPException(status_code=409, detail=f"WABA {body.meta_waba_id} already registered")

    waba = Waba(
        tenant_id=tenant.id,
        meta_waba_id=body.meta_waba_id,
        business_name=body.business_name,
        waba_type=waba_type,
        status=WabaStatus.active,
    )
    session.add(waba)
    await session.flush()
    # NOTE: BYOA token storage not in schema yet. For now we accept the field
    # but don't persist it; shared token from env is used at send time.
    # Add an `access_token_enc` column + encryption helper when BYOA ships.

    # 3. Phone numbers
    phone_ids: list[str] = []
    seen_meta_ids: set[str] = set()
    for p in body.phone_numbers:
        if p.meta_phone_number_id in seen_meta_ids:
            raise HTTPException(status_code=422,
                detail=f"duplicate meta_phone_number_id {p.meta_phone_number_id}")
        seen_meta_ids.add(p.meta_phone_number_id)

        dup_p = await session.scalar(
            select(PhoneNumber.id).where(PhoneNumber.meta_phone_number_id == p.meta_phone_number_id)
        )
        if dup_p is not None:
            raise HTTPException(status_code=409,
                detail=f"phone {p.meta_phone_number_id} already registered")

        pn = PhoneNumber(
            tenant_id=tenant.id,
            waba_id=waba.id,
            meta_phone_number_id=p.meta_phone_number_id,
            display_phone_number=p.display_phone_number,
            is_test_number=p.is_test_number,
        )
        session.add(pn)
        await session.flush()
        phone_ids.append(str(pn.id))

    # 4. Optional branches
    branch_ids: list[str] = []
    for b in body.branches:
        br = Branch(
            tenant_id=tenant.id,
            name=b.name,
            branch_type=BranchType(b.branch_type),
        )
        session.add(br)
        await session.flush()
        branch_ids.append(str(br.id))

    # 5. Supabase invite for admin + User row + membership
    frontend_url = os.environ.get("FRONTEND_URL", "")
    if not frontend_url:
        raise HTTPException(status_code=500, detail="FRONTEND_URL not configured")
    redirect_to = f"{frontend_url}/accept-invite"

    admin = get_supabase_admin()
    invite_status = "sent"
    supabase_user_id: str | None = None
    try:
        invited = await admin.invite_by_email(
            email=body.admin_email,
            redirect_to=redirect_to,
            metadata={"tenant_id": str(tenant.id), "role": body.admin_role},
        )
        supabase_user_id = (invited.get("user") or {}).get("id") or invited.get("id")
    except SupabaseAdminError as exc:
        # Tenant/WABA/phones already committed to session; don't roll back,
        # just note the invite failed. Admin can retry via Users screen.
        invite_status = f"failed: {exc}"

    admin_user_id = ""
    if supabase_user_id:
        user_uuid = uuid.UUID(supabase_user_id)
        user_row = await session.scalar(select(User).where(User.supabase_user_id == user_uuid))
        if user_row is None:
            user_row = User(
                supabase_user_id=user_uuid,
                email=body.admin_email,
                full_name=None,
                is_platform_admin=False,
            )
            session.add(user_row)
            await session.flush()
        admin_user_id = str(user_row.id)

        membership = UserTenantMembership(
            tenant_id=tenant.id,
            user_id=user_row.id,
            role=UserRole.tenant_admin,
            status=MembershipStatus.invited,
        )
        session.add(membership)
        await session.flush()

    return TenantCreateResponse(
        tenant_id=str(tenant.id),
        tenant_slug=tenant.slug,
        waba_id=str(waba.id),
        phone_number_ids=phone_ids,
        branch_ids=branch_ids,
        admin_user_id=admin_user_id,
        admin_email=body.admin_email,
        invite_status=invite_status,
    )