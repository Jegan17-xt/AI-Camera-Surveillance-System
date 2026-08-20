from datetime import datetime

from sqlalchemy import select, text

from db import get_session, engine
from auth.database import ROLE_COMPANY_ADMIN
from auth.models import User, Subscription, Payment, PaymentItem, to_dict

VALID_STATUSES = ("Trial", "Active", "Expired", "Cancelled")
VALID_BILLING_CYCLES = ("Monthly", "Yearly", "One-time")

DEFAULT_PLAN_NAME = "Free"
DEFAULT_STATUS = "Trial"
DEFAULT_BILLING_CYCLE = "Monthly"

PLAN_NAME_MAX = 50
NOTES_MAX = 500
METHOD_MAX = 50
NOTE_MAX = 300


def _migrate_subscriptions_table():
    """Idempotent — same INFORMATION_SCHEMA-checked ALTER TABLE pattern as
    api/billing.py's _migrate_payments_table(). `subscriptions` already
    exists live; storage_limit_gb (Admin & User Overview) is the one
    column added after this table was first deployed."""

    with engine.connect() as conn:
        existing = {
            row[0]
            for row in conn.execute(
                text(
                    "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS "
                    "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'subscriptions'"
                )
            )
        }

        if "storage_limit_gb" not in existing:
            conn.execute(text("ALTER TABLE subscriptions ADD COLUMN storage_limit_gb FLOAT NULL"))

        conn.commit()


def init_subscriptions_table():
    """Manual Super-Admin-maintained records — one subscription row per
    company (a Company Admin account in `users`), plus a running payments
    log. Not a real billing system: no payment gateway, nothing here
    moves money — Super Admin records plan/status and logs payments by
    hand. Table creation is handled by Base.metadata.create_all() in
    auth.database.init_db()."""

    _migrate_subscriptions_table()


def _now():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _customer_exists(session, customer_id):
    return session.scalar(
        select(User).where(User.id == customer_id, User.role == ROLE_COMPANY_ADMIN)
    ) is not None


def list_subscriptions():
    """Every company (Company Admin account), left-joined with its
    subscription row — a company Super Admin has never edited a
    subscription for yet still shows up, with the same defaults
    get_subscription() would hand back for it."""

    with get_session() as session:
        rows = session.execute(
            select(User, Subscription)
            .outerjoin(Subscription, Subscription.customer_id == User.id)
            .where(User.role == ROLE_COMPANY_ADMIN)
            .order_by(User.name)
        ).all()

        return [
            {
                "customer_id": user.id,
                "customer_name": user.name,
                "customer_email": user.email,
                "customer_status": user.status,
                "plan_name": (sub.plan_name if sub else None) or DEFAULT_PLAN_NAME,
                "status": (sub.status if sub else None) or DEFAULT_STATUS,
                "amount": sub.amount if sub and sub.amount is not None else 0,
                "billing_cycle": (sub.billing_cycle if sub else None) or DEFAULT_BILLING_CYCLE,
                "next_due_date": sub.next_due_date if sub else None,
                "notes": (sub.notes if sub else None) or "",
                "updated_at": sub.updated_at if sub else None,
            }
            for user, sub in rows
        ]


def get_subscription(customer_id):

    with get_session() as session:
        row = session.get(Subscription, customer_id)

        if row is None:
            return {
                "customer_id": customer_id,
                "plan_name": DEFAULT_PLAN_NAME,
                "status": DEFAULT_STATUS,
                "amount": 0,
                "billing_cycle": DEFAULT_BILLING_CYCLE,
                "next_due_date": None,
                "notes": "",
                "storage_limit_gb": None,
                "updated_at": None,
            }

        return to_dict(row)


def set_storage_limit_gb(customer_id, storage_limit_gb):
    """Admin & User Overview: Super Admin sets (or clears, with None) this
    company's storage cap. Never touches plan/status/amount/billing —
    upserts the same Subscription row those fields live on, same
    create-if-missing shape as upsert_subscription/billing.checkout()."""

    if storage_limit_gb is not None:
        try:
            storage_limit_gb = float(storage_limit_gb)
        except (TypeError, ValueError):
            return None, "Storage limit must be a number."

        if storage_limit_gb < 0:
            return None, "Storage limit cannot be negative."

    with get_session() as session:

        if not _customer_exists(session, customer_id):
            return None, "Company not found."

        row = session.get(Subscription, customer_id)

        if row is None:
            row = Subscription(customer_id=customer_id)
            session.add(row)

        row.storage_limit_gb = storage_limit_gb
        row.updated_at = _now()

    return get_subscription(customer_id), None


