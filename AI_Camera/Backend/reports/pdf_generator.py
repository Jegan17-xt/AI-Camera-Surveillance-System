"""Renders the Daily Report's real database data (built by
reports/daily_report.py) into a PDF, using the same reportlab stack
api/pdf_export.py already uses elsewhere in this project. Pure
rendering: this module never queries the database and never knows about
NotificationSettings/WhatsApp — it only turns already-collected dicts
into bytes.
"""

import io
import os

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (
    HRFlowable,
    Image,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

_HEADER_BG = colors.HexColor("#111827")
_ROW_ALT_BG = colors.HexColor("#f3f4f6")
_GRID_COLOR = colors.HexColor("#d1d5db")
_MUTED_TEXT = colors.HexColor("#4b5563")

_THUMB_MAX_DIM = 26 * mm


def _table_style():
    return TableStyle(
        [
            ("BACKGROUND", (0, 0), (-1, 0), _HEADER_BG),
            ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
            ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
            ("FONTSIZE", (0, 0), (-1, -1), 8.5),
            ("GRID", (0, 0), (-1, -1), 0.5, _GRID_COLOR),
            ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, _ROW_ALT_BG]),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ]
    )


def _image_cell(image_path, small_style):
    """A scaled reportlab Image flowable for a table cell, or a plain
    "N/A" Paragraph when the file is missing — this is the "gracefully
    omit rather than invent" rule applied to a single cell instead of a
    whole section."""

    if not image_path or not os.path.isfile(image_path):
        return Paragraph("N/A", small_style)

    try:
        img = Image(image_path)
        ratio = min(_THUMB_MAX_DIM / img.imageWidth, _THUMB_MAX_DIM / img.imageHeight, 1.0)
        img.drawWidth = img.imageWidth * ratio
        img.drawHeight = img.imageHeight * ratio
        return img
    except Exception:
        return Paragraph("N/A", small_style)


def build_daily_report_pdf(report_date, data, settings):
    """`data` is exactly what reports.daily_report._collect_report_data
    returns; `settings` is a get_notification_settings() dict — its
    daily_report_include_* flags decide which sections actually render.
    Sections whose flag is on but whose data is empty still render a
    "No records for this date" line instead of an invented row."""

    buffer = io.BytesIO()

    doc = SimpleDocTemplate(
        buffer,
        pagesize=A4,
        topMargin=18 * mm,
        bottomMargin=15 * mm,
        leftMargin=15 * mm,
        rightMargin=15 * mm,
    )

    styles = getSampleStyleSheet()
    title_style = ParagraphStyle("ReportTitle", parent=styles["Title"], alignment=TA_CENTER, fontSize=16)
    subtitle_style = ParagraphStyle(
        "ReportSubtitle", parent=styles["Normal"], alignment=TA_CENTER, textColor=_MUTED_TEXT, fontSize=11
    )
    heading_style = ParagraphStyle(
        "SectionHeading", parent=styles["Heading2"], spaceBefore=14, spaceAfter=6, textColor=colors.HexColor("#111827")
    )
    small_style = ParagraphStyle("SmallCell", parent=styles["Normal"], fontSize=8)
    footer_style = ParagraphStyle("Footer", parent=styles["Normal"], alignment=TA_CENTER, textColor=_MUTED_TEXT, fontSize=8)

    elements = [
        Paragraph("AI CAMERA SURVEILLANCE SYSTEM", title_style),
        Paragraph("DAILY SECURITY REPORT", subtitle_style),
        Spacer(1, 6),
        HRFlowable(width="100%", color=_GRID_COLOR),
        Spacer(1, 10),
        Paragraph(f"<b>Date:</b> {report_date}", styles["Normal"]),
        Spacer(1, 6),
    ]

    # 1. Attendance Summary
    if settings.get("daily_report_include_attendance_summary"):
        summary = data.get("attendance_summary") or {}
        elements.append(Paragraph("1. Attendance Summary", heading_style))
        rows = [
            ["Total Registered Persons", str(summary.get("total_registered", 0))],
            ["Present", str(summary.get("present", 0))],
            ["Absent", str(summary.get("absent", 0))],
        ]
        table = Table([["Metric", "Count"]] + rows, colWidths=[320, 150])
        table.setStyle(_table_style())
        elements.append(table)

    # 2. Person-wise Attendance
    if settings.get("daily_report_include_person_wise"):
        elements.append(Paragraph("2. Person-wise Attendance", heading_style))
        person_wise = data.get("person_wise") or []

        if person_wise:
            rows = [[p["name"], p["first_entry"], p["last_exit"], p["status"]] for p in person_wise]
            table = Table([["Person", "First Entry", "Last Exit", "Status"]] + rows, repeatRows=1)
            table.setStyle(_table_style())
            elements.append(table)
        else:
            elements.append(Paragraph("No attendance recorded for this date.", styles["Normal"]))

    # 3. Unknown Persons Detected Today — one row per UNIQUE unknown
    # person (never per repeated sighting; see _collect_report_data),
    # using the same saved face image/first-seen/last-seen/detection
    # count already stored on that person's existing UnknownPerson row.
    if settings.get("daily_report_include_unknown_events"):
        elements.append(Paragraph("3. Unknown Persons Detected Today", heading_style))
        events = data.get("unknown_events") or []

        if events:
            rows = [
                [
                    str(i + 1),
                    _image_cell(e.get("image_path"), small_style),
                    e["camera"],
                    str(e.get("detection_count", 0)),
                    e.get("first_seen", ""),
                    e.get("last_seen", ""),
                ]
                for i, e in enumerate(events)
            ]
            table = Table(
                [["#", "Image", "Camera", "Count", "First Detected", "Last Detected"]] + rows,
                colWidths=[20, _THUMB_MAX_DIM + 10, 100, 45, 95, 95],
                repeatRows=1,
            )
            table.setStyle(_table_style())
            elements.append(table)
        else:
            elements.append(Paragraph("No unknown persons detected on this date.", styles["Normal"]))

    # 4. Camera Status
    if settings.get("daily_report_include_camera_status"):
        elements.append(Paragraph("4. Camera Status", heading_style))
        cameras = data.get("camera_status") or []

        if cameras:
            rows = [[c["name"], c["location"], c["status"], c["last_seen"]] for c in cameras]
            table = Table([["Camera", "Location", "Status", "Last Seen"]] + rows, repeatRows=1)
            table.setStyle(_table_style())
            elements.append(table)
        else:
            elements.append(Paragraph("No cameras registered.", styles["Normal"]))

    # 5. AI Detection Summary
    if settings.get("daily_report_include_detection_stats"):
        elements.append(Paragraph("5. AI Detection Summary", heading_style))
        detection = data.get("detection_summary") or {}
        rows = [
            ["Registered Person Detections", str(detection.get("registered_detections", 0))],
            ["Unknown Person Detections", str(detection.get("unknown_detections", 0))],
        ]
        table = Table([["Metric", "Count"]] + rows, colWidths=[320, 150])
        table.setStyle(_table_style())
        elements.append(table)

    # 6. Report Generated At
    elements.append(Paragraph("6. Report Generated At", heading_style))
    elements.append(Paragraph(data.get("generated_at", ""), styles["Normal"]))

    elements.append(Spacer(1, 16))
    elements.append(HRFlowable(width="100%", color=_GRID_COLOR))
    elements.append(Spacer(1, 6))
    elements.append(Paragraph("AI Camera Surveillance System — Confidential", footer_style))

    doc.build(elements)

    return buffer.getvalue()
