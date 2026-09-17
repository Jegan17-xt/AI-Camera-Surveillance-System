"""Module-Based Pricing & Access — the 4 purchasable packages that
replaced the old per-module billing catalog.

A "package" is a `BillableItem` with item_key "package:<key>" and
activation_type "package" (price / yearly_price / enabled / description
live there, so per-company price overrides via
`billable_item_price_overrides` and frozen purchase price via
`subscription_items` / `payment_items` all work unchanged). This module
adds the package composition (`module_package_submodules`), the
Company-Admin self-service checkout, the Super-Admin catalog editing,
and the access resolution that `auth.auth.get_effective_modules` and
`api.ai_config.get_ai_config` consult.

Nothing here ever raises past a returned `(None, error_message)` tuple
for the mutation helpers — same contract as `api.billing.checkout`.
"""

import time
import uuid
from datetime import datetime, timedelta

from sqlalchemy import select, func

from db import get_session
from auth.database import ROLE_COMPANY_ADMIN
from auth.models import (
    BillableItem,
    BillableItemAccess,
    BillableItemPriceOverride,
    BillingConfig,
    ModulePackageSubmodule,
    Payment,
    PaymentItem,
    Subscription,
    SubscriptionItem,
    User,
)

# ---------------------------------------------------------------------------
# Catalog definition — seeded once, then Super-Admin-editable in the DB.
# ---------------------------------------------------------------------------

PACKAGE_CATEGORY = "Module Packages"

# Dashboard / Settings / Subscription & Payment: always available to
# every company, never part of a package, never billed, never lockable.
ALWAYS_INCLUDED_MODULE_KEYS = {"dashboard", "settings", "subscription_payment"}

# The three CustomerAiSetting boolean columns the Security & Detection
# package's sub-toggles drive (see api.ai_config.get_ai_config).
AI_FLAG_SUBMODULE_KEYS = {
    "object_detection_enabled",
    "animal_detection_enabled",
    "fire_detection_enabled",
}

PACKAGE_DEFS = [
    {
        "key": "cameras",
        "name": "Cameras",
        "description": "Camera management, live viewing, normal cameras and site / VPN gateway access.",
        "monthly": 999.0,
        "yearly": 9999.0,
        "submodules": [
            ("camera_management", "module", "Camera Management"),
            ("live_camera", "module", "Live Camera"),
            ("normal_camera", "module", "Normal Camera"),
            ("site_management", "module", "Sites / VPN"),
        ],
    },
    {
        "key": "people",
        "name": "People",
        "description": "Registered persons, unknown-person records and company user management.",
        "monthly": 799.0,
        "yearly": 7999.0,
        "submodules": [
            ("registered_persons", "module", "Registered Persons"),
            ("unknown_persons", "module", "Unknown Persons"),
            ("user_management", "module", "User Management"),
        ],
    },
    {
        "key": "security",
        "name": "Security & Detection",
        "description": "Detection events log plus vehicle, animal and fire / smoke detection with alerts.",
        "monthly": 1499.0,
        "yearly": 14999.0,
        "submodules": [
            ("detection_events", "module", "Detection Events"),
            ("object_detection_enabled", "ai_flag", "Vehicles"),
            ("animal_detection_enabled", "ai_flag", "Animals / Birds"),
            ("fire_detection_enabled", "ai_flag", "Fire / Smoke"),
            ("alerts", "always", "Alerts"),
        ],
    },
    {
        "key": "reports",
        "name": "Reports",
        "description": "Attendance, attendance reports and unknown-person analytics.",
        "monthly": 499.0,
        "yearly": 4999.0,
        "submodules": [
            ("reports", "module", "Reports"),
            ("attendance", "module", "Attendance"),
            ("unknown_person_analytics", "module", "Analytics"),
        ],
    },
]

PACKAGE_KEYS = [p["key"] for p in PACKAGE_DEFS]
PACKAGE_NAMES = {p["key"]: p["name"] for p in PACKAGE_DEFS}
VALID_BILLING_CYCLES = ("Monthly", "Yearly")


