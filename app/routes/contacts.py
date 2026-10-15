"""Contacts routes.

  POST /contacts/upload   — CSV upload (multipart). ?commit=false for preview.
  GET  /contacts          — paginated directory listing with search/filter.
  GET  /contacts/count    — number of contacts (for "Active Contacts" KPI).

CSV rules (per PM):
  - Required column: `phone` (case-insensitive; also accepts phone_number,
    mobile, whatsapp, number).
  - Optional columns: full_name (or name), segment (or category), branch
    (matched by branch name; ignored if not found).
  - Encoding: UTF-8 only. Non-UTF-8 → 400.
  - Row cap: 10,000.
  - Phone validation: normalize phone numbers to E.164, using Pakistan's
    +92 country code for local numbers without a country code.
  - Duplicates within the upload: first occurrence wins; subsequent rows are
    flagged as duplicates. Active contacts already in the DB are also flagged;
    archived contacts are reactivated.
"""
from __future__ import annotations

import csv
import io
import re
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile, status
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import (
    CurrentUser,
    TenantContext,
    get_active_tenant_context,
    get_current_user,
    get_tenant_scoped_session,
)
from app.models import (
    Branch,
    Contact,
    ContactOptInStatus,
    ContactSource,
    CsvImport,
    CsvImportStatus,
)

router = APIRouter(prefix="/contacts", tags=["contacts"])

MAX_ROWS = 10_000

# Column-name aliases (case-insensitive). First match wins.
_PHONE_ALIASES = {"phone", "phone_number", "phonenumber", "mobile", "whatsapp", "number"}
_NAME_ALIASES = {"name", "full_name", "fullname", "contact_name"}
_SEGMENT_ALIASES = {"segment", "category", "group", "tag"}
_BRANCH_ALIASES = {"branch", "branch_name", "office"}

# ---------------------------------------------------------------------------
# Response models
# ---------------------------------------------------------------------------


class UploadPreviewRow(BaseModel):
    row: int
    phone_e164: str
    full_name: str | None = None
    segment: str | None = None
    branch: str | None = None


class UploadError(BaseModel):
    row: int
    phone_raw: str | None = None
    reason: str


class UploadResponse(BaseModel):
    upload_id: str | None
    total_rows: int
    valid: int
    invalid: int
    skipped_empty: int
    preview_rows: list[UploadPreviewRow]
    errors: list[UploadError]
    committed: bool


class ContactRow(BaseModel):
    id: str
    phone_e164: str
    full_name: str | None
    branch_id: str | None
    branch_name: str | None
    opt_in_status: str
    source: str
    created_at: str


class ContactsListResponse(BaseModel):
    data: list[ContactRow]
    pagination: dict[str, int]


class CountResponse(BaseModel):
    count: int


# ---------------------------------------------------------------------------
# CSV parsing helpers
# ---------------------------------------------------------------------------


def normalize_phone(raw: str | None) -> str | None:
    """Return an E.164 phone string, using Pakistan's country code by default."""
    if raw is None:
        return None
    value = str(raw).strip()
    if not value:
        return None

    has_plus = value.startswith("+")
    digits = re.sub(r"\D", "", value)
    if not digits:
        return None

    if has_plus:
        candidate = "+" + digits
    elif digits.startswith("0"):
        candidate = "+92" + digits[1:]
    elif digits.startswith("92"):
        candidate = "+" + digits
    else:
        candidate = "+" + digits

    body = candidate[1:]
    if len(body) < 10 or len(body) > 15:
        return None
    return candidate


def _find_column(headers: list[str], aliases: set[str]) -> str | None:
    """Return the first header whose lowercased/underscored form matches an alias."""
    for h in headers:
        key = h.strip().lower().replace(" ", "_")
        if key in aliases:
            return h
    return None


