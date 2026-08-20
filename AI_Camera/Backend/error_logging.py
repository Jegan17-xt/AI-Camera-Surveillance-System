"""Shared exception-logging helper for the AI pipeline.

Final Production Readiness's explicit requirement: "Never swallow
exceptions. Every exception must print: File, Function, Line Number,
Reason." A bare `print(e)` (this codebase's previous pattern in a
handful of except blocks) only ever gives the Reason — this gives all
four, every time, from one shared call site instead of each file
re-implementing traceback walking slightly differently.
"""

import re
import traceback

# Security fix: an RTSP/HTTP connection failure (e.g. from cv2/FFmpeg or
# `requests`) can embed the full connection string — credentials
# included — directly in its exception message ("... rtsp://admin:
# Secret123@192.168.1.10:554/... failed"). Every server-side log call in
# this codebase eventually funnels through log_exception(), so
# sanitizing it once here protects every call site, present and future,
# instead of relying on each one to remember to do it itself.
#
# `[^/\s]*` (not `[^\s/@]+:[^\s/@]+`) is deliberate: a device/DVR
# password is free-form and can itself legally contain '@' (e.g.
# "Pass@123") — see api/cameras.py's build_rtsp_url, which intentionally
# never URL-encodes it, "splitting on the LAST '@' before the host" being
# exactly how OpenCV/FFmpeg themselves parse it. A character class that
# excludes '@' from the userinfo portion would stop at the FIRST '@' (if
# one happens to sit inside the password) and leave everything after it
# — including a second, real '@' and the rest of the password — sitting
# unmasked right next to a stray "***:***@" fragment. Greedy `[^/\s]*@`
# instead always consumes up to the LAST '@' before the next '/' (or
# whitespace/end), which is the actual userinfo/host boundary regardless
# of what characters the password itself contains.
_URL_CREDENTIALS_PATTERN = re.compile(r"(://)[^/\s]*@")


def sanitize_sensitive_url(text):
    """Strips a userinfo (user:pass@) segment out of any URL embedded in
    `text` — e.g. an RTSP connection string inside an exception message
    or a log line — so a camera (or any other) credential can never end
    up in a log. Safe to call on text with no such URL, or on None
    (returned unchanged)."""

    if not text:
        return text

    return _URL_CREDENTIALS_PATTERN.sub(r"\1***:***@", str(text))


def log_exception(exc, context=""):
    """Prints File, Function, Line Number, and Reason for `exc`, taken
    from the innermost (deepest) frame of its traceback — i.e. where it
    actually happened, not just where it was caught. `context` is a
    short label (e.g. "YOLO detection", "save_unknown") identifying
    which pipeline stage was running when it happened.

    The Reason and the full traceback are both passed through
    sanitize_sensitive_url() first — see its own docstring."""

    label = f" [{context}]" if context else ""
    reason = sanitize_sensitive_url(str(exc))
    print(f"[ERROR]{label} {type(exc).__name__}: {reason}")

    tb = exc.__traceback__

    if tb is None:
        print("  (no traceback available)")
        return

    last = tb
    while last.tb_next is not None:
        last = last.tb_next

    frame = last.tb_frame
    print(f"  File     : {frame.f_code.co_filename}")
    print(f"  Function : {frame.f_code.co_name}")
    print(f"  Line     : {last.tb_lineno}")
    print(f"  Reason   : {reason}")

    # Full stack too — the four fields above are the fast-scan summary
    # this task asked for, the traceback underneath is what an operator
    # actually needs to debug a multi-call-deep failure. Formatted to a
    # string first (rather than traceback.print_exception's direct-to-
    # stderr write) so it can be sanitized the same way as everything
    # else above before it ever reaches a log.
    formatted = "".join(traceback.format_exception(type(exc), exc, tb))
    print(sanitize_sensitive_url(formatted), end="")