def _item_key(package_key):
    return f"package:{package_key}"


def _now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


# ---------------------------------------------------------------------------
# Seeding + one-time migration off the old per-module catalog.
# ---------------------------------------------------------------------------

def init_module_packages_tables():
    """Idempotent. Creates `module_package_submodules` (via
    Base.metadata.create_all in auth.database.init_db), seeds the 4
    package `BillableItem` rows and their sub-module rows, then migrates
    every existing Company Admin so nobody loses access:

      * gives each Company Admin one `subscription_items` row per package
        at a frozen price of 0 (their currently-agreed `subscriptions.amount`
        is left untouched), so `company_module_keys` keeps returning
        everything they can see today;
      * removes the now-obsolete per-module catalog rows
        (`billable_items` / overrides / access for `module:%` keys).
        `payment_items` history is deliberately preserved.
    """

    with get_session() as session:
        existing_item_keys = {row[0] for row in session.execute(select(BillableItem.item_key))}
        existing_sub_pairs = {
            (row[0], row[1])
            for row in session.execute(
                select(ModulePackageSubmodule.package_key, ModulePackageSubmodule.submodule_key)
            )
        }

        for order, pkg in enumerate(PACKAGE_DEFS):
            key = _item_key(pkg["key"])

            if key not in existing_item_keys:
                session.add(
                    BillableItem(
                        item_key=key,
                        category=PACKAGE_CATEGORY,
                        name=pkg["name"],
                        description=pkg["description"],
                        unit_type="flat",
                        monthly_price=pkg["monthly"],
                        yearly_price=pkg["yearly"],
                        enabled=1,
                        display_order=order,
                        activation_type="package",
                        activation_ref=pkg["key"],
                        updated_at=_now(),
                    )
                )

            for sub_order, (sub_key, kind, label) in enumerate(pkg["submodules"]):
                if (pkg["key"], sub_key) not in existing_sub_pairs:
                    session.add(
                        ModulePackageSubmodule(
                            package_key=pkg["key"],
                            submodule_key=sub_key,
                            kind=kind,
                            label=label,
                            enabled=1,
                            display_order=sub_order,
                            updated_at=_now(),
                        )
                    )

        session.flush()

        # --- One-time migration: on the FIRST startup after this feature
        # ships (no "package:*" subscription_items exist anywhere yet),
        # grant every existing Company Admin all 4 packages at a frozen
        # price of 0 so nobody loses access. This must never run again —
        # otherwise a Company Admin who later deliberately dropped a
        # package (or a brand-new company that hasn't bought anything)
        # would be re-granted everything for free on the next restart.
        already_migrated = session.scalar(
            select(SubscriptionItem.id).where(SubscriptionItem.item_key.like("package:%")).limit(1)
        ) is not None

        if not already_migrated:
            company_ids = session.scalars(
                select(User.id).where(User.role == ROLE_COMPANY_ADMIN)
            ).all()

            for company_id in company_ids:
                subscription = session.get(Subscription, company_id)
                cycle = (subscription.billing_cycle if subscription else None) or "Monthly"
                if cycle not in VALID_BILLING_CYCLES:
                    cycle = "Monthly"

                for pkg in PACKAGE_DEFS:
                    session.add(
                        SubscriptionItem(
                            customer_id=company_id,
                            item_key=_item_key(pkg["key"]),
                            quantity=1,
                            unit_price=0,
                            price=0,
                            billing_cycle=cycle,
                        )
                    )

        # --- Migration: drop the obsolete per-module catalog ---
        obsolete_module_item_keys = [
            row[0]
            for row in session.execute(
                select(BillableItem.item_key).where(BillableItem.activation_type == "module")
            )
        ]

        if obsolete_module_item_keys:
            session.query(BillableItem).filter(
                BillableItem.activation_type == "module"
            ).delete(synchronize_session=False)
            session.query(BillableItemPriceOverride).filter(
                BillableItemPriceOverride.item_key.in_(obsolete_module_item_keys)
            ).delete(synchronize_session=False)
            # billable_item_access rows for module keys, and any stale
            # subscription_items pointing at a module key, are harmless
            # once get_effective_modules stops reading them — but clear
            # the subscription_items so `subscriptions.amount` recomputes
            # cleanly later.
            session.query(SubscriptionItem).filter(
                SubscriptionItem.item_key.in_(obsolete_module_item_keys)
            ).delete(synchronize_session=False)

    invalidate()


