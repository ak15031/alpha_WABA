"""Contact group routes.

  GET  /groups              — list groups for the active tenant, with member counts
  POST /groups               — create a group (name, description)
  POST /groups/{id}/upload    — CSV upload: creates or reactivates contacts by phone_e164,
                                 then links them into the group.
  DELETE /groups/{id}/members/{contact_id} — remove one contact from a group

Groups are cross-branch by design — a group can span multiple branches
(e.g. "A-level students" isn't tied to one physical location).
"""
from __future__ import annotations

import csv
import io
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import (
    CurrentUser, TenantContext,
    get_active_tenant_context, get_current_user, get_tenant_scoped_session,
)
from app.models import (
    Branch, Contact, ContactGroup, ContactGroupMember,
    ContactOptInStatus, ContactSource,
)
from app.routes.contacts import normalize_phone

router = APIRouter(prefix="/groups", tags=["groups"])


# ---------------------------------------------------------------------------
# Response / request models
# ---------------------------------------------------------------------------


class GroupResponse(BaseModel):
    id: str
    name: str
    description: str | None
    member_count: int
    created_at: str
    updated_at: str


class GroupsListResponse(BaseModel):
    data: list[GroupResponse]


class GroupCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    description: str | None = None


class GroupUploadError(BaseModel):
    row: int
    phone_raw: str | None = None
    reason: str


class GroupUploadResponse(BaseModel):
    group_id: str
    total_rows: int
    matched: int
    created: int
    reactivated: int
    already_member: int
    errors: list[GroupUploadError]
    committed: bool


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


_PHONE_ALIASES = {"phone", "phone_number", "phonenumber", "mobile", "whatsapp", "number"}
_NAME_ALIASES = {"name", "full_name", "fullname", "contact_name"}


# ---------------------------------------------------------------------------
# GET /groups
# ---------------------------------------------------------------------------


@router.get("", response_model=GroupsListResponse)
async def list_groups(
    _: TenantContext = Depends(get_active_tenant_context),
    session: AsyncSession = Depends(get_tenant_scoped_session),
) -> GroupsListResponse:
    stmt = (
        select(
            ContactGroup,
            func.count(ContactGroupMember.contact_id).label("member_count"),
        )
        .outerjoin(ContactGroupMember, ContactGroupMember.group_id == ContactGroup.id)
        .group_by(ContactGroup.id)
        .order_by(ContactGroup.name)
    )
    result = await session.execute(stmt)
    return GroupsListResponse(
        data=[
            GroupResponse(
                id=str(g.id),
                name=g.name,
                description=g.description,
                member_count=count,
                created_at=g.created_at.isoformat(),
                updated_at=g.updated_at.isoformat(),
            )
            for g, count in result.all()
        ]
    )


# ---------------------------------------------------------------------------
# POST /groups
# ---------------------------------------------------------------------------


@router.post("", response_model=GroupResponse, status_code=status.HTTP_201_CREATED)
async def create_group(
    body: GroupCreateRequest,
    ctx: TenantContext = Depends(get_active_tenant_context),
    session: AsyncSession = Depends(get_tenant_scoped_session),
) -> GroupResponse:
    existing = await session.scalar(
        select(ContactGroup).where(
            ContactGroup.tenant_id == ctx.tenant_id,
            ContactGroup.name == body.name,
        )
    )
    if existing is not None:
        raise HTTPException(status_code=409, detail="A group with this name already exists")

    group = ContactGroup(
        tenant_id=ctx.tenant_id,
        name=body.name,
        description=body.description,
    )
    session.add(group)
    await session.flush()
    await session.refresh(group)
    return GroupResponse(
        id=str(group.id),
        name=group.name,
        description=group.description,
        member_count=0,
        created_at=group.created_at.isoformat(),
        updated_at=group.updated_at.isoformat(),
    )


# ---------------------------------------------------------------------------
# POST /groups/{id}/upload
# ---------------------------------------------------------------------------


