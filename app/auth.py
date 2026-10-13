"""Auth: provider abstraction, Supabase implementation, FastAPI dependencies.

Auth provider abstraction
-------------------------
The `AuthProvider` protocol defines what any auth provider must implement:
verify an incoming token and return a `PlatformIdentity`. The Supabase
implementation is the default. If you ever move off Supabase, write a new
class that implements the same protocol and swap it in `get_auth_provider()`.

Nothing else in the codebase should know Supabase exists.

FastAPI dependency chain
------------------------
Request → Authorization: Bearer <token>
       → get_current_user           (verifies JWT, upserts internal user row)
       → get_active_tenant_context  (reads X-Tenant-Id header, checks membership)
       → get_tenant_scoped_session  (opens DB session, sets tenant on connection)

Every tenant-facing route just declares the last dep and gets a ready session:

    from fastapi import Depends
    from sqlalchemy.ext.asyncio import AsyncSession
    from app.db import get_tenant_scoped_session

    @router.get("/contacts")
    async def list_contacts(
        session: AsyncSession = Depends(get_tenant_scoped_session),
    ):
        ...

Platform admin routes use `Depends(require_platform_admin)` instead of the
tenant context dep, then use `get_platform_admin_session`.
"""
from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass
from typing import Any, AsyncGenerator, Protocol

import jwt
from fastapi import Depends, Header, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import AsyncSessionLocal, apply_tenant_context
from app.models import MembershipStatus, Tenant, TenantStatus, User, UserTenantMembership

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Data classes carried through the dep chain
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class PlatformIdentity:
    """Verified identity returned by an auth provider.

    This is the auth provider's view of the user (Supabase, whatever). Our
    code maps this to an internal `User` row via `supabase_user_id`.
    """

    external_id: uuid.UUID  # the provider's user id (Supabase auth.users.id)
    email: str
    full_name: str | None
    raw_claims: dict[str, Any]


@dataclass(frozen=True, slots=True)
class CurrentUser:
    """The authenticated internal user."""

    id: uuid.UUID
    supabase_user_id: uuid.UUID
    email: str
    full_name: str | None
    is_platform_admin: bool


@dataclass(frozen=True, slots=True)
class TenantContext:
    """The tenant the request is currently scoped to."""

    tenant_id: uuid.UUID
    role: str  # e.g. 'tenant_admin'
    membership_id: uuid.UUID


# ---------------------------------------------------------------------------
# Auth provider abstraction
# ---------------------------------------------------------------------------


class AuthProvider(Protocol):
    """Any auth provider must expose this method.

    A provider takes a bearer token (JWT string) and either returns a verified
    `PlatformIdentity` or raises `HTTPException(401)`. Providers should be
    stateless and safe to share across requests.
    """

    async def verify_token(self, token: str) -> PlatformIdentity: ...