async def _parse_csv(
    file_bytes: bytes,
) -> tuple[list[dict], list[UploadError], int, dict[str, str | None]]:
    """Parse CSV bytes into rows + errors + skipped_empty count + column map.

    column_map: {"phone": actual_header, "full_name": actual_header_or_None, ...}
    Returns raw parsed dicts (not yet DB-inserted).
    """
    try:
        text = file_bytes.decode("utf-8")
    except UnicodeDecodeError:
        raise HTTPException(
            status_code=400,
            detail="File must be UTF-8 encoded. Re-export as UTF-8 CSV.",
        )

    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        raise HTTPException(status_code=400, detail="CSV appears empty or has no header row.")

    headers = list(reader.fieldnames)
    phone_col = _find_column(headers, _PHONE_ALIASES)
    if phone_col is None:
        raise HTTPException(
            status_code=400,
            detail="No phone column found. Expected one of: "
            + ", ".join(sorted(_PHONE_ALIASES)),
        )

    column_map = {
        "phone": phone_col,
        "full_name": _find_column(headers, _NAME_ALIASES),
        "segment": _find_column(headers, _SEGMENT_ALIASES),
        "branch": _find_column(headers, _BRANCH_ALIASES),
    }

    rows: list[dict] = []
    errors: list[UploadError] = []
    skipped_empty = 0
    seen_phones: set[str] = set()

    for i, raw_row in enumerate(reader, start=2):  # start=2 because row 1 is the header
        if len(rows) + len(errors) + skipped_empty >= MAX_ROWS:
            errors.append(
                UploadError(row=i, phone_raw=None, reason="row_limit_exceeded")
            )
            break

        # Fully-empty row?
        if not any((v or "").strip() for v in raw_row.values()):
            skipped_empty += 1
            continue

        raw_value = raw_row.get(phone_col)
        phone_raw = (raw_value or "").strip()
        phone = normalize_phone(raw_value)

        if not phone:
            errors.append(UploadError(row=i, phone_raw=phone_raw, reason="invalid_e164"))
            continue

        if phone in seen_phones:
            errors.append(
                UploadError(row=i, phone_raw=phone_raw, reason="duplicate_in_upload")
            )
            continue
        seen_phones.add(phone)

        row: dict[str, Any] = {"row": i, "phone_e164": phone}
        if column_map["full_name"]:
            v = (raw_row.get(column_map["full_name"]) or "").strip()
            row["full_name"] = v or None
        if column_map["segment"]:
            v = (raw_row.get(column_map["segment"]) or "").strip()
            row["segment"] = v or None
        if column_map["branch"]:
            v = (raw_row.get(column_map["branch"]) or "").strip()
            row["branch"] = v or None
        rows.append(row)

    return rows, errors, skipped_empty, column_map


# ---------------------------------------------------------------------------
# POST /contacts/upload
# ---------------------------------------------------------------------------


