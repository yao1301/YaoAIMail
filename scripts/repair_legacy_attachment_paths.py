"""Audit or repair legacy absolute attachment paths after a profile move.

Only aggregate counts are printed. The repair is atomic and creates a SQLite
backup before changing any row.
"""

from __future__ import annotations

import argparse
import datetime as dt
import os
from pathlib import Path, PureWindowsPath
import sqlite3


def relocated_path(stored: str, attachments_root: Path) -> Path | None:
    parts = PureWindowsPath(stored.replace("/", "\\")).parts
    marker = next((i for i, part in enumerate(parts) if part.lower() == "attachments"), None)
    if marker is None or marker + 1 >= len(parts):
        return None
    tail = parts[marker + 1 :]
    if any(part in {"", ".", ".."} for part in tail):
        return None
    candidate = attachments_root.joinpath(*tail).resolve()
    root = attachments_root.resolve()
    if candidate == root or root not in candidate.parents:
        return None
    return candidate


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    parser.add_argument("--attachments-root", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    db_path = Path(args.db).resolve()
    attachments_root = Path(args.attachments_root).resolve()
    connection = sqlite3.connect(db_path)
    rows = connection.execute(
        "SELECT id, local_path FROM attachments WHERE local_path IS NOT NULL AND length(trim(local_path)) > 0"
    ).fetchall()
    repairs: list[tuple[str, str]] = []
    unresolved = 0
    already_valid = 0
    for attachment_id, stored in rows:
        if os.path.isfile(stored):
            already_valid += 1
            continue
        candidate = relocated_path(stored, attachments_root)
        if candidate is None or not candidate.is_file():
            unresolved += 1
            continue
        repairs.append((str(candidate), attachment_id))

    print({"total": len(rows), "already_valid": already_valid, "repairable": len(repairs), "unresolved": unresolved})
    if not args.apply:
        connection.close()
        return 0
    if unresolved:
        connection.close()
        raise RuntimeError("Refusing partial repair because some attachment paths are unresolved")

    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_path = db_path.with_name(f"pebble-before-attachment-path-repair-{stamp}.db")
    if backup_path.exists():
        connection.close()
        raise FileExistsError(backup_path)
    backup = sqlite3.connect(backup_path)
    connection.backup(backup)
    backup.close()

    connection.execute("BEGIN IMMEDIATE")
    try:
        connection.executemany("UPDATE attachments SET local_path = ?1 WHERE id = ?2", repairs)
        changed = connection.execute("SELECT changes()").fetchone()[0] if len(repairs) == 1 else len(repairs)
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    integrity = connection.execute("PRAGMA integrity_check").fetchone()[0]
    missing_after = sum(
        not os.path.isfile(path)
        for (path,) in connection.execute(
            "SELECT local_path FROM attachments WHERE local_path IS NOT NULL AND length(trim(local_path)) > 0"
        )
    )
    connection.close()
    print({"updated": changed, "missing_after": missing_after, "integrity": integrity, "backup": str(backup_path)})
    return 0 if integrity == "ok" and missing_after == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