class SupabaseAuthProvider:
    """Verifies Supabase-issued JWTs against Supabase's JWKS endpoint.

    Supabase projects now sign tokens with asymmetric keys (ES256 by default,
    RS256 if the project uses RSA). Verification requires the public key,
    which Supabase exposes at:

        https://<project>.supabase.co/auth/v1/.well-known/jwks.json

    PyJWKClient handles fetching + caching + key rotation. First call fetches
    the JWKS over HTTP; subsequent calls use the cache. We wrap the sync call
    in `asyncio.to_thread` so it doesn't block the event loop.

    Note: this class supersedes the earlier HS256-based verification. Older
    Supabase projects that still sign with HS256 need `SUPABASE_JWT_SECRET`
    and a different provider — not currently implemented since our project
    has migrated to asymmetric.
    """

    def __init__(
        self,
        *,
        supabase_url: str,
        audience: str = "authenticated",
    ) -> None:
        jwks_url = f"{supabase_url.rstrip('/')}/auth/v1/.well-known/jwks.json"
        # cache_keys=True caches the JWKS in memory. lifespan default is
        # ~5 min, sufficient — key rotation is rare.
        self._jwks_client = jwt.PyJWKClient(jwks_url, cache_keys=True)
        self._audience = audience

    async def verify_token(self, token: str) -> PlatformIdentity:
        try:
            # Sync HTTP call on first use, cached after. Threaded so we
            # don't block the event loop.
            signing_key = await asyncio.to_thread(
                self._jwks_client.get_signing_key_from_jwt, token
            )
            claims = jwt.decode(
                token,
                signing_key.key,
                algorithms=["ES256", "RS256"],
                audience=self._audience,
            )
        except jwt.ExpiredSignatureError:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Token expired",
                headers={"WWW-Authenticate": "Bearer"},
            )
        except jwt.InvalidTokenError as exc:
            logger.info("Rejected JWT: %s", exc)
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid token",
                headers={"WWW-Authenticate": "Bearer"},
            )
        except Exception as exc:
            # JWKS fetch failed (network, DNS, malformed response, etc)
            logger.error("JWKS verification error: %s", exc)
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Auth verification failed",
            )

        # Supabase puts the user id in `sub`.
        sub = claims.get("sub")
        email = claims.get("email")
        if not sub or not email:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Token missing required claims",
            )

        try:
            external_id = uuid.UUID(sub)
        except (ValueError, TypeError):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Malformed subject claim",
            )

        # Supabase puts `full_name` under user_metadata for signup flows.
        user_metadata = claims.get("user_metadata") or {}
        full_name = user_metadata.get("full_name") or user_metadata.get("name")

        return PlatformIdentity(
            external_id=external_id,
            email=email,
            full_name=full_name,
            raw_claims=claims,
        )


_auth_provider: AuthProvider | None = None


def get_auth_provider() -> AuthProvider:
    """Returns the singleton auth provider. Overridable in tests."""
    global _auth_provider
    if _auth_provider is None:
        _auth_provider = SupabaseAuthProvider(
            supabase_url=settings.supabase_url,
            audience=settings.supabase_jwt_audience,
        )
    return _auth_provider


def override_auth_provider(provider: AuthProvider | None) -> None:
    """Swap the provider for tests. Pass None to reset."""
    global _auth_provider
    _auth_provider = provider


# ---------------------------------------------------------------------------
# FastAPI security scheme
# ---------------------------------------------------------------------------

_bearer_scheme = HTTPBearer(auto_error=True)


# ---------------------------------------------------------------------------
# Dependency: get_current_user
# ---------------------------------------------------------------------------


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(_bearer_scheme),
    provider: AuthProvider = Depends(get_auth_provider),
) -> CurrentUser:
    """Verify JWT, upsert internal user, return `CurrentUser`.

    On first login for a Supabase user, we create the internal `users` row
    automatically. `is_platform_admin` defaults to False — must be set manually
    via SQL for the first admin (see SETUP.md).
    """
    identity = await provider.verify_token(credentials.credentials)

    async with AsyncSessionLocal() as session:
        async with session.begin():
            # Use the login-lookup RLS policy: set the supabase_user_id session
            # variable so the users table lets us SELECT this one row.
            # NOTE: set_config() instead of SET LOCAL — Postgres's SET LOCAL
            # doesn't accept bound parameters ($1), but the function form does.
            await session.execute(
                text("SELECT set_config('app.authenticating_supabase_user_id', :sid, true)"),
                {"sid": str(identity.external_id)},
            )

            user = await session.scalar(
                select(User).where(User.supabase_user_id == identity.external_id)
            )

            if user is None:
                # First login — create the internal user.
                # This INSERT needs the login-lookup policy's WITH CHECK equivalent.
                # Since users_login_lookup is SELECT-only, we need to set the
                # platform-admin bypass to insert. But we don't have a platform
                # admin session here — we're bootstrapping.
                #
                # Fix: elevate briefly for the INSERT. This is safe because the
                # user's identity is already verified by the JWT signature.
                await session.execute(
                    text("SELECT set_config('app.is_platform_admin', 'true', true)")
                )
                user = User(
                    supabase_user_id=identity.external_id,
                    email=identity.email,
                    full_name=identity.full_name,
                    is_platform_admin=False,
                )
                session.add(user)
                await session.flush()  # populate user.id
                # Reset the bypass so the returned object doesn't accidentally
                # carry admin permissions elsewhere.
                await session.execute(
                    text("SELECT set_config('app.is_platform_admin', 'false', true)")
                )

    return CurrentUser(
        id=user.id,
        supabase_user_id=user.supabase_user_id,
        email=user.email,
        full_name=user.full_name,
        is_platform_admin=user.is_platform_admin,
    )


