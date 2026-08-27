"""Queue recoverable remote moves left behind by the legacy local-only rule bug.

The script never claims that a message already exists in the target mailbox.
It only creates durable pending operations. The application worker then finds
each source message by Message-ID, performs IMAP MOVE, confirms the destination
UID, and finally makes a soft-deleted local row visible again.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sqlite3
import uuid
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True, type=Path)
    parser.add_argument("--account-email", required=True)
    parser.add_argument("--target-folder", required=True)
    parser.add_argument("--match-domain", required=True)
    parser.add_argument("--commit", action="store_true")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    connection = sqlite3.connect(args.db)
    connection.row_factory = sqlite3.Row
    account = connection.execute(
        "SELECT id, email FROM accounts WHERE lower(email) = lower(?)",
        (args.account_email,),
    ).fetchone()
    if account is None:
        raise SystemExit(f"Account not found: {args.account_email}")

    folders = {
        row["role"]: row
        for row in connection.execute(
            "SELECT id, remote_id, name, role FROM folders WHERE account_id = ?",
            (account["id"],),
        )
        if row["role"] in {"inbox", "sent"}
    }
    target = connection.execute(
        "SELECT id, remote_id, name FROM folders "
        "WHERE account_id = ? AND name = ? ORDER BY id LIMIT 1",
        (account["id"], args.target_folder),
    ).fetchone()
    if target is None or "inbox" not in folders or "sent" not in folders:
        raise SystemExit("Target, Inbox, or Sent folder is missing")

    domain_pattern = f"%@{args.match_domain.lower()}%"
    rows = connection.execute(
        "SELECT m.*, "
        "       EXISTS(SELECT 1 FROM attachments a WHERE a.message_id=m.id) has_local_attachment "
        "FROM messages m "
        "JOIN message_folders mf ON mf.message_id=m.id "
        "WHERE mf.folder_id=? AND m.account_id=? "
        "  AND m.message_id_header IS NOT NULL "
        "  AND (lower(m.from_address) LIKE ? OR lower(m.to_list) LIKE ? "
        "       OR lower(m.cc_list) LIKE ? OR lower(m.bcc_list) LIKE ?) "
        "ORDER BY m.message_id_header, m.is_deleted ASC, "
        "         (m.remote_version IS NULL) DESC, has_local_attachment DESC, m.updated_at DESC",
        (
            target["id"],
            account["id"],
            domain_pattern,
            domain_pattern,
            domain_pattern,
            domain_pattern,
        ),
    ).fetchall()

    by_header: dict[str, list[sqlite3.Row]] = {}
    for row in rows:
        by_header.setdefault(row["message_id_header"], []).append(row)

    selected: list[tuple[sqlite3.Row, sqlite3.Row]] = []
    skipped_live_elsewhere = 0
    for header, copies in by_header.items():
        live_elsewhere = connection.execute(
            "SELECT 1 FROM messages m JOIN message_folders mf ON mf.message_id=m.id "
            "WHERE m.account_id=? AND m.message_id_header=? AND m.is_deleted=0 "
            "  AND mf.folder_id<>? LIMIT 1",
            (account["id"], header, target["id"]),
        ).fetchone()
        if live_elsewhere is not None:
            skipped_live_elsewhere += 1
            continue
        message = copies[0]
        source = (
            folders["sent"]
            if message["from_address"].lower() == account["email"].lower()
            else folders["inbox"]
        )
        selected.append((message, source))

    summary = {
        "account": account["email"],
        "target": target["name"],
        "target_remote_id": target["remote_id"],
        "candidates": len(selected),
        "from_inbox": sum(1 for _, source in selected if source["role"] == "inbox"),
        "from_sent": sum(1 for _, source in selected if source["role"] == "sent"),
        "currently_visible": sum(1 for message, _ in selected if not message["is_deleted"]),
        "soft_deleted": sum(1 for message, _ in selected if message["is_deleted"]),
        "skipped_live_elsewhere": skipped_live_elsewhere,
    }
    print(json.dumps(summary, ensure_ascii=False))
    if not args.commit:
        return

    timestamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_path = args.db.with_name(f"{args.db.stem}-before-rule-repair-{timestamp}.db")
    connection.commit()
    backup = sqlite3.connect(backup_path)
    connection.backup(backup)
    backup_check = backup.execute("PRAGMA quick_check").fetchone()[0]
    backup.close()
    if backup_check != "ok":
        raise SystemExit(f"Backup integrity check failed: {backup_check}")

    now = int(dt.datetime.now().timestamp())
    inserted = 0
    with connection:
        for message, source in selected:
            active = connection.execute(
                "SELECT 1 FROM pending_mail_ops "
                "WHERE message_id=? AND op_type='move_to_folder' "
                "  AND status IN ('pending','in_progress','failed') LIMIT 1",
                (message["id"],),
            ).fetchone()
            if active is not None:
                continue
            payload = {
                "provider_account_id": account["id"],
                "remote_id": message["remote_id"],
                "op": "move_to_folder",
                "payload": {
                    "source_folder_id": source["id"],
                    "source_folder_remote_id": source["remote_id"],
                    "target_folder_id": target["id"],
                    "target_folder_remote_id": target["remote_id"],
                    "add_labels": [target["remote_id"]],
                    "remove_labels": [source["remote_id"]],
                    "legacy_rule_repair": True,
                },
            }
            connection.execute(
                "INSERT INTO pending_mail_ops "
                "(id,account_id,message_id,op_type,payload_json,status,attempts,last_error,created_at,updated_at) "
                "VALUES (?,?,?,'move_to_folder',?,'pending',0,NULL,?,?)",
                (
                    str(uuid.uuid4()),
                    account["id"],
                    message["id"],
                    json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
                    now,
                    now,
                ),
            )
            inserted += 1
    print(
        json.dumps(
            {"backup": str(backup_path), "backup_check": backup_check, "queued": inserted},
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