# ---------------------------------------------------------------------------
# Access resolution — consulted by auth.auth.get_effective_modules and
# api.ai_config.get_ai_config on the request / frame hot paths.
# ---------------------------------------------------------------------------

_cache = {}  # customer_id -> {"packages": set, "at": float}
_CACHE_TTL = 5  # seconds

_submodule_cache = {"map": None, "at": 0.0}
_SUBMODULE_CACHE_TTL = 5


def invalidate(customer_id=None):
    if customer_id is None:
        _cache.clear()
    else:
        _cache.pop(customer_id, None)
    _submodule_cache["map"] = None


def _enabled_package_keys(session):
    return {
        row[0].split(":", 1)[1]
        for row in session.execute(
            select(BillableItem.item_key).where(
                BillableItem.activation_type == "package",
                BillableItem.enabled == 1,
            )
        )
    }


def _submodule_map():
    """{package_key: [{submodule_key, kind, label, enabled}]} — small,
    changes rarely, cached briefly."""

    now = time.time()
    if _submodule_cache["map"] is not None and now - _submodule_cache["at"] < _SUBMODULE_CACHE_TTL:
        return _submodule_cache["map"]

    result = {}
    with get_session() as session:
        rows = session.scalars(
            select(ModulePackageSubmodule).order_by(
                ModulePackageSubmodule.package_key, ModulePackageSubmodule.display_order
            )
        ).all()

    for row in rows:
        result.setdefault(row.package_key, []).append(
            {
                "submodule_key": row.submodule_key,
                "kind": row.kind,
                "label": row.label,
                "enabled": bool(row.enabled),
            }
        )

    _submodule_cache["map"] = result
    _submodule_cache["at"] = now
    return result


def company_package_keys(customer_id):
    """The set of package keys this company currently owns, that are
    still globally enabled, AND that are not locked for this one company
    (per-company BillableItemAccess row with enabled=0). Cheap, cached
    (~5s). `assign_package` / `set_item_access` call `invalidate(customer_id)`
    so a Super-Admin change is reflected within the TTL."""

    if customer_id is None:
        return set()

    now = time.time()
    cached = _cache.get(customer_id)
    if cached is not None and now - cached["at"] < _CACHE_TTL:
        return cached["packages"]

    with get_session() as session:
        owned = {
            row[0].split(":", 1)[1]
            for row in session.execute(
                select(SubscriptionItem.item_key).where(
                    SubscriptionItem.customer_id == customer_id,
                    SubscriptionItem.item_key.like("package:%"),
                )
            )
        }
        enabled = _enabled_package_keys(session)
        access = _company_package_access(session, customer_id)

    company_locked = {key for key, ok in access.items() if not ok}
    packages = (owned & enabled) - company_locked
    _cache[customer_id] = {"packages": packages, "at": now}
    return packages


def company_module_keys(customer_id):
    """Real module_keys unlocked for this company by its owned packages
    (sub-module rows with kind='module' and enabled=1)."""

    owned = company_package_keys(customer_id)
    if not owned:
        return set()

    sub_map = _submodule_map()
    keys = set()
    for package_key in owned:
        for sub in sub_map.get(package_key, []):
            if sub["kind"] == "module" and sub["enabled"]:
                keys.add(sub["submodule_key"])
    return keys


