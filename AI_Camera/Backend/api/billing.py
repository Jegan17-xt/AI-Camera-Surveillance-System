"""Project-wide billing & pricing — the general-purpose successor to
the earlier module-only pricing/checkout system. Super Admin owns the
entire catalog (BillableItem) across every category; a Company Admin
can only view enabled items, select what they want, and pay
(api/routes.py's decorators enforce this split, not this module).

Every item's `activation_type` ties it back to something that already
exists in this codebase — a real module grant, a real
NotificationSettings toggle, or (for Camera/Hardware, Storage,
Hosting) nothing at all, since no real limit/quota/cost-metering
exists anywhere in the product for those to unlock. Those three stay
honest, billed lines with no fake enforcement behind them.
"""

import os
import time
import uuid
from datetime import datetime, timedelta

from sqlalchemy import select, func, text

from db import get_session, engine
from auth.database import MODULES, ROLE_COMPANY_ADMIN, ALWAYS_ACTIVE_MODULE_KEYS, get_user_module_keys
from auth.models import (
    BillableItem,
    BillableItemAccess,
    BillableItemPriceOverride,
    BillingConfig,
    Subscription,
    SubscriptionItem,
    Payment,
    PaymentItem,
    User,
    to_dict,
)
from api.permissions import VALID_MODULE_KEYS
from api.notification_settings import update_unknown_alert_settings, update_daily_report_settings
from api.cameras import get_camera_counts_by_customer
from api.subscriptions import list_payments, get_subscription

VALID_BILLING_CYCLES = ("Monthly", "Yearly")
VALID_UNIT_TYPES = ("flat", "per_camera", "per_gb")
VALID_ACTIVATION_TYPES = ("module", "setting_flag", "record_only", "package")

CATEGORY_AI_MODULES = "AI / Camera Modules"
CATEGORY_HARDWARE = "Camera / Hardware"
CATEGORY_STORAGE = "Storage"
CATEGORY_HOSTING = "Hosting / Infrastructure"
CATEGORY_NOTIFICATIONS = "Notifications / Communication"

# The only two real, working NotificationSettings toggles in the whole
# project (confirmed by exhaustive search — see conversation) — a
# setting_flag item with any other activation_ref is simply not
# activatable, by design, rather than guessing at a fake mechanism.
_SETTING_FLAG_UPDATERS = {
    "unknown_alert_enabled": update_unknown_alert_settings,
    "daily_report_enabled": update_daily_report_settings,
}

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# The three real per-customer storage roots this app already writes to
# (dataset/customers, attendance/customers, generated_reports/customers
# — same CUSTOMERS_ROOT/STORAGE_ROOT constants api/unknown.py,
# api/registered.py, api/attendance.py, and reports/daily_report.py
# each already define their own private copy of).
_STORAGE_ROOTS = [
    os.path.join(BASE_DIR, "dataset", "customers"),
    os.path.join(BASE_DIR, "attendance", "customers"),
    os.path.join(BASE_DIR, "generated_reports", "customers"),
]

_storage_cache = {}  # customer_id -> {"gb": float, "checked_at": float}
_STORAGE_CACHE_TTL = 60


def _now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def get_storage_usage_gb(customer_id):
    """Real, measured disk usage for this company — not a fake number.
    Sums actual file sizes under every real per-customer folder this
    app writes to. Cached briefly since walking a folder tree on every
    checkout-context request would be wasteful (same TTL-cache shape
    already used by api/notification_settings.py / api/ai_config.py)."""

    cached = _storage_cache.get(customer_id)
    now = time.time()

    if cached is not None and now - cached["checked_at"] < _STORAGE_CACHE_TTL:
        return cached["gb"]

    total_bytes = 0

    for root in _STORAGE_ROOTS:
        customer_folder = os.path.join(root, str(customer_id))

        if not os.path.isdir(customer_folder):
            continue

        for dirpath, _dirnames, filenames in os.walk(customer_folder):
            for filename in filenames:
                try:
                    total_bytes += os.path.getsize(os.path.join(dirpath, filename))
                except OSError:
                    pass  # file deleted mid-walk, or a permissions blip — never fatal for a display number

    gb = total_bytes / (1024 ** 3)
    _storage_cache[customer_id] = {"gb": gb, "checked_at": now}

    return gb


