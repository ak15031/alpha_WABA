"""Tenant-scoped branch routes."""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import (
    TenantContext,
    get_active_tenant_context,
    get_tenant_scoped_session,
)
from app.models import Branch, BranchStatus, BranchType, UserRole

router = APIRouter(tags=["branches"])


class BranchCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    branch_type: str = Field(default="physical", pattern="^(physical|virtual)$")


class BranchRow(BaseModel):
    id: str
    name: str
    branch_type: str
    status: str


class BranchResponse(BaseModel):
    id: str
    name: str
    branch_type: str


class BranchesListResponse(BaseModel):
    data: list[BranchResponse]


@router.get("/branches", response_model=BranchesListResponse)
async def list_branches(
    ctx: TenantContext = Depends(get_active_tenant_context),
    session: AsyncSession = Depends(get_tenant_scoped_session),
) -> BranchesListResponse:
    """List branches belonging to the active tenant."""
    result = await session.execute(
        select(Branch)
        .where(Branch.tenant_id == ctx.tenant_id)
        .order_by(Branch.name)
    )
    return BranchesListResponse(
        data=[
            BranchResponse(
                id=str(branch.id),
                name=branch.name,
                branch_type=branch.branch_type.value,
            )
            for branch in result.scalars().all()
        ]
    )


@router.post(
    "/branches",
    response_model=BranchRow,
    status_code=status.HTTP_201_CREATED,
)
async def create_branch(
    body: BranchCreateRequest,
    ctx: TenantContext = Depends(get_active_tenant_context),
    session: AsyncSession = Depends(get_tenant_scoped_session),
) -> BranchRow:
    if ctx.role != UserRole.tenant_admin.value and ctx.role != "platform_admin":
        raise HTTPException(status_code=403, detail="Tenant admin required")

    exists = await session.scalar(
        select(Branch).where(
            Branch.tenant_id == ctx.tenant_id,
            Branch.name == body.name,
        )
    )
    if exists:
        raise HTTPException(
            status_code=409,
            detail=f"Branch '{body.name}' already exists",
        )

    branch = Branch(
        tenant_id=ctx.tenant_id,
        name=body.name,
        branch_type=BranchType(body.branch_type),
    )
    session.add(branch)
    await session.flush()

    return BranchRow(
        id=str(branch.id),
        name=branch.name,
        branch_type=branch.branch_type.value,
        status=branch.status.value,
    )


@router.delete(
    "/branches/{branch_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_branch(
    branch_id: str,
    ctx: TenantContext = Depends(get_active_tenant_context),
    session: AsyncSession = Depends(get_tenant_scoped_session),
) -> None:
    if ctx.role != UserRole.tenant_admin.value and ctx.role != "platform_admin":
        raise HTTPException(status_code=403, detail="Tenant admin required")

    try:
        branch_uuid = uuid.UUID(branch_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="branch_id must be a UUID")

    branch = await session.scalar(
        select(Branch).where(
            Branch.id == branch_uuid,
            Branch.tenant_id == ctx.tenant_id,
        )
    )
    if branch is None:
        raise HTTPException(status_code=404, detail="Branch not found")

    remaining = await session.scalar(
        select(func.count(Branch.id)).where(
            Branch.tenant_id == ctx.tenant_id,
            Branch.status == BranchStatus.active,
        )
    )
    if branch.status == BranchStatus.active and remaining is not None and remaining <= 1:
        raise HTTPException(
            status_code=409,
            detail="Cannot delete the last active branch. Create another branch first.",
        )

    branch.status = BranchStatus.archived
    await session.flush()