def ai_flag_allowed(customer_id, ai_flag_key):
    """True when this company may run the given detection AI flag —
    i.e. it owns the package that carries the flag and that sub-module
    is globally enabled. Used by api.ai_config.get_ai_config to gate
    object / animal / fire detection without mass DB writes."""

    sub_map = _submodule_map()
    owned = company_package_keys(customer_id)

    for package_key, subs in sub_map.items():
        for sub in subs:
            if sub["submodule_key"] == ai_flag_key and sub["kind"] == "ai_flag":
                return package_key in owned and sub["enabled"]

    # No such sub-module configured -> don't restrict (fail open, matches
    # the "brand-new customer gets the full pipeline" default).
    return True


# ---------------------------------------------------------------------------
# Pricing helpers.
# ---------------------------------------------------------------------------

def _price_field(billing_cycle):
    return "monthly_price" if billing_cycle == "Monthly" else "yearly_price"


def _package_items(session):
    return {
        row.activation_ref: row
        for row in session.scalars(
            select(BillableItem).where(BillableItem.activation_type == "package")
        )
    }


def _overrides_for(session, customer_id):
    return {
        row.item_key: row
        for row in session.scalars(
            select(BillableItemPriceOverride).where(
                BillableItemPriceOverride.customer_id == customer_id
            )
        )
    }


def _company_package_access(session, customer_id):
    """{package_key: enabled_bool} for every package this ONE company has
    an explicit per-company lock row for — the SAME BillableItemAccess
    table (keyed by item_key "package:<key>") the add-on items already
    use (api/billing.py's set_item_access / _access_map_for). A missing
    key means unlocked; callers default missing lookups to True. This is
    per-company and never touches BillableItem.enabled (the global
    Super-Admin toggle) or any price."""

    if customer_id is None:
        return {}

    return {
        row.item_key.split(":", 1)[1]: bool(row.enabled)
        for row in session.scalars(
            select(BillableItemAccess).where(
                BillableItemAccess.customer_id == customer_id,
                BillableItemAccess.item_key.like("package:%"),
            )
        )
    }


def _set_company_package_access(session, customer_id, package_key, enabled):
    """Create/update this company's per-package lock row. enabled=False
    -> the package renders LOCKED for this company only (get_package_catalog's
    `enabled` becomes False, checkout rejects it, company_package_keys drops
    it). enabled=True -> row removed (back to the default unlocked)."""

    item_key = _item_key(package_key)
    row = session.scalar(
        select(BillableItemAccess).where(
            BillableItemAccess.customer_id == customer_id,
            BillableItemAccess.item_key == item_key,
        )
    )

    if enabled:
        if row is not None:
            session.delete(row)
        return

    if row is None:
        row = BillableItemAccess(customer_id=customer_id, item_key=item_key)
        session.add(row)
    row.enabled = 0
    row.updated_at = _now()


def _effective_prices(item, override):
    if override is not None:
        return override.monthly_price, override.yearly_price
    return item.monthly_price, item.yearly_price


def _subscription_items_total(session, customer_id):
    return session.scalar(
        select(func.coalesce(func.sum(SubscriptionItem.price), 0.0)).where(
            SubscriptionItem.customer_id == customer_id
        )
    ) or 0.0


def _recompute_subscription_amount(session, customer_id):
    subscription = session.get(Subscription, customer_id)
    if subscription is not None:
        subscription.amount = float(_subscription_items_total(session, customer_id))
        subscription.updated_at = _now()


# ---------------------------------------------------------------------------
# Super Admin — catalog read / write.
# ---------------------------------------------------------------------------