def _migrate_payments_table():
    """Idempotent — same INFORMATION_SCHEMA-checked ALTER TABLE pattern
    as api/notification_settings.py:init_notification_report_tables().
    `payments` already exists live; billable_items/billing_config/
    subscription_items/payment_items are brand-new (handled by
    Base.metadata.create_all())."""

    with engine.connect() as conn:
        existing = {
            row[0]
            for row in conn.execute(
                text(
                    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS "
                    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments'"
                )
            )
        }

        if "billing_cycle" not in existing:
            conn.execute(text("ALTER TABLE payments ADD COLUMN billing_cycle VARCHAR(20) NULL"))
        if "status" not in existing:
            conn.execute(text("ALTER TABLE payments ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'Success'"))
        if "transaction_id" not in existing:
            conn.execute(text("ALTER TABLE payments ADD COLUMN transaction_id VARCHAR(64) NULL"))
            conn.execute(text("ALTER TABLE payments ADD UNIQUE INDEX idx_payments_transaction_id (transaction_id)"))
        if "subtotal" not in existing:
            conn.execute(text("ALTER TABLE payments ADD COLUMN subtotal FLOAT NULL"))
        if "tax_amount" not in existing:
            conn.execute(text("ALTER TABLE payments ADD COLUMN tax_amount FLOAT NULL"))

        conn.commit()


def init_billing_tables():
    """Idempotent — brand-new tables (handled by Base.metadata.
    create_all() in auth.database.init_db()); this seeds the real
    default catalog (insert-if-item_key-missing, same pattern as
    Permission's own seeding) and the BillingConfig singleton row."""

    _migrate_payments_table()

    with get_session() as session:
        existing_keys = {row[0] for row in session.execute(select(BillableItem.item_key))}

        def _seed(item_key, category, name, description, unit_type, activation_type, activation_ref):
            if item_key in existing_keys:
                return

            session.add(
                BillableItem(
                    item_key=item_key,
                    category=category,
                    name=name,
                    description=description,
                    unit_type=unit_type,
                    monthly_price=0,
                    yearly_price=0,
                    enabled=1,
                    display_order=0,
                    activation_type=activation_type,
                    activation_ref=activation_ref,
                    updated_at=_now(),
                )
            )

        # Per-module billing was replaced by the 4-package model — see
        # api/module_packages.py (init_module_packages_tables seeds the
        # "package:*" BillableItem rows and removes any leftover
        # "module:*" rows from this old catalog). Nothing seeds
        # activation_type="module" items here any more.

        _seed(
            "whatsapp_unknown_alerts", CATEGORY_NOTIFICATIONS, "WhatsApp Unknown Person Alerts",
            "Real-time WhatsApp alert with photo when an unknown person is detected.",
            "flat", "setting_flag", "unknown_alert_enabled",
        )
        _seed(
            "whatsapp_daily_report", CATEGORY_NOTIFICATIONS, "WhatsApp Daily Report",
            "Daily attendance/detection report delivered via WhatsApp.",
            "flat", "setting_flag", "daily_report_enabled",
        )
        _seed(
            "additional_camera", CATEGORY_HARDWARE, "Additional Camera",
            "Priced per camera currently connected to your account.",
            "per_camera", "record_only", None,
        )
        _seed(
            "cloud_storage", CATEGORY_STORAGE, "Cloud Storage",
            "Priced per GB of your account's actual stored data (faces, captures, reports).",
            "per_gb", "record_only", None,
        )
        _seed(
            "platform_hosting", CATEGORY_HOSTING, "Platform Hosting",
            "Flat recurring hosting/infrastructure fee.",
            "flat", "record_only", None,
        )

        if session.get(BillingConfig, 1) is None:
            session.add(BillingConfig(id=1, tax_percent=0, updated_at=_now()))


