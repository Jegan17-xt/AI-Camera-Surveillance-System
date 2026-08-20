def apply_owner_scope(query, column, owner_user_id):
    """The one shared Per-User Data Isolation filter idiom, used by every
    scoped query across the Admin module (cameras, registered persons,
    unknown persons, attendance, notifications). `owner_user_id` is
    whatever auth.auth.get_data_scope() resolved:
      - None -> no filter at all (today's pooled/company-wide behavior,
        the exact query every existing caller already ran).
      - "unassigned" -> column IS NULL.
      - a real User id -> column == that id.

    Centralized here (rather than reimplemented per module) since this
    is the actual security boundary between one User's data and
    another's — one file to get right, not eight."""

    if owner_user_id == "unassigned":
        return query.where(column.is_(None))

    if owner_user_id is not None:
        return query.where(column == owner_user_id)

    return query