def get_package_catalog(customer_id=None):
    """Every package with its global price + sub-modules. With
    `customer_id`, also reports that one company's effective price (its
    override if any), ownership, and — separately — whether the package
    is locked FOR THAT COMPANY (per-company BillableItemAccess, set from
    Super Admin -> Customers -> Edit -> Package Access).

    `enabled` is the EFFECTIVE, per-company value the Company Admin's
    Billing & Payment page reads for its RED-lock state:
        enabled = global_enabled AND company_access_enabled
    `global_enabled` (Super Admin's platform-wide toggle) and
    `access_enabled` (this one company's lock) are also returned so the
    Super Admin UI can tell the two cases apart."""

    sub_map = _submodule_map()

    with get_session() as session:
        items = _package_items(session)
        overrides = _overrides_for(session, customer_id) if customer_id is not None else {}
        owned = company_package_keys(customer_id) if customer_id is not None else set()
        access_map = _company_package_access(session, customer_id) if customer_id is not None else {}

        packages = []
        for pkg in PACKAGE_DEFS:
            item = items.get(pkg["key"])
            if item is None:
                continue

            override = overrides.get(_item_key(pkg["key"]))
            eff_monthly, eff_yearly = _effective_prices(item, override)

            global_enabled = bool(item.enabled)
            # Missing lock row -> unlocked (True), same default as add-ons.
            access_enabled = access_map.get(pkg["key"], True)

            packages.append(
                {
                    "package_key": pkg["key"],
                    "name": item.name,
                    "description": item.description or "",
                    "enabled": global_enabled and access_enabled,
                    "global_enabled": global_enabled,
                    "access_enabled": access_enabled,
                    "monthly_price": eff_monthly,
                    "yearly_price": eff_yearly,
                    "global_monthly_price": item.monthly_price,
                    "global_yearly_price": item.yearly_price,
                    "is_override": override is not None,
                    "owned": pkg["key"] in owned,
                    "updated_at": item.updated_at,
                    "submodules": sub_map.get(pkg["key"], []),
                }
            )

        return {"packages": packages}


def update_package(package_key, data):
    if package_key not in PACKAGE_KEYS:
        return None, "Unknown package."

    data = data or {}
    updates = {}

    for field in ("monthly_price", "yearly_price"):
        if field in data:
            try:
                value = float(data[field])
            except (TypeError, ValueError):
                return None, f"{field} must be a number."
            if value < 0:
                return None, f"{field} cannot be negative."
            updates[field] = value

    if "description" in data:
        updates["description"] = (data.get("description") or "").strip() or None

    if "enabled" in data:
        updates["enabled"] = 1 if data["enabled"] else 0

    with get_session() as session:
        item = session.scalar(
            select(BillableItem).where(BillableItem.item_key == _item_key(package_key))
        )
        if item is None:
            return None, "Package not found."

        for field, value in updates.items():
            setattr(item, field, value)
        item.updated_at = _now()

    invalidate()
    return get_package_catalog(), None


def set_submodule_enabled(package_key, submodule_key, enabled):
    with get_session() as session:
        row = session.scalar(
            select(ModulePackageSubmodule).where(
                ModulePackageSubmodule.package_key == package_key,
                ModulePackageSubmodule.submodule_key == submodule_key,
            )
        )
        if row is None:
            return None, "Sub-module not found."

        row.enabled = 1 if enabled else 0
        row.updated_at = _now()

    invalidate()
    return get_package_catalog(), None


def set_package_price_override(customer_id, package_key, monthly_price, yearly_price):
    if package_key not in PACKAGE_KEYS:
        return None, "Unknown package."

    try:
        monthly_price = float(monthly_price)
        yearly_price = float(yearly_price)
    except (TypeError, ValueError):
        return None, "Prices must be numbers."

    if monthly_price < 0 or yearly_price < 0:
        return None, "Prices cannot be negative."

    with get_session() as session:
        if session.scalar(select(User).where(User.id == customer_id, User.role == ROLE_COMPANY_ADMIN)) is None:
            return None, "Company not found."

        row = session.scalar(
            select(BillableItemPriceOverride).where(
                BillableItemPriceOverride.customer_id == customer_id,
                BillableItemPriceOverride.item_key == _item_key(package_key),
            )
        )
        if row is None:
            row = BillableItemPriceOverride(
                customer_id=customer_id, item_key=_item_key(package_key)
            )
            session.add(row)

        row.monthly_price = monthly_price
        row.yearly_price = yearly_price
        row.updated_at = _now()

    return get_package_catalog(customer_id=customer_id), None


def clear_package_price_override(customer_id, package_key):
    with get_session() as session:
        session.query(BillableItemPriceOverride).filter(
            BillableItemPriceOverride.customer_id == customer_id,
            BillableItemPriceOverride.item_key == _item_key(package_key),
        ).delete(synchronize_session=False)

    return get_package_catalog(customer_id=customer_id), None