def _item_to_dict(row, override=None):
    """`override` (a BillableItemPriceOverride row, or None) makes the
    returned monthly_price/yearly_price/yearly_discount_percent/
    updated_at the EFFECTIVE values for one specific company, while
    global_monthly_price/global_yearly_price always stay the catalog's
    own price — so a caller can show "this company pays ₹X (global is
    ₹Y)" without a second request. With override=None (every existing
    caller that doesn't pass a customer_id), behavior is byte-for-byte
    identical to before this parameter existed."""

    if override is not None:
        monthly_price = override.monthly_price
        yearly_price = override.yearly_price
        yearly_discount_percent = override.yearly_discount_percent
        updated_at = override.updated_at
    else:
        monthly_price = row.monthly_price
        yearly_price = row.yearly_price
        yearly_discount_percent = row.yearly_discount_percent
        updated_at = row.updated_at

    return {
        "id": row.id,
        "item_key": row.item_key,
        "category": row.category,
        "name": row.name,
        "description": row.description,
        "unit_type": row.unit_type,
        "monthly_price": monthly_price,
        "yearly_price": yearly_price,
        "yearly_discount_percent": yearly_discount_percent,
        "enabled": bool(row.enabled),
        "display_order": row.display_order,
        "activation_type": row.activation_type,
        "activation_ref": row.activation_ref,
        "updated_at": updated_at,
        "is_override": override is not None,
        "global_monthly_price": row.monthly_price,
        "global_yearly_price": row.yearly_price,
    }


def _access_map_for(session, customer_id):
    """{item_key: enabled_bool} for every non-module item this company
    has an explicit BillableItemAccess row for. A missing key means ON
    (unlocked) — callers must default missing lookups to True."""

    return {
        row.item_key: bool(row.enabled)
        for row in session.scalars(
            select(BillableItemAccess).where(BillableItemAccess.customer_id == customer_id)
        )
    }


def list_billable_items(customer_id=None):
    """Super Admin: the full catalog, every category, enabled or not.
    With `customer_id`, prices reflect that ONE company's overrides
    (api/routes.py's "All Admins" vs. per-Admin scope dropdown) —
    every other company's own overrides are untouched and invisible
    here, exactly like every other per-customer_id query in this app.
    Non-module items also carry `access_enabled` — this ONE company's
    Super-Admin-set ON/OFF lock (see set_item_access()), defaulting to
    True when no lock has ever been set."""

    with get_session() as session:
        rows = session.scalars(
            select(BillableItem)
            .where(BillableItem.activation_type != "package")
            .order_by(BillableItem.category, BillableItem.display_order, BillableItem.name)
        ).all()

        overrides = {}
        access = {}
        if customer_id is not None:
            overrides = {
                row.item_key: row
                for row in session.scalars(
                    select(BillableItemPriceOverride).where(BillableItemPriceOverride.customer_id == customer_id)
                )
            }
            access = _access_map_for(session, customer_id)

        items = []
        for r in rows:
            d = _item_to_dict(r, overrides.get(r.item_key))
            if customer_id is not None and r.activation_type != "module":
                d["access_enabled"] = access.get(r.item_key, True)
            items.append(d)

        return items


def set_item_price_override(customer_id, item_id, monthly_price, yearly_price, yearly_discount_percent=None):
    """Super Admin sets a price for ONE company only — never touches
    the global BillableItem row, never affects any other customer_id's
    own override or lack thereof."""

    try:
        monthly_price = float(monthly_price)
        yearly_price = float(yearly_price)
    except (TypeError, ValueError):
        return None, "Prices must be numbers."

    if monthly_price < 0 or yearly_price < 0:
        return None, "Prices cannot be negative."

    with get_session() as session:
        item = session.get(BillableItem, item_id)

        if item is None:
            return None, "Billing item not found."

        row = session.scalar(
            select(BillableItemPriceOverride).where(
                BillableItemPriceOverride.customer_id == customer_id,
                BillableItemPriceOverride.item_key == item.item_key,
            )
        )

        if row is None:
            row = BillableItemPriceOverride(customer_id=customer_id, item_key=item.item_key)
            session.add(row)

        row.monthly_price = monthly_price
        row.yearly_price = yearly_price
        row.yearly_discount_percent = yearly_discount_percent
        row.updated_at = _now()

    return list_billable_items(customer_id=customer_id), None