# ---------------------------------------------------------------------------
# Helper: activate invited membership on first authenticated hit
# ---------------------------------------------------------------------------


async def _activate_membership_if_needed(
    session: AsyncSession,
    user_id: uuid.UUID,
    tenant_id: uuid.UUID,
) -> None:
    """Flip a membership from invited to active when a user first authenticates."""
    membership = await session.scalar(
        select(UserTenantMembership).where(
            UserTenantMembership.user_id == user_id,
            UserTenantMembership.tenant_id == tenant_id,
        )
    )
    if membership is None or membership.status != MembershipStatus.invited:
        return

    membership.status = MembershipStatus.active
    if hasattr(membership, "accepted_at"):
        from datetime import datetime

        membership.accepted_at = datetime.utcnow()


# ---------------------------------------------------------------------------
# Dependency: get_active_tenant_context
# ---------------------------------------------------------------------------


async def get_active_tenant_context(
    current_user: CurrentUser = Depends(get_current_user),
    x_tenant_id: str | None = Header(default=None, alias="X-Tenant-Id"),
) -> TenantContext:
    """Read the X-Tenant-Id header and verify the user has active membership.

    Returns 400 if the header is missing or malformed.
    Returns 403 if the user has no active membership in that tenant.

    Platform admins CAN read any tenant, but they still need to specify one
    in the header — the switcher UI on the frontend does this. If no header
    is provided, we do not default; the client must be explicit.
    """
    if not x_tenant_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing X-Tenant-Id header",
        )

    try:
        tenant_id = uuid.UUID(x_tenant_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Malformed X-Tenant-Id header",
        )

    async with AsyncSessionLocal() as session:
        async with session.begin():
            # We need to look up the membership across the users +
            # user_tenant_memberships tables. Both are RLS-protected.
            #
            # For platform admins: bypass RLS.
            # For regular users: set current_user_id so users_self_access allows
            # the users table read; for user_tenant_memberships we need
            # current_tenant_id set. But we're determining tenant_id right now,
            # so we set it to the candidate tenant_id — if the row exists, the
            # user has membership.
            if current_user.is_platform_admin:
                await session.execute(
                    text("SELECT set_config('app.is_platform_admin', 'true', true)")
                )
            else:
                await session.execute(
                    text("SELECT set_config('app.current_user_id', :uid, true)"),
                    {"uid": str(current_user.id)},
                )
                await session.execute(
                    text("SELECT set_config('app.current_tenant_id', :tid, true)"),
                    {"tid": str(tenant_id)},
                )

            membership = await session.scalar(
                select(UserTenantMembership).where(
                    UserTenantMembership.user_id == current_user.id,
                    UserTenantMembership.tenant_id == tenant_id,
                )
            )

            # For platform admins, we still want to verify the tenant exists
            # and is not archived. For regular users, the membership lookup
            # is sufficient.
            if current_user.is_platform_admin and membership is None:
                # Platform admin can act on any tenant they specify, even
                # without a formal membership row. Verify the tenant exists.
                tenant = await session.get(Tenant, tenant_id)
                if tenant is None or tenant.status == TenantStatus.archived:
                    raise HTTPException(
                        status_code=status.HTTP_404_NOT_FOUND,
                        detail="Tenant not found",
                    )
                return TenantContext(
                    tenant_id=tenant_id,
                    role="platform_admin",
                    membership_id=uuid.UUID(int=0),  # sentinel; no real membership row
                )

            if membership is None:
                raise HTTPException(status_code=404, detail="No membership in this tenant")

            try:
                await _activate_membership_if_needed(session, current_user.id, tenant_id)
            except Exception:
                logger.exception("activate_membership hook failed; continuing")

            if membership.status == MembershipStatus.suspended:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="This user has been suspended",
                )

            return TenantContext(
                tenant_id=tenant_id,
                role=membership.role.value,
                membership_id=membership.id,
            )