@router.post(
    "/upload",
    response_model=UploadResponse,
    status_code=status.HTTP_200_OK,
)
async def upload_contacts(
    file: UploadFile = File(..., description="CSV file with a phone column"),
    branch_id: str = Query(
        ...,
        description="UUID of the branch to attach these contacts to. Required.",
    ),
    commit: bool = Query(False, description="False = preview only. True = write to DB."),
    ctx: TenantContext = Depends(get_active_tenant_context),
    current_user: CurrentUser = Depends(get_current_user),
    session: AsyncSession = Depends(get_tenant_scoped_session),
) -> UploadResponse:
    """Parse a CSV, validate every row, return a preview or commit to DB."""
    if not file.filename or not file.filename.lower().endswith((".csv", ".txt")):
        raise HTTPException(status_code=415, detail="File must be a .csv")

    try:
        branch_uuid = uuid.UUID(branch_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="branch_id must be a UUID")

    # Confirm the branch exists in this tenant (RLS enforces tenant-scope)
    branch = await session.get(Branch, branch_uuid)
    if branch is None:
        raise HTTPException(status_code=404, detail="Branch not found in this tenant")

    file_bytes = await file.read()
    if not file_bytes:
        raise HTTPException(status_code=400, detail="File is empty")

    rows, errors, skipped_empty, _cols = await _parse_csv(file_bytes)

    preview = [
        UploadPreviewRow(
            row=r["row"],
            phone_e164=r["phone_e164"],
            full_name=r.get("full_name"),
            segment=r.get("segment"),
            branch=r.get("branch"),
        )
        for r in rows[:10]
    ]

    if not commit:
        return UploadResponse(
            upload_id=None,
            total_rows=len(rows) + len(errors) + skipped_empty,
            valid=len(rows),
            invalid=len(errors),
            skipped_empty=skipped_empty,
            preview_rows=preview,
            errors=errors,
            committed=False,
        )

    # ---- Commit path ----

    # Record the import job first.
    csv_import = CsvImport(
        tenant_id=ctx.tenant_id,
        branch_id=branch_uuid,
        uploaded_by=current_user.id,
        filename=file.filename,
        storage_path=f"inline://{file.filename}",  # we don't archive to blob storage in Phase 1
        status=CsvImportStatus.completed,
        total_rows=len(rows) + len(errors) + skipped_empty,
        valid_rows=len(rows),
        invalid_rows=len(errors),
        error_report={"errors": [e.model_dump() for e in errors]} if errors else None,
    )
    session.add(csv_import)
    await session.flush()

    # Load tenant contacts so archived records can be reactivated instead of duplicated.
    existing_result = await session.execute(
        select(Contact).where(Contact.tenant_id == ctx.tenant_id)
    )
    existing_contacts = {
        contact.phone_e164: contact for contact in existing_result.scalars().all()
    }

    valid = 0
    duplicate_in_db = 0
    for r in rows:
        existing = existing_contacts.get(r["phone_e164"])
        if existing is not None:
            if existing.is_archived:
                existing.is_archived = False
                if r.get("full_name"):
                    existing.full_name = r["full_name"]
                existing.branch_id = branch_uuid
                if r.get("segment"):
                    existing.custom_fields = {
                        **(existing.custom_fields or {}),
                        "segment": r["segment"],
                    }
                existing.updated_at = datetime.now(timezone.utc)
                valid += 1
                continue

            duplicate_in_db += 1
            errors.append(
                UploadError(
                    row=r["row"],
                    phone_raw=r["phone_e164"],
                    reason="duplicate_in_db",
                )
            )
            continue

        custom_fields: dict[str, Any] = {}
        if r.get("segment"):
            custom_fields["segment"] = r["segment"]

        session.add(
            Contact(
                tenant_id=ctx.tenant_id,
                branch_id=branch_uuid,
                phone_e164=r["phone_e164"],
                full_name=r.get("full_name"),
                opt_in_status=ContactOptInStatus.opted_in,
                source=ContactSource.csv_import,
                custom_fields=custom_fields,
                csv_import_id=csv_import.id,
            )
        )
        valid += 1

    csv_import.valid_rows = valid
    csv_import.invalid_rows = len(errors)
    csv_import.error_report = (
        {"errors": [e.model_dump() for e in errors]} if errors else None
    )

    await session.flush()

    return UploadResponse(
        upload_id=str(csv_import.id),
        total_rows=len(rows) + len(errors) + skipped_empty - duplicate_in_db,
        valid=valid,
        invalid=len(errors),
        skipped_empty=skipped_empty,
        preview_rows=preview,
        errors=errors,
        committed=True,
    )


# ---------------------------------------------------------------------------
# GET /contacts
# ---------------------------------------------------------------------------