def clear_item_price_override(customer_id, item_id):
    """Revert one company back to the global price for this one item."""

    with get_session() as session:
        item = session.get(BillableItem, item_id)

        if item is None:
            return None, "Billing item not found."

        session.query(BillableItemPriceOverride).filter(
            BillableItemPriceOverride.customer_id == customer_id,
            BillableItemPriceOverride.item_key == item.item_key,
        ).delete()

    return list_billable_items(customer_id=customer_id), None


def set_item_access(customer_id, item_id, enabled):
    """Super Admin locks/unlocks ONE non-module billable item for ONE
    company — the same ON/OFF gate a module gets from its own
    permission grant, for the five items (Additional Camera, Platform
    Hosting, WhatsApp Daily Report, WhatsApp Unknown Person Alerts,
    Cloud Storage) that have no grant mechanism of their own.

    Locking takes effect immediately, not just at the next checkout:
    this company's current SubscriptionItem for it is dropped right
    away (so get_checkout_context()'s currently_active and any future
    checkout() both already see it as inactive), and — for a
    setting_flag item — the real toggle behind it (WhatsApp alert/
    report) is turned off too, so the module genuinely cannot be
    active, not merely unbilled."""

    with get_session() as session:
        item = session.get(BillableItem, item_id)

        if item is None:
            return None, "Billing item not found."

        if item.activation_type == "module":
            return None, "Module items use Module Access, not this control."

        row = session.scalar(
            select(BillableItemAccess).where(
                BillableItemAccess.customer_id == customer_id,
                BillableItemAccess.item_key == item.item_key,
            )
        )

        if row is None:
            row = BillableItemAccess(customer_id=customer_id, item_key=item.item_key)
            session.add(row)

        row.enabled = 1 if enabled else 0
        row.updated_at = _now()

        turn_off_setting_ref = None

        if not enabled:
            session.query(SubscriptionItem).filter(
                SubscriptionItem.customer_id == customer_id,
                SubscriptionItem.item_key == item.item_key,
            ).delete()

            if item.activation_type == "setting_flag":
                turn_off_setting_ref = item.activation_ref

    # Outside the session on purpose — same reasoning as checkout()'s own
    # setting_flag activation: the updaters below open their own
    # get_session(), so they run after this one has already committed.
    if turn_off_setting_ref is not None:
        updater = _SETTING_FLAG_UPDATERS.get(turn_off_setting_ref)
        if updater is not None:
            updater(customer_id, {turn_off_setting_ref: False})

    return list_billable_items(customer_id=customer_id), None


def _validate_item_fields(data, require_all):

    def _get(key, default=None):
        return data.get(key, default)

    if require_all or "name" in data:
        name = (_get("name") or "").strip()
        if not name:
            return None, "Item name is required."

    if require_all or "category" in data:
        category = (_get("category") or "").strip()
        if not category:
            return None, "Category is required."

    if require_all or "unit_type" in data:
        if _get("unit_type") not in VALID_UNIT_TYPES:
            return None, f"Unit Type must be one of: {', '.join(VALID_UNIT_TYPES)}."

    if require_all or "activation_type" in data:
        if _get("activation_type") not in VALID_ACTIVATION_TYPES:
            return None, f"Activation Type must be one of: {', '.join(VALID_ACTIVATION_TYPES)}."

    activation_type = _get("activation_type")
    activation_ref = _get("activation_ref")

    if activation_type == "module" and activation_ref not in VALID_MODULE_KEYS:
        return None, "Activation Reference must be a real module key when Activation Type is 'module'."

    for price_field in ("monthly_price", "yearly_price"):
        if require_all or price_field in data:
            try:
                value = float(_get(price_field, 0))
            except (TypeError, ValueError):
                return None, f"{price_field} must be a number."
            if value < 0:
                return None, f"{price_field} cannot be negative."

    return True, None


def create_billable_item(data):

    data = data or {}
    ok, error = _validate_item_fields(data, require_all=True)

    if not ok:
        return None, error

    item_key = (data.get("item_key") or "").strip()

    if not item_key:
        return None, "Item Key is required."

    with get_session() as session:
        if session.scalar(select(BillableItem).where(BillableItem.item_key == item_key)) is not None:
            return None, f'An item with the key "{item_key}" already exists.'

        row = BillableItem(
            item_key=item_key,
            category=data["category"].strip(),
            name=data["name"].strip(),
            description=(data.get("description") or "").strip() or None,
            unit_type=data["unit_type"],
            monthly_price=float(data.get("monthly_price", 0)),
            yearly_price=float(data.get("yearly_price", 0)),
            yearly_discount_percent=data.get("yearly_discount_percent"),
            enabled=1 if data.get("enabled", True) else 0,
            display_order=int(data.get("display_order", 0)),
            activation_type=data["activation_type"],
            activation_ref=data.get("activation_ref") or None,
            updated_at=_now(),
        )
        session.add(row)

    return list_billable_items(), None


