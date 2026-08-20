"""Tiny shared helper used anywhere a WhatsApp recipient number is
rendered back to the Admin UI or written to a log line — never the raw
number, per this feature's "mask phone numbers in the Admin UI" rule.
"""


def mask_recipient(value):
    """'+919876543210' -> '+91*******210'. Never raises on odd input —
    used purely for display/logging, never for anything that has to be
    correct to be safe."""

    if not value:
        return value

    if len(value) <= 4:
        return "*" * len(value)

    return value[:3] + "*" * (len(value) - 6) + value[-3:]