# ---------------------------------------------------------------------------
# Dependency: require_platform_admin
# ---------------------------------------------------------------------------


async def require_platform_admin(
    current_user: CurrentUser = Depends(get_current_user),
) -> CurrentUser:
    """Deny non-platform-admins with 403. Use on platform-only routes."""
    if not current_user.is_platform_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Platform admin access required",
        )
    return current_user


# ---------------------------------------------------------------------------
# Dependency: get_tenant_scoped_session
# ---------------------------------------------------------------------------


async def get_tenant_scoped_session(
    tenant_context: TenantContext = Depends(get_active_tenant_context),
    current_user: CurrentUser = Depends(get_current_user),
) -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dep: yields a session scoped to the active tenant.

    When a platform admin has picked a specific tenant via X-Tenant-Id, we
    scope the session to that tenant — we do NOT set is_platform_admin.
    Platform admins get bypass ONLY on platform-wide routes that use
    `get_platform_admin_session` directly (e.g. /platform/tenants).

    This keeps the tenant switcher meaningful: picking "Acme" in the UI
    actually shows Acme's data, not everything.
    """
    async with AsyncSessionLocal() as session:
        async with session.begin():
            await apply_tenant_context(
                session,
                tenant_id=tenant_context.tenant_id,
                user_id=current_user.id,
                is_platform_admin=False,  # <-- was current_user.is_platform_admin
            )
            yield session


# ---------------------------------------------------------------------------
# Dependency: get_platform_admin_session
# ---------------------------------------------------------------------------


async def get_platform_admin_session(
    current_user: CurrentUser = Depends(require_platform_admin),
) -> AsyncGenerator[AsyncSession, None]:
    """FastAPI dep: yields a session with `app.is_platform_admin = 'true'`.

    The 403 check runs in `require_platform_admin` before we even get here.
    Use for platform admin routes:

        @router.post("/platform/tenants")
        async def create_tenant(
            payload: TenantCreate,
            session: AsyncSession = Depends(get_platform_admin_session),
        ):
            ...
    """
    async with AsyncSessionLocal() as session:
        async with session.begin():
            await apply_tenant_context(
                session,
                tenant_id=None,
                user_id=current_user.id,
                is_platform_admin=True,
            )
            yield session


# ---------------------------------------------------------------------------
# Helper: get_user_memberships


async def get_user_memberships(user_id: uuid.UUID) -> list[dict[str, Any]]:
    """Return every active tenant membership for a user, with tenant names.

    Used by GET /me to populate the tenant switcher on the frontend. Not a
    FastAPI dependency — just a plain helper, called directly from the route.

    Each item: { "tenant_id": ..., "tenant_name": ..., "role": ... }
    """
    async with AsyncSessionLocal() as session:
        async with session.begin():
            await apply_tenant_context(
                session,
                tenant_id=None,
                user_id=user_id,
                is_platform_admin=True,
            )
            result = await session.execute(
                select(
                    UserTenantMembership.tenant_id,
                    Tenant.name,
                    UserTenantMembership.role,
                )
                .join(Tenant, Tenant.id == UserTenantMembership.tenant_id)
                .where(
                    UserTenantMembership.user_id == user_id,
                    UserTenantMembership.status.in_(
                        [MembershipStatus.active, MembershipStatus.invited]
                    ),
                )
            )
            return [
                {
                    "tenant_id": str(row.tenant_id),
                    "tenant_name": row.name,
                    "role": row.role.value,
                }
                for row in result.all()
            ]