def assign_package(customer_id, package_key, owned):
    """Super Admin manual grant / revoke — bypasses payment (comp
    accounts, support). Frozen price 0 so it never inflates the agreed
    `subscriptions.amount`."""

    if package_key not in PACKAGE_KEYS:
        return None, "Unknown package."

    with get_session() as session:
        subscription = session.get(Subscription, customer_id)
        cycle = (subscription.billing_cycle if subscription else None) or "Monthly"
        if cycle not in VALID_BILLING_CYCLES:
            cycle = "Monthly"

        row = session.scalar(
            select(SubscriptionItem).where(
                SubscriptionItem.customer_id == customer_id,
                SubscriptionItem.item_key == _item_key(package_key),
            )
        )

        if owned and row is None:
            session.add(
                SubscriptionItem(
                    customer_id=customer_id,
                    item_key=_item_key(package_key),
                    quantity=1,
                    unit_price=0,
                    price=0,
                    billing_cycle=cycle,
                )
            )
        elif not owned and row is not None:
            session.delete(row)

        # Per-company lock, same row the Company Admin's Billing page reads
        # as `enabled` / `access_enabled`. Revoke -> lock this ONE company
        # out ("Locked by Super Admin"); grant -> clear the lock. Never
        # touches BillableItem.enabled (global) or any price, and no other
        # company has a row so none is affected.
        _set_company_package_access(session, customer_id, package_key, bool(owned))

        session.flush()
        _recompute_subscription_amount(session, customer_id)

    invalidate(customer_id)
    _apply_ai_flag_submodules(customer_id)
    return get_package_catalog(customer_id=customer_id), None


# ---------------------------------------------------------------------------
# Company Admin — self-service package view + checkout.
# ---------------------------------------------------------------------------

def get_company_packages(customer_id):
    """What the Company Admin's Subscription & Payment page shows: ALL 4
    packages (Super-Admin-disabled ones included, so the page can render
    them as LOCKED rather than hiding them), this company's effective
    price, ownership, and the sub-modules each one unlocks with each
    sub-module's own enabled/disabled state. The frontend must only let
    an `enabled` package be selected / added to the total — `checkout_packages`
    enforces the same rule server-side."""

    catalog = get_package_catalog(customer_id=customer_id)["packages"]

    with get_session() as session:
        subscription = session.get(Subscription, customer_id)
        billing_cycle = (subscription.billing_cycle if subscription else None) or "Monthly"
        if billing_cycle not in VALID_BILLING_CYCLES:
            billing_cycle = "Monthly"

        config = session.get(BillingConfig, 1)
        tax_percent = config.tax_percent if config else 0

    return {
        "packages": catalog,
        "billing_cycle": billing_cycle,
        "tax_percent": tax_percent,
        "always_included": sorted(ALWAYS_INCLUDED_MODULE_KEYS),
    }


def _apply_ai_flag_submodules(customer_id):
    """Sync the 3 detection AI-flag columns to package ownership — turn a
    flag ON when the company now owns the package carrying it and the
    sub-module is globally enabled, OFF when it doesn't. Runs outside any
    open session (update_ai_config opens its own)."""

    from api.ai_config import update_ai_config  # lazy — avoids import cycle

    sub_map = _submodule_map()
    owned = company_package_keys(customer_id)

    desired = {}
    for package_key, subs in sub_map.items():
        for sub in subs:
            if sub["kind"] != "ai_flag":
                continue
            desired[sub["submodule_key"]] = bool(package_key in owned and sub["enabled"])

    if desired:
        update_ai_config(customer_id, desired)