def upsert_subscription(customer_id, plan_name, status, amount, billing_cycle, next_due_date, notes):

    plan_name = (plan_name or DEFAULT_PLAN_NAME).strip() or DEFAULT_PLAN_NAME

    if len(plan_name) > PLAN_NAME_MAX:
        return None, f"Plan Name must be {PLAN_NAME_MAX} characters or fewer."

    if status not in VALID_STATUSES:
        return None, f"Status must be one of: {', '.join(VALID_STATUSES)}."

    if billing_cycle not in VALID_BILLING_CYCLES:
        return None, f"Billing Cycle must be one of: {', '.join(VALID_BILLING_CYCLES)}."

    try:
        amount = float(amount)
    except (TypeError, ValueError):
        return None, "Amount must be a number."

    if amount < 0:
        return None, "Amount cannot be negative."

    next_due_date = (next_due_date or "").strip() or None

    if next_due_date:
        try:
            datetime.strptime(next_due_date, "%Y-%m-%d")
        except ValueError:
            return None, "Next Due Date must be a valid date (YYYY-MM-DD)."

    notes = (notes or "").strip()

    if len(notes) > NOTES_MAX:
        return None, f"Notes must be {NOTES_MAX} characters or fewer."

    with get_session() as session:

        if not _customer_exists(session, customer_id):
            return None, "Company not found."

        row = session.get(Subscription, customer_id)

        if row is None:
            row = Subscription(customer_id=customer_id)
            session.add(row)

        row.plan_name = plan_name
        row.status = status
        row.amount = amount
        row.billing_cycle = billing_cycle
        row.next_due_date = next_due_date
        row.notes = notes
        row.updated_at = _now()

    return get_subscription(customer_id), None


def list_payments(customer_id=None):

    with get_session() as session:
        query = select(Payment, User.name.label("customer_name")).join(User, User.id == Payment.customer_id)

        if customer_id is not None:
            query = query.where(Payment.customer_id == customer_id)

        query = query.order_by(Payment.paid_on.desc(), Payment.id.desc())

        rows = session.execute(query).all()
        payment_ids = [payment.id for payment, _ in rows]

        # Only checkout()-created payments (api/billing.py) have line
        # items — a manually-logged Super Admin payment simply gets an
        # empty list here, same as before this field existed.
        items_by_payment_id = {}

        if payment_ids:
            for line in session.scalars(
                select(PaymentItem).where(PaymentItem.payment_id.in_(payment_ids))
            ):
                items_by_payment_id.setdefault(line.payment_id, []).append(
                    {
                        "item_key": line.item_key,
                        "item_name": line.item_name,
                        "quantity": line.quantity,
                        "unit_price": line.unit_price,
                        "price": line.price,
                    }
                )

        return [
            {
                **to_dict(payment),
                "customer_name": customer_name,
                "items": items_by_payment_id.get(payment.id, []),
            }
            for payment, customer_name in rows
        ]


def add_payment(customer_id, amount, method, note, paid_on):

    try:
        amount = float(amount)
    except (TypeError, ValueError):
        return None, "Amount must be a number."

    if amount <= 0:
        return None, "Amount must be greater than 0."

    method = (method or "").strip()

    if len(method) > METHOD_MAX:
        return None, f"Method must be {METHOD_MAX} characters or fewer."

    note = (note or "").strip()

    if len(note) > NOTE_MAX:
        return None, f"Note must be {NOTE_MAX} characters or fewer."

    paid_on = (paid_on or "").strip()

    if not paid_on:
        return None, "Paid On date is required."

    try:
        datetime.strptime(paid_on, "%Y-%m-%d")
    except ValueError:
        return None, "Paid On must be a valid date (YYYY-MM-DD)."

    with get_session() as session:

        if not _customer_exists(session, customer_id):
            return None, "Company not found."

        session.add(
            Payment(
                customer_id=customer_id,
                amount=amount,
                method=method,
                note=note,
                paid_on=paid_on,
                created_at=_now(),
            )
        )

    return list_payments(customer_id), None