@router.get("", response_model=ContactsListResponse)
async def list_contacts(
    search: str | None = Query(None, description="Match phone_e164 or full_name substring"),
    branch_id: str | None = Query(None),
    segment: str | None = Query(None),
    include_archived: bool = Query(False, description="Include archived contacts in results"),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
    _: TenantContext = Depends(get_active_tenant_context),
    session: AsyncSession = Depends(get_tenant_scoped_session),
) -> ContactsListResponse:
    stmt = select(Contact, Branch.name.label("branch_name")).join(
        Branch, Branch.id == Contact.branch_id, isouter=True
    )

    if search:
        like = f"%{search}%"
        stmt = stmt.where(
            (Contact.phone_e164.ilike(like)) | (Contact.full_name.ilike(like))
        )
    if branch_id:
        try:
            stmt = stmt.where(Contact.branch_id == uuid.UUID(branch_id))
        except ValueError:
            raise HTTPException(status_code=422, detail="branch_id must be a UUID")
    if segment:
        stmt = stmt.where(Contact.custom_fields["segment"].astext == segment)

    # Exclude archived contacts by default; allow opt-in via query.
    if not include_archived:
        stmt = stmt.where(Contact.is_archived == False)

    # Total count for pagination
    count_stmt = select(func.count()).select_from(stmt.subquery())
    total = (await session.execute(count_stmt)).scalar_one()

    # Page
    stmt = stmt.order_by(Contact.created_at.desc()).offset(
        (page - 1) * page_size
    ).limit(page_size)
    result = await session.execute(stmt)

    rows: list[ContactRow] = []
    for contact, branch_name in result.all():
        rows.append(
            ContactRow(
                id=str(contact.id),
                phone_e164=contact.phone_e164,
                full_name=contact.full_name,
                branch_id=str(contact.branch_id) if contact.branch_id else None,
                branch_name=branch_name,
                opt_in_status=contact.opt_in_status.value,
                source=contact.source.value,
                created_at=contact.created_at.isoformat(),
            )
        )

    return ContactsListResponse(
        data=rows,
        pagination={"page": page, "page_size": page_size, "total": total},
    )


# ---------------------------------------------------------------------------
# GET /contacts/count
# ---------------------------------------------------------------------------


@router.get("/count", response_model=CountResponse)
async def contacts_count(
    _: TenantContext = Depends(get_active_tenant_context),
    session: AsyncSession = Depends(get_tenant_scoped_session),
) -> CountResponse:
    """Count of contacts for the active tenant — feeds the KPI card."""
    result = await session.execute(select(func.count(Contact.id)))
    return CountResponse(count=result.scalar_one())


# ---------------------------------------------------------------------------
# PATCH /contacts/{contact_id}
# ---------------------------------------------------------------------------


class ContactUpdateRequest(BaseModel):
    full_name: str | None = None
    opt_in_status: ContactOptInStatus | None = None
    custom_fields: dict[str, Any] | None = None


@router.patch("/{contact_id}", response_model=ContactRow)
async def update_contact(
    contact_id: str,
    body: ContactUpdateRequest,
    _: TenantContext = Depends(get_active_tenant_context),
    session: AsyncSession = Depends(get_tenant_scoped_session),
) -> ContactRow:
    try:
        contact_uuid = uuid.UUID(contact_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="contact_id must be a UUID")

    contact = await session.get(Contact, contact_uuid)
    if contact is None:
        raise HTTPException(status_code=404, detail="Contact not found")

    # Only apply fields the caller actually set — partial update semantics
    update_data = body.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(contact, field, value)

    await session.flush()
    await session.refresh(contact)

    branch_name = None
    if contact.branch_id:
        branch = await session.get(Branch, contact.branch_id)
        branch_name = branch.name if branch else None

    return ContactRow(
        id=str(contact.id),
        phone_e164=contact.phone_e164,
        full_name=contact.full_name,
        branch_id=str(contact.branch_id) if contact.branch_id else None,
        branch_name=branch_name,
        opt_in_status=contact.opt_in_status.value,
        source=contact.source.value,
        created_at=contact.created_at.isoformat(),
    )


# ---------------------------------------------------------------------------
# DELETE (archive) /contacts/{contact_id}
# ---------------------------------------------------------------------------


@router.delete("/{contact_id}", status_code=status.HTTP_204_NO_CONTENT)
async def archive_contact(
    contact_id: str,
    _: TenantContext = Depends(get_active_tenant_context),
    session: AsyncSession = Depends(get_tenant_scoped_session),
) -> None:
    """Soft-delete: mark contact as archived. Preserves campaign history."""
    try:
        contact_uuid = uuid.UUID(contact_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="contact_id must be a UUID")

    contact = await session.get(Contact, contact_uuid)
    if contact is None:
        raise HTTPException(status_code=404, detail="Contact not found")

    contact.is_archived = True
    await session.flush()