def checkout_packages(customer_id, package_keys, billing_cycle):
    """The 'Pay Now' action for packages. Server-authoritative on price.
    Simulated gateway — always succeeds. Never raises past (None, error)."""

    if not isinstance(package_keys, list):
        return None, "Selected packages must be provided as a list."

    if billing_cycle not in VALID_BILLING_CYCLES:
        return None, f"Billing Cycle must be one of: {', '.join(VALID_BILLING_CYCLES)}."

    requested = [k for k in package_keys if k in PACKAGE_KEYS]
    price_field = _price_field(billing_cycle)

    with get_session() as session:
        if session.scalar(
            select(User).where(User.id == customer_id, User.role == ROLE_COMPANY_ADMIN)
        ) is None:
            return None, "Company not found."

        items = _package_items(session)
        overrides = _overrides_for(session, customer_id)
        access_map = _company_package_access(session, customer_id)

        # A package is billable only when it is globally enabled AND not
        # locked for this one company (per-company BillableItemAccess).
        selected = [
            k
            for k in requested
            if k in items and items[k].enabled and access_map.get(k, True)
        ]
        if not selected:
            return None, "Select at least one available package."

        line_items = []
        for key in selected:
            item = items[key]
            override = overrides.get(_item_key(key))
            unit_price = getattr(override, price_field) if override is not None else getattr(item, price_field)
            line_items.append(
                {
                    "item_key": _item_key(key),
                    "item_name": item.name,
                    "quantity": 1,
                    "unit_price": unit_price,
                    "price": unit_price,
                }
            )

        config = session.get(BillingConfig, 1)
        tax_percent = config.tax_percent if config else 0

        now = datetime.now()
        due_days = 30 if billing_cycle == "Monthly" else 365
        next_due_date = (now + timedelta(days=due_days)).strftime("%Y-%m-%d")
        transaction_id = f"SIM-{uuid.uuid4().hex[:16]}"

        # Replace ONLY this company's package rows — add-on items
        # (storage / hardware / WhatsApp from api.billing) are left alone.
        session.query(SubscriptionItem).filter(
            SubscriptionItem.customer_id == customer_id,
            SubscriptionItem.item_key.like("package:%"),
        ).delete(synchronize_session=False)

        for li in line_items:
            session.add(
                SubscriptionItem(
                    customer_id=customer_id,
                    item_key=li["item_key"],
                    quantity=1,
                    unit_price=li["unit_price"],
                    price=li["price"],
                    billing_cycle=billing_cycle,
                )
            )

        session.flush()

        subscription = session.get(Subscription, customer_id)
        if subscription is None:
            subscription = Subscription(customer_id=customer_id)
            session.add(subscription)

        # amount == every current subscription_item (packages + any add-ons)
        total_all = _subscription_items_total(session, customer_id)
        subtotal = sum(li["price"] for li in line_items)
        tax_amount = subtotal * tax_percent / 100
        total = subtotal + tax_amount

        subscription.plan_name = " + ".join(PACKAGE_NAMES[k] for k in selected) or "Custom"
        subscription.status = "Active"
        subscription.amount = float(total_all or 0)
        subscription.billing_cycle = billing_cycle
        subscription.next_due_date = next_due_date
        subscription.updated_at = _now()

        payment = Payment(
            customer_id=customer_id,
            amount=total,
            method="Simulated Gateway",
            note=f"{len(line_items)} package(s)",
            paid_on=now.strftime("%Y-%m-%d"),
            created_at=_now(),
            billing_cycle=billing_cycle,
            status="Success",
            transaction_id=transaction_id,
            subtotal=subtotal,
            tax_amount=tax_amount,
        )
        session.add(payment)
        session.flush()

        for li in line_items:
            session.add(
                PaymentItem(
                    payment_id=payment.id,
                    item_key=li["item_key"],
                    item_name=li["item_name"],
                    quantity=1,
                    unit_price=li["unit_price"],
                    price=li["price"],
                )
            )

        payment_id = payment.id

    invalidate(customer_id)
    _apply_ai_flag_submodules(customer_id)

    return {
        "payment": {
            "id": payment_id,
            "amount": total,
            "subtotal": subtotal,
            "tax_amount": tax_amount,
            "billing_cycle": billing_cycle,
            "transaction_id": transaction_id,
            "status": "Success",
            "packages": selected,
            "items": line_items,
        },
    }, None
