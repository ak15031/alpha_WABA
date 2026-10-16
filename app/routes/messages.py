"""Message log routes (Screen 3).

  GET /messages/kpis  — 3 KPI cards (delivered rate, read rate, queue latency)
  GET /messages       — paginated message events with search/filter/sort
  GET /messages/:id   — one message with its raw webhook payloads (drawer view)

Message events are `campaign_recipients` rows — one row per send attempt.
The UI calls them "messages" (per PM/UX vocabulary); the DB calls them
`campaign_recipients`. The route layer translates.

Latency
-------
Per-row latency: (sent_at − queued_at) in ms. Null when either timestamp is
missing (message never got out of the queue, or never entered it).

For the KPI card, avg + p95 are computed at query time via Postgres AVG and
PERCENTILE_CONT — no need to maintain running sums. At Phase 1 volumes this
is cheap on an indexed table.

Raw webhook payloads
--------------------
`webhook_events` intentionally has NO RLS (it's a staging table written before
tenant is resolved). We filter by meta_message_id (globally unique across all
tenants — Meta assigns these) AND by resolved_tenant_id as belt-and-suspenders.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import (
    TenantContext,
    get_active_tenant_context,
    get_tenant_scoped_session,
)
from app.models import (
    Branch,
    Campaign,
    CampaignRecipient,
    RecipientStatus,
    WebhookEvent,
)

router = APIRouter(prefix="/messages", tags=["messages"])


# ---------------------------------------------------------------------------
# Response shapes
# ---------------------------------------------------------------------------


class RateKpi(BaseModel):
    value: float
    trend_pct: float


class LatencyKpi(BaseModel):
    avg: int | None
    p95: int | None


class MessagesKpisResponse(BaseModel):
    delivered_rate: RateKpi
    read_rate: RateKpi
    queue_latency_ms: LatencyKpi
    total_sent: int
    total_delivered: int
    total_read: int
    total_failed: int


class MessageRow(BaseModel):
    id: str
    campaign_id: str
    campaign_name: str
    phone_e164: str
    meta_message_id: str | None
    branch_name: str | None
    status: str
    queued_at: str | None
    sent_at: str | None
    delivered_at: str | None
    read_at: str | None
    failed_at: str | None
    latency_ms: int | None
    error_code: int | None
    error_message: str | None


class Pagination(BaseModel):
    page: int
    page_size: int
    total: int


class MessagesListResponse(BaseModel):
    data: list[MessageRow]
    pagination: Pagination


class WebhookEventPayload(BaseModel):
    id: str
    event_type: str
    received_at: str
    processed_at: str | None
    raw_payload: dict[str, Any]


class MessageDetailResponse(BaseModel):
    message: MessageRow
    webhook_events: list[WebhookEventPayload]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _parse_uuid(value: str, field: str) -> uuid.UUID:
    try:
        return uuid.UUID(value)
    except ValueError:
        raise HTTPException(status_code=422, detail=f"{field} must be a UUID")


def _parse_status(value: str) -> RecipientStatus:
    try:
        return RecipientStatus(value)
    except ValueError:
        raise HTTPException(
            status_code=422,
            detail="status must be one of: "
            + ", ".join(s.value for s in RecipientStatus),
        )


def _resolve_period(
    start_date: date | None, end_date: date | None
) -> tuple[date, date, date, date]:
    end = end_date or date.today()
    start = start_date or (end - timedelta(days=6))
    if start > end:
        raise HTTPException(status_code=422, detail="start_date must be <= end_date")
    period_days = (end - start).days + 1
    prev_end = start - timedelta(days=1)
    prev_start = prev_end - timedelta(days=period_days - 1)
    return start, end, prev_start, prev_end


def _period_start(d: date) -> datetime:
    return datetime.combine(d, datetime.min.time())


def _next_midnight(d: date) -> datetime:
    return datetime.combine(d + timedelta(days=1), datetime.min.time())


def _trend_pct(current: float, previous: float) -> float:
    if previous == 0:
        return 0.0
    return round((current - previous) / previous * 100, 1)


def _latency_ms(sent_at: datetime | None, queued_at: datetime | None) -> int | None:
    if sent_at is None or queued_at is None:
        return None
    return int((sent_at - queued_at).total_seconds() * 1000)


async def _count_between(
    session: AsyncSession,
    column,
    start: date,
    end: date,
    branch_uuid: uuid.UUID | None,
) -> int:
    stmt = (
        select(func.count())
        .select_from(CampaignRecipient)
        .join(Campaign, Campaign.id == CampaignRecipient.campaign_id)
        .where(
            column >= _period_start(start),
            column < _next_midnight(end),
        )
    )
    if branch_uuid is not None:
        stmt = stmt.where(Campaign.branch_id == branch_uuid)
    return (await session.execute(stmt)).scalar_one()


# ---------------------------------------------------------------------------
# GET /messages/kpis
# ---------------------------------------------------------------------------


@router.get("/kpis", response_model=MessagesKpisResponse)
async def messages_kpis(
    branch_id: str | None = Query(None),
    start_date: date | None = Query(None),
    end_date: date | None = Query(None),
    _: TenantContext = Depends(get_active_tenant_context),
    session: AsyncSession = Depends(get_tenant_scoped_session),
) -> MessagesKpisResponse:
    start, end, prev_start, prev_end = _resolve_period(start_date, end_date)
    branch_uuid: uuid.UUID | None = (
        _parse_uuid(branch_id, "branch_id") if branch_id else None
    )

    sent_now = await _count_between(
        session, CampaignRecipient.sent_at, start, end, branch_uuid
    )
    sent_prev = await _count_between(
        session, CampaignRecipient.sent_at, prev_start, prev_end, branch_uuid
    )
    delivered_now = await _count_between(
        session, CampaignRecipient.delivered_at, start, end, branch_uuid
    )
    delivered_prev = await _count_between(
        session, CampaignRecipient.delivered_at, prev_start, prev_end, branch_uuid
    )
    read_now = await _count_between(
        session, CampaignRecipient.read_at, start, end, branch_uuid
    )
    read_prev = await _count_between(
        session, CampaignRecipient.read_at, prev_start, prev_end, branch_uuid
    )
    failed_now = await _count_between(
        session, CampaignRecipient.failed_at, start, end, branch_uuid
    )

    delivered_rate_now = (delivered_now / sent_now) if sent_now else 0.0
    delivered_rate_prev = (delivered_prev / sent_prev) if sent_prev else 0.0
    read_rate_now = (read_now / sent_now) if sent_now else 0.0
    read_rate_prev = (read_prev / sent_prev) if sent_prev else 0.0

    # ---- Latency (avg + p95) via one Postgres query ----
    latency_sql = """
        SELECT
          AVG(EXTRACT(EPOCH FROM (cr.sent_at - cr.queued_at)) * 1000) AS avg_ms,
          PERCENTILE_CONT(0.95) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (cr.sent_at - cr.queued_at)) * 1000
          ) AS p95_ms
        FROM campaign_recipients cr
        JOIN campaigns c ON c.id = cr.campaign_id
        WHERE cr.sent_at IS NOT NULL
          AND cr.queued_at IS NOT NULL
          AND cr.sent_at >= :start
          AND cr.sent_at <  :end_exclusive
    """
    params: dict[str, Any] = {
        "start": _period_start(start),
        "end_exclusive": _next_midnight(end),
    }
    if branch_uuid is not None:
        latency_sql += " AND c.branch_id = :branch_id"
        params["branch_id"] = str(branch_uuid)

    latency_row = (await session.execute(text(latency_sql), params)).first()
    avg_ms = (
        int(latency_row.avg_ms) if latency_row and latency_row.avg_ms is not None else None
    )
    p95_ms = (
        int(latency_row.p95_ms) if latency_row and latency_row.p95_ms is not None else None
    )

    return MessagesKpisResponse(
        delivered_rate=RateKpi(
            value=round(delivered_rate_now, 4),
            trend_pct=_trend_pct(delivered_rate_now, delivered_rate_prev),
        ),
        read_rate=RateKpi(
            value=round(read_rate_now, 4),
            trend_pct=_trend_pct(read_rate_now, read_rate_prev),
        ),
        queue_latency_ms=LatencyKpi(avg=avg_ms, p95=p95_ms),
        total_sent=sent_now,
        total_delivered=delivered_now,
        total_read=read_now,
        total_failed=failed_now,
    )


# ---------------------------------------------------------------------------
# GET /messages
# ---------------------------------------------------------------------------


_SORT_COLUMNS = {
    "sent_at": CampaignRecipient.sent_at,
    "delivered_at": CampaignRecipient.delivered_at,
    "read_at": CampaignRecipient.read_at,
    "queued_at": CampaignRecipient.queued_at,
}


@router.get("", response_model=MessagesListResponse)
async def list_messages(
    search: str | None = Query(
        None,
        description="Substring match against phone_e164 or meta_message_id.",
    ),
    branch_id: str | None = Query(None),
    status_filter: list[str] | None = Query(None, alias="status"),
    campaign_id: str | None = Query(None),
    start_date: date | None = Query(None),
    end_date: date | None = Query(None),
    sort: str = Query("sent_at", pattern="^(sent_at|delivered_at|read_at|queued_at)$"),
    order: str = Query("desc", pattern="^(asc|desc)$"),
    page: int = Query(1, ge=1),
    page_size: int = Query(25, ge=1, le=100),
    _: TenantContext = Depends(get_active_tenant_context),
    session: AsyncSession = Depends(get_tenant_scoped_session),
) -> MessagesListResponse:
    stmt = (
        select(
            CampaignRecipient,
            Campaign.name.label("campaign_name"),
            Branch.name.label("branch_name"),
        )
        .join(Campaign, Campaign.id == CampaignRecipient.campaign_id)
        .outerjoin(Branch, Branch.id == Campaign.branch_id)
    )

    if search:
        like = f"%{search}%"
        stmt = stmt.where(
            (CampaignRecipient.phone_e164.ilike(like))
            | (CampaignRecipient.meta_message_id.ilike(like))
        )
    if branch_id:
        stmt = stmt.where(Campaign.branch_id == _parse_uuid(branch_id, "branch_id"))
    if campaign_id:
        stmt = stmt.where(
            CampaignRecipient.campaign_id == _parse_uuid(campaign_id, "campaign_id")
        )
    if status_filter:
        parsed = [_parse_status(s) for s in status_filter]
        stmt = stmt.where(CampaignRecipient.status.in_(parsed))
    if start_date or end_date:
        start, end, _ps, _pe = _resolve_period(start_date, end_date)
        # Filter on the same column we're sorting by, so paging makes sense.
        col = _SORT_COLUMNS[sort]
        stmt = stmt.where(col >= _period_start(start), col < _next_midnight(end))

    # Total count for pagination BEFORE offset/limit
    count_stmt = select(func.count()).select_from(stmt.subquery())
    total = (await session.execute(count_stmt)).scalar_one()

    sort_col = _SORT_COLUMNS[sort]
    # NULLs LAST when descending; NULLs FIRST for ascending is the default —
    # so a message with no sent_at stays out of the way when sorting by sent_at desc.
    stmt = stmt.order_by(
        sort_col.desc().nulls_last() if order == "desc" else sort_col.asc().nulls_first()
    )
    stmt = stmt.offset((page - 1) * page_size).limit(page_size)

    result = await session.execute(stmt)
    rows: list[MessageRow] = []
    for recipient, campaign_name, branch_name in result.all():
        rows.append(
            MessageRow(
                id=str(recipient.id),
                campaign_id=str(recipient.campaign_id),
                campaign_name=campaign_name,
                phone_e164=recipient.phone_e164,
                meta_message_id=recipient.meta_message_id,
                branch_name=branch_name,
                status=recipient.status.value,
                queued_at=recipient.queued_at.isoformat() if recipient.queued_at else None,
                sent_at=recipient.sent_at.isoformat() if recipient.sent_at else None,
                delivered_at=(
                    recipient.delivered_at.isoformat() if recipient.delivered_at else None
                ),
                read_at=recipient.read_at.isoformat() if recipient.read_at else None,
                failed_at=recipient.failed_at.isoformat() if recipient.failed_at else None,
                latency_ms=_latency_ms(recipient.sent_at, recipient.queued_at),
                error_code=recipient.error_code,
                error_message=recipient.error_message,
            )
        )

    return MessagesListResponse(
        data=rows,
        pagination=Pagination(page=page, page_size=page_size, total=total),
    )


# ---------------------------------------------------------------------------
# GET /messages/:id
# ---------------------------------------------------------------------------


@router.get("/{message_id}", response_model=MessageDetailResponse)
async def get_message(
    message_id: str,
    ctx: TenantContext = Depends(get_active_tenant_context),
    session: AsyncSession = Depends(get_tenant_scoped_session),
) -> MessageDetailResponse:
    """Full detail for one message row, plus every webhook_event that touched it.

    Used by the drawer/modal that opens when the user clicks a log row.
    """
    mid = _parse_uuid(message_id, "message_id")

    # Get the recipient row (RLS scopes to tenant)
    result = await session.execute(
        select(
            CampaignRecipient,
            Campaign.name.label("campaign_name"),
            Branch.name.label("branch_name"),
        )
        .join(Campaign, Campaign.id == CampaignRecipient.campaign_id)
        .outerjoin(Branch, Branch.id == Campaign.branch_id)
        .where(CampaignRecipient.id == mid)
    )
    row = result.first()
    if row is None:
        raise HTTPException(status_code=404, detail="Message not found")

    recipient, campaign_name, branch_name = row

    message = MessageRow(
        id=str(recipient.id),
        campaign_id=str(recipient.campaign_id),
        campaign_name=campaign_name,
        phone_e164=recipient.phone_e164,
        meta_message_id=recipient.meta_message_id,
        branch_name=branch_name,
        status=recipient.status.value,
        queued_at=recipient.queued_at.isoformat() if recipient.queued_at else None,
        sent_at=recipient.sent_at.isoformat() if recipient.sent_at else None,
        delivered_at=(
            recipient.delivered_at.isoformat() if recipient.delivered_at else None
        ),
        read_at=recipient.read_at.isoformat() if recipient.read_at else None,
        failed_at=recipient.failed_at.isoformat() if recipient.failed_at else None,
        latency_ms=_latency_ms(recipient.sent_at, recipient.queued_at),
        error_code=recipient.error_code,
        error_message=recipient.error_message,
    )

    # ---- Webhook events for this message ----
    # webhook_events has no RLS; we filter by meta_message_id (globally unique)
    # AND resolved_tenant_id for defense in depth.
    webhook_events: list[WebhookEventPayload] = []
    if recipient.meta_message_id:
        wh_stmt = (
            select(WebhookEvent)
            .where(WebhookEvent.meta_message_id == recipient.meta_message_id)
            .where(
                (WebhookEvent.resolved_tenant_id == ctx.tenant_id)
                | (WebhookEvent.resolved_tenant_id.is_(None))
            )
            .order_by(WebhookEvent.received_at.asc())
        )
        wh_result = await session.execute(wh_stmt)
        for event in wh_result.scalars().all():
            webhook_events.append(
                WebhookEventPayload(
                    id=str(event.id),
                    event_type=event.event_type,
                    received_at=event.received_at.isoformat(),
                    processed_at=(
                        event.processed_at.isoformat() if event.processed_at else None
                    ),
                    raw_payload=dict(event.raw_payload) if event.raw_payload else {},
                )
            )

    return MessageDetailResponse(message=message, webhook_events=webhook_events)