def update_billable_item(item_id, data):

    data = data or {}
    ok, error = _validate_item_fields(data, require_all=False)

    if not ok:
        return None, error

    with get_session() as session:
        row = session.get(BillableItem, item_id)

        if row is None:
            return None, "Billing item not found."

        if "category" in data:
            row.category = data["category"].strip()
        if "name" in data:
            row.name = data["name"].strip()
        if "description" in data:
            row.description = (data.get("description") or "").strip() or None
        if "unit_type" in data:
            row.unit_type = data["unit_type"]
        if "monthly_price" in data:
            row.monthly_price = float(data["monthly_price"])
        if "yearly_price" in data:
            row.yearly_price = float(data["yearly_price"])
        if "yearly_discount_percent" in data:
            row.yearly_discount_percent = data["yearly_discount_percent"]
        if "enabled" in data:
            row.enabled = 1 if data["enabled"] else 0
        if "display_order" in data:
            row.display_order = int(data["display_order"])
        if "activation_type" in data:
            row.activation_type = data["activation_type"]
        if "activation_ref" in data:
            row.activation_ref = data.get("activation_ref") or None

        row.updated_at = _now()

    return list_billable_items(), None


def delete_billable_item(item_id):

    with get_session() as session:
        row = session.get(BillableItem, item_id)

        if row is None:
            return None, "Billing item not found."

        session.delete(row)

    return list_billable_items(), None


def get_billing_config():

    with get_session() as session:
        row = session.get(BillingConfig, 1)
        return {"tax_percent": row.tax_percent if row else 0}


def update_billing_config(tax_percent):

    try:
        tax_percent = float(tax_percent)
    except (TypeError, ValueError):
        return None, "Tax percent must be a number."

    if tax_percent < 0 or tax_percent > 100:
        return None, "Tax percent must be between 0 and 100."

    with get_session() as session:
        row = session.get(BillingConfig, 1)

        if row is None:
            row = BillingConfig(id=1)
            session.add(row)

        row.tax_percent = tax_percent
        row.updated_at = _now()

    return get_billing_config(), None


def _quantity_for(item, customer_id):

    if item.unit_type == "per_camera":
        return get_camera_counts_by_customer([customer_id])[customer_id]["total"]

    if item.unit_type == "per_gb":
        return get_storage_usage_gb(customer_id)

    return 1


def _overrides_for(session, customer_id):
    return {
        row.item_key: row
        for row in session.scalars(
            select(BillableItemPriceOverride).where(BillableItemPriceOverride.customer_id == customer_id)
        )
    }


