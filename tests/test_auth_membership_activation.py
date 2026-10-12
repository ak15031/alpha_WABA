import uuid
from types import SimpleNamespace

import pytest

from app.auth import _activate_membership_if_needed
from app.models import MembershipStatus


@pytest.mark.asyncio
async def test_activate_membership_if_needed_sets_active_and_stamps_accepted_at() -> None:
    user_id = uuid.uuid4()
    tenant_id = uuid.uuid4()
    membership = SimpleNamespace(
        user_id=user_id,
        tenant_id=tenant_id,
        status=MembershipStatus.invited,
        accepted_at=None,
    )

    class FakeSession:
        async def scalar(self, *_args, **_kwargs):
            return membership

    await _activate_membership_if_needed(FakeSession(), user_id, tenant_id)

    assert membership.status == MembershipStatus.active
    assert membership.accepted_at is not None
