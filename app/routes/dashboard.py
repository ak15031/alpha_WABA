"""Dashboard routes (Screen 1).

  GET /dashboard/kpis              — 4 KPI cards with trend % + 7-day sparklines
  GET /dashboard/activity          — sent vs delivered, one point per day
  GET /dashboard/campaign-status   — counts by status for the donut chart
  GET /dashboard/latest-broadcasts — top N most-recent broadcasts

Filters: `branch_id`, `start_date`, `end_date`. All optional; defaults to
all-branches and the last 7 days ending today.

Reads:
- Aggregates (KPI totals, campaign_stats): via `campaign_stats` where possible.
- Per-day time series (sparklines, activity chart): direct queries on
  `campaign_recipients` filtered by tenant + branch + date range. At Phase 1
  scale (~1M rows) this is comfortably indexed via tenant_id + sent_at.
- `active_contacts`: count of opted-in `contacts`.

Trends:
Every trend_pct compares the current period to a previous period of the same
length ending just before the current one starts. If the previous period is
empty, trend_pct is 0.0.
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timedelta
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import cast, func, select
from sqlalchemy.dialects.postgresql import DATE as PG_DATE
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
    CampaignStats,
    CampaignStatus,
    Contact,
    ContactOptInStatus,
)

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


# ---------------------------------------------------------------------------
# Response shapes
# ---------------------------------------------------------------------------


class Period(BaseModel):
    start: str
    end: str


class KpiCard(BaseModel):
    value: float
    trend_pct: float
    sparkline: list[int]


class KpisResponse(BaseModel):
    period: Period
    kpis: dict[str, KpiCard]


class ActivityPoint(BaseModel):
    date: str
    sent: int
    delivered: int


class ActivityResponse(BaseModel):
    series: list[ActivityPoint]


class CampaignStatusResponse(BaseModel):
    counts: dict[str, int]


class LatestBroadcastRow(BaseModel):
    id: str
    name: str
    branch_name: str | None
    status: str
    recipient_count: int
    sent_at: str | None


class LatestBroadcastsResponse(BaseModel):
    data: list[LatestBroadcastRow]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _resolve_period(
    start_date: date | None, end_date: date | None
) -> tuple[date, date, date, date]:
    """Return (start, end, prev_start, prev_end). Inclusive on both ends.

    Defaults to a 7-day window ending today (so 6 days back + today = 7 days).
    The previous period is another 7 days ending the day before `start`.
    """
    end = end_date or date.today()
    start = start_date or (end - timedelta(days=6))
    if start > end:
        raise HTTPException(status_code=422, detail="start_date must be <= end_date")
    period_days = (end - start).days + 1
    prev_end = start - timedelta(days=1)
    prev_start = prev_end - timedelta(days=period_days - 1)
    return start, end, prev_start, prev_end


def _parse_branch(branch_id: str | None) -> uuid.UUID | None:
    if not branch_id:
        return None
    try:
        return uuid.UUID(branch_id)
    except ValueError:
        raise HTTPException(status_code=422, detail="branch_id must be a UUID")


def _trend_pct(current: float, previous: float) -> float:
    """Percent change from previous → current, or 0 if previous is 0.

    Rounded to one decimal place — the UI shows one decimal.
    """
    if previous == 0:
        return 0.0
    return round((current - previous) / previous * 100, 1)


def _fill_series(
    counts_by_day: dict[date, int], start: date, days: int
) -> list[int]:
    """Turn a {day: count} dict into a fixed-length list, filling zeros for
    days that had no rows.
    """
    return [counts_by_day.get(start + timedelta(days=i), 0) for i in range(days)]


def _next_midnight(d: date) -> datetime:
    """00:00 of the day *after* d — used as an exclusive upper bound so we
    include everything from d in a `>= start AND < next_midnight` filter.
    """
    return datetime.combine(d + timedelta(days=1), datetime.min.time())


def _period_start(d: date) -> datetime:
    """00:00 of d — inclusive lower bound."""
    return datetime.combine(d, datetime.min.time())


async def _daily_counts(
    session: AsyncSession,
    column,
    start: date,
    end: date,
    branch_uuid: uuid.UUID | None,
) -> dict[date, int]:
    """SELECT DATE(column), COUNT(*) FROM campaign_recipients JOIN campaigns
    WHERE column BETWEEN start and end (inclusive) AND (branch match)
    GROUP BY DATE(column).
    """
    day = cast(column, PG_DATE).label("day")
    stmt = (
        select(day, func.count().label("cnt"))
        .join(Campaign, Campaign.id == CampaignRecipient.campaign_id)
        .where(
            column >= _period_start(start),
            column < _next_midnight(end),
        )
    )
    if branch_uuid is not None:
        stmt = stmt.where(Campaign.branch_id == branch_uuid)
    stmt = stmt.group_by(day)

    result = await session.execute(stmt)
    return {row.day: row.cnt for row in result.all()}


async def _total_between(
    session: AsyncSession,
    column,
    start: date,
    end: date,
    branch_uuid: uuid.UUID | None,
) -> int:
    """Count campaign_recipients where `column` (sent_at/delivered_at/read_at)
    falls in [start, end] inclusive.
    """
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
# GET /dashboard/kpis
# ---------------------------------------------------------------------------


@router.get("/kpis", response_model=KpisResponse)
async def dashboard_kpis(
    branch_id: str | None = Query(None),
    start_date: date | None = Query(None),
    end_date: date | None = Query(None),
    _: TenantContext = Depends(get_active_tenant_context),
    session: AsyncSession = Depends(get_tenant_scoped_session),
) -> KpisResponse:
    start, end, prev_start, prev_end = _resolve_period(start_date, end_date)
    branch_uuid = _parse_branch(branch_id)
    period_days = (end - start).days + 1

    # ---- Totals for the current and previous periods ----
    sent_current = await _total_between(
        session, CampaignRecipient.sent_at, start, end, branch_uuid
    )
    sent_prev = await _total_between(
        session, CampaignRecipient.sent_at, prev_start, prev_end, branch_uuid
    )
    delivered_current = await _total_between(
        session, CampaignRecipient.delivered_at, start, end, branch_uuid
    )
    delivered_prev = await _total_between(
        session, CampaignRecipient.delivered_at, prev_start, prev_end, branch_uuid
    )
    read_current = await _total_between(
        session, CampaignRecipient.read_at, start, end, branch_uuid
    )
    read_prev = await _total_between(
        session, CampaignRecipient.read_at, prev_start, prev_end, branch_uuid
    )

    # ---- Rates. Guard against div-by-zero when there was no traffic yet. ----
    delivered_rate_current = (delivered_current / sent_current) if sent_current else 0.0
    delivered_rate_prev = (delivered_prev / sent_prev) if sent_prev else 0.0
    read_rate_current = (read_current / sent_current) if sent_current else 0.0
    read_rate_prev = (read_prev / sent_prev) if sent_prev else 0.0

    # ---- Active contacts (snapshot + trend on new-in-period growth) ----
    active_now_stmt = select(func.count()).where(
        Contact.opt_in_status == ContactOptInStatus.opted_in
    )
    if branch_uuid is not None:
        active_now_stmt = active_now_stmt.where(Contact.branch_id == branch_uuid)
    active_now = (await session.execute(active_now_stmt)).scalar_one()

    new_current_stmt = select(func.count()).where(
        Contact.opt_in_status == ContactOptInStatus.opted_in,
        Contact.created_at >= _period_start(start),
        Contact.created_at < _next_midnight(end),
    )
    if branch_uuid is not None:
        new_current_stmt = new_current_stmt.where(Contact.branch_id == branch_uuid)
    new_current = (await session.execute(new_current_stmt)).scalar_one()

    new_prev_stmt = select(func.count()).where(
        Contact.opt_in_status == ContactOptInStatus.opted_in,
        Contact.created_at >= _period_start(prev_start),
        Contact.created_at < _next_midnight(prev_end),
    )
    if branch_uuid is not None:
        new_prev_stmt = new_prev_stmt.where(Contact.branch_id == branch_uuid)
    new_prev = (await session.execute(new_prev_stmt)).scalar_one()

    # ---- Sparklines (one entry per day, oldest first) ----
    sent_by_day = await _daily_counts(
        session, CampaignRecipient.sent_at, start, end, branch_uuid
    )
    delivered_by_day = await _daily_counts(
        session, CampaignRecipient.delivered_at, start, end, branch_uuid
    )
    read_by_day = await _daily_counts(
        session, CampaignRecipient.read_at, start, end, branch_uuid
    )

    # Daily new contacts for active_contacts sparkline
    contact_day = cast(Contact.created_at, PG_DATE).label("day")
    contact_stmt = (
        select(contact_day, func.count().label("cnt"))
        .where(
            Contact.opt_in_status == ContactOptInStatus.opted_in,
            Contact.created_at >= _period_start(start),
            Contact.created_at < _next_midnight(end),
        )
        .group_by(contact_day)
    )
    if branch_uuid is not None:
        contact_stmt = contact_stmt.where(Contact.branch_id == branch_uuid)
    contact_by_day = {
        row.day: row.cnt for row in (await session.execute(contact_stmt)).all()
    }

    return KpisResponse(
        period=Period(start=start.isoformat(), end=end.isoformat()),
        kpis={
            "total_sent": KpiCard(
                value=float(sent_current),
                trend_pct=_trend_pct(sent_current, sent_prev),
                sparkline=_fill_series(sent_by_day, start, period_days),
            ),
            "delivered_rate": KpiCard(
                value=round(delivered_rate_current, 4),
                trend_pct=_trend_pct(delivered_rate_current, delivered_rate_prev),
                sparkline=_fill_series(delivered_by_day, start, period_days),
            ),
            "read_rate": KpiCard(
                value=round(read_rate_current, 4),
                trend_pct=_trend_pct(read_rate_current, read_rate_prev),
                sparkline=_fill_series(read_by_day, start, period_days),
            ),
            "active_contacts": KpiCard(
                value=float(active_now),
                trend_pct=_trend_pct(new_current, new_prev),
                sparkline=_fill_series(contact_by_day, start, period_days),
            ),
        },
    )


# ---------------------------------------------------------------------------
# GET /dashboard/activity
# ---------------------------------------------------------------------------


@router.get("/activity", response_model=ActivityResponse)
async def dashboard_activity(
    branch_id: str | None = Query(None),
    start_date: date | None = Query(None),
    end_date: date | None = Query(None),
    _: TenantContext = Depends(get_active_tenant_context),
    session: AsyncSession = Depends(get_tenant_scoped_session),
) -> ActivityResponse:
    """One point per day: sent count and delivered count.

    Both counts are of events that HAPPENED that day (based on `sent_at`
    and `delivered_at` timestamps), not of messages that ended up in that
    state — so a message sent Monday but delivered Tuesday contributes to
    Monday's sent count and Tuesday's delivered count. That's what the line
    chart on Screen 1 actually visualizes.
    """
    start, end, _prev_start, _prev_end = _resolve_period(start_date, end_date)
    branch_uuid = _parse_branch(branch_id)
    period_days = (end - start).days + 1

    sent_by_day = await _daily_counts(
        session, CampaignRecipient.sent_at, start, end, branch_uuid
    )
    delivered_by_day = await _daily_counts(
        session, CampaignRecipient.delivered_at, start, end, branch_uuid
    )

    series: list[ActivityPoint] = []
    for i in range(period_days):
        d = start + timedelta(days=i)
        series.append(
            ActivityPoint(
                date=d.isoformat(),
                sent=sent_by_day.get(d, 0),
                delivered=delivered_by_day.get(d, 0),
            )
        )
    return ActivityResponse(series=series)


# ---------------------------------------------------------------------------
# GET /dashboard/campaign-status
# ---------------------------------------------------------------------------


@router.get("/campaign-status", response_model=CampaignStatusResponse)
async def dashboard_campaign_status(
    branch_id: str | None = Query(None),
    _: TenantContext = Depends(get_active_tenant_context),
    session: AsyncSession = Depends(get_tenant_scoped_session),
) -> CampaignStatusResponse:
    """Donut chart on Screen 1 — count of campaigns per status.

    Not restricted by date range: the donut shows the current landscape
    ('12 drafts, 87 completed'), not per-period activity.
    """
    branch_uuid = _parse_branch(branch_id)

    stmt = select(Campaign.status, func.count().label("cnt")).group_by(Campaign.status)
    if branch_uuid is not None:
        stmt = stmt.where(Campaign.branch_id == branch_uuid)

    result = await session.execute(stmt)

    # Pre-populate every enum value with 0 so the frontend can render all
    # slices even before any campaign hits that status.
    counts: dict[str, int] = {s.value: 0 for s in CampaignStatus}
    for row in result.all():
        counts[row.status.value] = row.cnt

    return CampaignStatusResponse(counts=counts)


# ---------------------------------------------------------------------------
# GET /dashboard/latest-broadcasts
# ---------------------------------------------------------------------------


@router.get("/latest-broadcasts", response_model=LatestBroadcastsResponse)
async def dashboard_latest_broadcasts(
    limit: int = Query(10, ge=1, le=25),
    branch_id: str | None = Query(None),
    _: TenantContext = Depends(get_active_tenant_context),
    session: AsyncSession = Depends(get_tenant_scoped_session),
) -> LatestBroadcastsResponse:
    """Most-recent broadcasts table on Screen 1.

    `sent_at`: reports `updated_at` for campaigns in `running` state (approx.
    'started at') and NULL for draft/scheduled. Simpler than joining
    campaign_recipients to find the earliest sent_at, and matches how the UI
    labels the column ('Sent At' / '—').
    """
    branch_uuid = _parse_branch(branch_id)

    stmt = (
        select(
            Campaign,
            Branch.name.label("branch_name"),
            CampaignStats.total_recipients,
        )
        .outerjoin(Branch, Branch.id == Campaign.branch_id)
        .outerjoin(CampaignStats, CampaignStats.campaign_id == Campaign.id)
        .order_by(Campaign.created_at.desc())
        .limit(limit)
    )
    if branch_uuid is not None:
        stmt = stmt.where(Campaign.branch_id == branch_uuid)

    result = await session.execute(stmt)
    rows: list[LatestBroadcastRow] = []
    for campaign, branch_name, recipient_count in result.all():
        # 'sent_at' shown as the last transition into a run state, else null
        sent_at = (
            campaign.updated_at.isoformat()
            if campaign.status
            in (CampaignStatus.running, CampaignStatus.completed, CampaignStatus.failed)
            else None
        )
        rows.append(
            LatestBroadcastRow(
                id=str(campaign.id),
                name=campaign.name,
                branch_name=branch_name,
                status=campaign.status.value,
                recipient_count=recipient_count or 0,
                sent_at=sent_at,
            )
        )
    return LatestBroadcastsResponse(data=rows)