def get_checkout_context(customer_id):
    """Company Admin: every ENABLED item, grouped by category, with
    this company's currently-active selection, this company's
    EFFECTIVE price (its own override if the Super Admin set one for
    it, otherwise the global price — see set_item_price_override), and
    (for per_camera/per_gb items) a live-measured quantity — never a
    client-editable number.

    For `activation_type == "module"` items, `currently_active` (i.e.
    unlocked/locked) is read straight from this company's real
    user_permissions grant (Super-Admin-only, via
    PUT /users/<id>/permissions) — NOT from a past checkout selection —
    so the Company Admin's view always matches what the Super Admin
    actually granted, live. Every other item type keeps its previous
    meaning: "did this company's last checkout include it"."""

    with get_session() as session:
        items = session.scalars(
            select(BillableItem)
            .where(BillableItem.enabled == 1, BillableItem.activation_type != "package")
            .order_by(BillableItem.category, BillableItem.display_order, BillableItem.name)
        ).all()

        active_keys = {
            row.item_key
            for row in session.scalars(
                select(SubscriptionItem).where(SubscriptionItem.customer_id == customer_id)
            )
        }

        granted_module_keys = set(get_user_module_keys(customer_id))

        overrides = _overrides_for(session, customer_id)
        access = _access_map_for(session, customer_id)

        subscription = session.get(Subscription, customer_id)
        billing_cycle = (subscription.billing_cycle if subscription else None) or "Monthly"

        config = session.get(BillingConfig, 1)
        tax_percent = config.tax_percent if config else 0

        modules = []
        for item in items:
            is_module = item.activation_type == "module"
            always_active = is_module and item.activation_ref in ALWAYS_ACTIVE_MODULE_KEYS
            currently_active = (
                (always_active or item.activation_ref in granted_module_keys)
                if is_module
                # A Super Admin's OFF lock (access.get(...) is False) forces
                # this false even if a past SubscriptionItem row somehow
                # still exists — same "forced inactive" guarantee a locked
                # module already gets from its own permission grant.
                else (item.item_key in active_keys and access.get(item.item_key, True))
            )

            modules.append({
                **_item_to_dict(item, overrides.get(item.item_key)),
                "currently_active": currently_active,
                "always_active": always_active,
                "quantity": _quantity_for(item, customer_id),
                # Non-module items only — whether THIS company's Super
                # Admin lock (set_item_access) is on. The Company Admin
                # page uses this to show a Locked state instead of a
                # selectable checkbox; module items lock through their
                # own permission grant (currently_active) instead, so
                # this is always True (not applicable) for them.
                "access_enabled": True if is_module else access.get(item.item_key, True),
            })

        return {"items": modules, "billing_cycle": billing_cycle, "tax_percent": tax_percent}