@router.post("/{group_id}/upload", response_model=GroupUploadResponse)
async def upload_to_group(
    group_id: str,
    file: UploadFile = File(..., description="CSV or plain-text list with phones"),
    branch_id: str = Query(
        ...,
        description="Branch to attach any NEW contacts to. Required.",
    ),
    commit: bool = Query(False),
    ctx: TenantContext = Depends(get_active_tenant_context),
    current_user: CurrentUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_tenant_scoped_session),
) -> GroupUploadResponse:
    """Upload phones into a group, creating or reactivating contacts as needed.

    Mirrors /contacts/upload so contacts do not need to be pre-populated.
    """
    try:
        group_uuid = uuid.UUID(group_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="group_id must be a UUID")
    try:
        branch_uuid = uuid.UUID(branch_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="branch_id must be a UUID")

    group = await session.get(ContactGroup, group_uuid)
    if group is None:
        raise HTTPException(status_code=404, detail="Group not found")

    branch = await session.get(Branch, branch_uuid)
    if branch is None:
        raise HTTPException(status_code=404, detail="Branch not found in this tenant")

    file_bytes = await file.read()
    if not file_bytes:
        raise HTTPException(status_code=400, detail="File is empty")

    try:
        text_content = file_bytes.decode("utf-8")
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="File must be UTF-8 encoded")

    lines = [ln.strip() for ln in text_content.splitlines() if ln.strip()]
    first_line_lower = lines[0].lower() if lines else ""
    phone_col_present = any(
        header in first_line_lower
        for header in ("phone", "mobile", "number", "whatsapp")
    )

    rows: list[dict[str, Any]] = []
    errors: list[GroupUploadError] = []
    seen: set[str] = set()

    if phone_col_present:
        reader = csv.DictReader(io.StringIO(text_content))
        fieldnames = reader.fieldnames or []
        phone_key = next(
            (
                header for header in fieldnames
                if header.strip().lower().replace(" ", "_") in _PHONE_ALIASES
            ),
            None,
        )
        if phone_key is None:
            raise HTTPException(status_code=400, detail="No phone column found")
        name_key = next(
            (
                header for header in fieldnames
                if header.strip().lower().replace(" ", "_") in _NAME_ALIASES
            ),
            None,
        )
        for row_number, raw_row in enumerate(reader, start=2):
            raw_phone = (raw_row.get(phone_key) or "").strip()
            phone = normalize_phone(raw_phone)
            if not phone:
                errors.append(
                    GroupUploadError(row=row_number, phone_raw=raw_phone, reason="invalid_e164")
                )
                continue
            if phone in seen:
                errors.append(
                    GroupUploadError(
                        row=row_number, phone_raw=raw_phone, reason="duplicate_in_upload"
                    )
                )
                continue
            seen.add(phone)
            name = (raw_row.get(name_key) or "").strip() if name_key else None
            rows.append(
                {
                    "row": row_number,
                    "phone_raw": raw_phone,
                    "phone_e164": phone,
                    "full_name": name,
                }
            )
    else:
        for row_number, raw_phone in enumerate(lines, start=1):
            phone = normalize_phone(raw_phone)
            if not phone:
                errors.append(
                    GroupUploadError(
                        row=row_number, phone_raw=raw_phone, reason="invalid_e164"
                    )
                )
                continue
            if phone in seen:
                errors.append(
                    GroupUploadError(
                        row=row_number, phone_raw=raw_phone, reason="duplicate_in_upload"
                    )
                )
                continue
            seen.add(phone)
            rows.append(
                {
                    "row": row_number,
                    "phone_raw": raw_phone,
                    "phone_e164": phone,
                    "full_name": None,
                }
            )

    valid_phones = [row["phone_e164"] for row in rows]
    existing_contacts: dict[str, Contact] = {}
    if valid_phones:
        existing_result = await session.execute(
            select(Contact).where(Contact.phone_e164.in_(valid_phones))
        )
        existing_contacts = {
            contact.phone_e164: contact for contact in existing_result.scalars().all()
        }

    matched = sum(
        1 for row in rows
        if (contact := existing_contacts.get(row["phone_e164"])) is not None
        and not getattr(contact, "is_archived", False)
    )
    reactivated = sum(
        1 for row in rows
        if (contact := existing_contacts.get(row["phone_e164"])) is not None
        and getattr(contact, "is_archived", False)
    )
    created = sum(1 for row in rows if row["phone_e164"] not in existing_contacts)

    if not commit:
        return GroupUploadResponse(
            group_id=str(group.id),
            total_rows=len(rows) + len(errors),
            matched=matched,
            created=created,
            reactivated=reactivated,
            already_member=0,
            errors=errors,
            committed=False,
        )

    # ---- Commit path ----
    existing_members_result = await session.execute(
        select(ContactGroupMember.contact_id).where(ContactGroupMember.group_id == group_uuid)
    )
    existing_member_ids: set[uuid.UUID] = {
        row[0] for row in existing_members_result.all()
    }

    already_member = 0
    for row in rows:
        contact = existing_contacts.get(row["phone_e164"])
        if contact is None:
            contact = Contact(
                tenant_id=ctx.tenant_id,
                branch_id=branch_uuid,
                phone_e164=row["phone_e164"],
                full_name=row["full_name"],
                opt_in_status=ContactOptInStatus.opted_in,
                source=ContactSource.csv_import,
                custom_fields={},
            )
            session.add(contact)
            await session.flush()
            existing_contacts[row["phone_e164"]] = contact
        elif getattr(contact, "is_archived", False):
            contact.is_archived = False
            if row["full_name"]:
                contact.full_name = row["full_name"]
            contact.branch_id = branch_uuid
            contact.updated_at = datetime.now(timezone.utc)

        if contact.id in existing_member_ids:
            already_member += 1
        else:
            session.add(ContactGroupMember(group_id=group_uuid, contact_id=contact.id))
            existing_member_ids.add(contact.id)

    await session.flush()

    return GroupUploadResponse(
        group_id=str(group.id),
        total_rows=len(rows) + len(errors),
        matched=matched,
        created=created,
        reactivated=reactivated,
        already_member=already_member,
        errors=errors,
        committed=True,
    )


# ---------------------------------------------------------------------------
# DELETE /groups/{id}/members/{contact_id}
# ---------------------------------------------------------------------------


@router.delete("/{group_id}/members/{contact_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_group_member(
    group_id: str,
    contact_id: str,
    _: TenantContext = Depends(get_active_tenant_context),
    session: AsyncSession = Depends(get_tenant_scoped_session),
) -> None:
    try:
        group_uuid = uuid.UUID(group_id)
        contact_uuid = uuid.UUID(contact_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="IDs must be UUIDs")

    member = await session.get(ContactGroupMember, {"group_id": group_uuid, "contact_id": contact_uuid})
    if member is None:
        raise HTTPException(status_code=404, detail="Membership not found")

    await session.delete(member)
    await session.flush()


@router.delete("/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_group(
    group_id: str,
    _: TenantContext = Depends(get_active_tenant_context),
    session: AsyncSession = Depends(get_tenant_scoped_session),
) -> None:
    """Hard delete a group. Memberships cascade; contacts are untouched."""
    try:
        group_uuid = uuid.UUID(group_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="group_id must be a UUID")

    group = await session.get(ContactGroup, group_uuid)
    if group is None:
        raise HTTPException(status_code=404, detail="Group not found")

    await session.execute(
        delete(ContactGroupMember).where(ContactGroupMember.group_id == group_uuid)
    )
    await session.delete(group)
    await session.flush()