def checkout(customer_id, item_keys, billing_cycle):
    """The 'Pay Now' action. Server-authoritative on price AND
    quantity — a caller can only choose WHICH items, never what they
    cost or how many units. Simulated gateway: always succeeds.

    Module-type items are never client-selectable here: which ones get
    billed is derived purely from this company's real module grant
    (Super-Admin-only, via PUT /users/<id>/permissions), so a Company
    Admin can neither buy their way into a module the Super Admin
    hasn't granted, nor dodge paying for one that's already granted, by
    tampering with item_keys. Only non-module items (storage, hardware,
    hosting, notifications) are still chosen by the caller."""

    if not isinstance(item_keys, list):
        return None, "Selected items must be provided as a list."

    if billing_cycle not in VALID_BILLING_CYCLES:
        return None, f"Billing Cycle must be one of: {', '.join(VALID_BILLING_CYCLES)}."

    price_field = "monthly_price" if billing_cycle == "Monthly" else "yearly_price"

    with get_session() as session:
        all_items = {row.item_key: row for row in session.scalars(select(BillableItem))}

        granted_module_keys = set(get_user_module_keys(customer_id))
        billed_module_keys = {
            row.item_key
            for row in all_items.values()
            if row.activation_type == "module"
            and row.enabled
            and row.activation_ref in granted_module_keys
            and row.activation_ref not in ALWAYS_ACTIVE_MODULE_KEYS
        }

        access = _access_map_for(session, customer_id)

        client_selected_non_module = {
            key for key in item_keys
            if key in all_items and all_items[key].enabled and all_items[key].activation_type != "module"
            # A Super Admin's OFF lock blocks this item from being
            # (re-)selected at checkout, exactly like a locked module is
            # never in granted_module_keys — no client-side bypass.
            and access.get(key, True)
        }

        selected_keys = list(billed_module_keys | client_selected_non_module)
        overrides = _overrides_for(session, customer_id)

        line_items = []
        for key in selected_keys:
            item = all_items[key]
            quantity = _quantity_for(item, customer_id)
            # This company's own override price if the Super Admin set
            # one for it, otherwise the global catalog price — the
            # exact same resolution get_checkout_context() already
            # showed this Admin before they clicked Pay Now.
            override = overrides.get(key)
            unit_price = getattr(override, price_field) if override is not None else getattr(item, price_field)
            line_items.append({
                "item_key": key,
                "item_name": item.name,
                "quantity": quantity,
                "unit_price": unit_price,
                "price": quantity * unit_price,
            })

        subtotal = sum(li["price"] for li in line_items)

        config = session.get(BillingConfig, 1)
        tax_percent = config.tax_percent if config else 0
        tax_amount = subtotal * tax_percent / 100
        total = subtotal + tax_amount

        now = datetime.now()
        due_days = 30 if billing_cycle == "Monthly" else 365
        next_due_date = (now + timedelta(days=due_days)).strftime("%Y-%m-%d")
        transaction_id = f"SIM-{uuid.uuid4().hex[:16]}"

        # --- Subscription (per-customer_id, PK-scoped) ---
        subscription = session.get(Subscription, customer_id)

        if subscription is None:
            subscription = Subscription(customer_id=customer_id)
            session.add(subscription)

        subscription.status = "Active"
        subscription.billing_cycle = billing_cycle
        subscription.next_due_date = next_due_date
        subscription.updated_at = _now()

        # --- SubscriptionItem: replace this customer's add-on selection,
        # leaving any "package:*" rows (owned via api/module_packages.py)
        # untouched. ---
        session.query(SubscriptionItem).filter(
            SubscriptionItem.customer_id == customer_id,
            ~SubscriptionItem.item_key.like("package:%"),
        ).delete(synchronize_session=False)

        for li in line_items:
            session.add(
                SubscriptionItem(
                    customer_id=customer_id,
                    item_key=li["item_key"],
                    quantity=li["quantity"],
                    unit_price=li["unit_price"],
                    price=li["price"],
                    billing_cycle=billing_cycle,
                )
            )

        session.flush()

        # amount reflects every current line — packages + these add-ons.
        subscription.amount = float(
            session.scalar(
                select(func.coalesce(func.sum(SubscriptionItem.price), 0.0)).where(
                    SubscriptionItem.customer_id == customer_id
                )
            )
            or 0.0
        )
        if not subscription.plan_name or subscription.plan_name == "Free":
            subscription.plan_name = "Custom"

        # --- Payment + line items ---
        payment = Payment(
            customer_id=customer_id,
            amount=total,
            method="Simulated Gateway",
            note=f"{len(line_items)} item(s)",
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
                    quantity=li["quantity"],
                    unit_price=li["unit_price"],
                    price=li["price"],
                )
            )

        payment_id = payment.id
        subscription_dict = to_dict(subscription)

        # Snapshot of the full catalog's setting_flag items, taken
        # inside the same session, for activation below.
        setting_flag_items = [i for i in all_items.values() if i.activation_type == "setting_flag"]

    selected_set = set(selected_keys)

    # --- Activation: real NotificationSettings toggles — every
    # setting_flag item in the catalog is resolved (not just the ones
    # in this order), so deselecting one genuinely turns it back off. ---
    activated_setting_flags = []

    for item in setting_flag_items:
        updater = _SETTING_FLAG_UPDATERS.get(item.activation_ref)

        if updater is None:
            continue  # a custom setting_flag item with no real toggle behind it — nothing to do, by design

        turn_on = item.item_key in selected_set
        updater(customer_id, {item.activation_ref: turn_on})

        if turn_on:
            activated_setting_flags.append(item.activation_ref)

    return {
        "subscription": subscription_dict,
        "payment": {
            "id": payment_id,
            "amount": total,
            "subtotal": subtotal,
            "tax_amount": tax_amount,
            "billing_cycle": billing_cycle,
            "transaction_id": transaction_id,
            "status": "Success",
            "items": line_items,
        },
        "activated_setting_flags": activated_setting_flags,
    }, None


def _payment_status_for(subscription_row, latest_payment_row):
    """Server-side port of SubscriptionPayment.jsx's computePaymentStatus
    — kept in sync deliberately so the Super Admin overview and the
    Company Admin's own page never disagree about a company's status."""

    if subscription_row is None or not subscription_row.next_due_date:
        return None

    try:
        due_date = datetime.strptime(subscription_row.next_due_date, "%Y-%m-%d")
    except ValueError:
        return None

    today = datetime.now()

    if due_date < today:
        return "Overdue"

    if latest_payment_row is not None:
        try:
            paid_date = datetime.strptime(latest_payment_row.paid_on, "%Y-%m-%d")
            cycle_days = 366 if subscription_row.billing_cycle == "Yearly" else 31
            days_since_paid = (today - paid_date).days

            if 0 <= days_since_paid <= cycle_days:
                return "Paid"
        except ValueError:
            pass

    return "Pending"


def get_billing_overview():
    """Super Admin: one row per company, for the Billing Overview page."""

    with get_session() as session:
        companies = session.scalars(
            select(User).where(User.role == ROLE_COMPANY_ADMIN).order_by(User.name)
        ).all()
        customer_ids = [c.id for c in companies]

        camera_counts = get_camera_counts_by_customer(customer_ids)

        subscriptions = {
            row.customer_id: row
            for row in session.scalars(select(Subscription).where(Subscription.customer_id.in_(customer_ids)))
        }

        item_names_by_customer = {}
        for customer_id, item_key in session.execute(
            select(SubscriptionItem.customer_id, SubscriptionItem.item_key)
            .where(SubscriptionItem.customer_id.in_(customer_ids))
        ):
            item_names_by_customer.setdefault(customer_id, []).append(item_key)

        billable_by_key = {row.item_key: row for row in session.scalars(select(BillableItem))}

        total_paid_by_customer = dict(
            session.execute(
                select(Payment.customer_id, func.sum(Payment.amount))
                .where(Payment.customer_id.in_(customer_ids), Payment.status == "Success")
                .group_by(Payment.customer_id)
            ).all()
        )

        latest_payment_by_customer = {}
        for customer_id in customer_ids:
            latest = session.scalar(
                select(Payment)
                .where(Payment.customer_id == customer_id)
                .order_by(Payment.paid_on.desc(), Payment.id.desc())
            )
            if latest is not None:
                latest_payment_by_customer[customer_id] = latest

        overview = []

        for company in companies:
            subscription = subscriptions.get(company.id)
            latest_payment = latest_payment_by_customer.get(company.id)
            item_keys = item_names_by_customer.get(company.id, [])
            active_item_names = [billable_by_key[k].name for k in item_keys if k in billable_by_key]

            billing_cycle = subscription.billing_cycle if subscription else None
            amount = subscription.amount if subscription else 0

            overview.append({
                "customer_id": company.id,
                "customer_name": company.name,
                "customer_email": company.email,
                "plan_name": (subscription.plan_name if subscription else None) or "Free",
                "status": (subscription.status if subscription else None) or "Trial",
                "active_items": active_item_names,
                "camera_count": camera_counts.get(company.id, {"total": 0})["total"],
                "storage_gb": round(get_storage_usage_gb(company.id), 3),
                "monthly_amount": amount if billing_cycle == "Monthly" else 0,
                "yearly_amount": amount if billing_cycle == "Yearly" else 0,
                "next_due_date": subscription.next_due_date if subscription else None,
                "payment_status": _payment_status_for(subscription, latest_payment),
                "total_paid": total_paid_by_customer.get(company.id, 0) or 0,
                "latest_transaction": (
                    {
                        "amount": latest_payment.amount,
                        "paid_on": latest_payment.paid_on,
                        "transaction_id": latest_payment.transaction_id,
                        "status": latest_payment.status,
                    }
                    if latest_payment is not None else None
                ),
            })

        return overview


def get_company_billing_detail(customer_id):
    """Super Admin: one company's full billing breakdown, for
    AdminCompanyDetails.jsx's new Billing & Payment History section."""

    with get_session() as session:
        items = session.scalars(
            select(SubscriptionItem).where(SubscriptionItem.customer_id == customer_id)
        ).all()
        billable_by_key = {row.item_key: row for row in session.scalars(select(BillableItem))}

        active_items = [
            {
                "item_key": row.item_key,
                "item_name": billable_by_key[row.item_key].name if row.item_key in billable_by_key else row.item_key,
                "category": billable_by_key[row.item_key].category if row.item_key in billable_by_key else None,
                "quantity": row.quantity,
                "unit_price": row.unit_price,
                "price": row.price,
                "billing_cycle": row.billing_cycle,
            }
            for row in items
        ]

    return {
        "subscription": get_subscription(customer_id),
        "active_items": active_items,
        "camera_count": get_camera_counts_by_customer([customer_id])[customer_id]["total"],
        "storage_gb": round(get_storage_usage_gb(customer_id), 3),
        "payments": list_payments(customer_id),
    }
