# SPDX-License-Identifier: GPL-3.0-or-later
"""The three ways an attachment's bytes leave the store: /download, /preview
and /save.

What these pin down is the macOS trap and its fix. Télécharger used to point
the window at /download; WKWebView answers `canShowMIMEType()` with True for a
PDF or an image, so it rendered the file in the main frame and the app was
gone — no reload, no back navigation, no way out. Télécharger now writes the
file to the user's Downloads folder (POST /save) and the eye button renders it
inside a modal (GET /preview), so nothing ever navigates the window.

The security posture must not widen in the process: /preview serves a strict
subset of what /download serves, and /save keeps every gate /download had.
"""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

import pytest


# ── Fixtures ──────────────────────────────────────────────────────────────────

PDF_BYTES = b"%PDF-1.4\n% minimal, never parsed by these tests\n"
PNG_BYTES = (
    b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
    b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
)


def _store(content: bytes, rel: str = "acct/msg/file.bin") -> str:
    """Write `content` into the attachment store and return its storage_path."""
    from src import paths

    dest = paths.ATTACHMENTS_DIR / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(content)
    return rel


def _row(
    *,
    content: bytes = PDF_BYTES,
    filename: str = "facture.pdf",
    sniffed: str | None = "application/pdf",
    declared: str | None = "application/pdf",
    threat: str = "safe",
    storage_path: str | None = None,
    sha256: str | None = None,
    message_id: str = "<att-1@x>",
) -> int:
    """Insert one attachment row (and its file, unless storage_path is given
    explicitly) and return its id."""
    from src import database as db

    rel = storage_path if storage_path is not None else _store(
        content, f"acct/msg/{hashlib.sha256(content + filename.encode()).hexdigest()[:16]}.bin"
    )
    return db.insert_attachment(
        message_id=message_id,
        account_email="u@x.fr",
        filename=filename,
        content_type_declared=declared,
        content_type_sniffed=sniffed,
        size=len(content),
        sha256=sha256 or hashlib.sha256(content).hexdigest(),
        storage_path=rel,
        is_inline=False,
        threat_level=threat,
        threat_reasons_json="[]",
    )


@pytest.fixture(autouse=True)
def _default_policy(client, monkeypatch):
    """The attachment policy comes from config.yaml via cfg.get(), which raises
    when there is no config — and a per-test tempdir has none. Depends on
    `client` because that fixture re-imports src.* and would otherwise replace
    the module object this patches."""
    from src import api

    monkeypatch.setattr(api.cfg, "get", lambda: {})


@pytest.fixture
def downloads(monkeypatch, tmp_path):
    """Point the save route at a tempdir instead of the real ~/Downloads."""
    folder = tmp_path / "Téléchargements"
    monkeypatch.setenv("LULLMAIL_DOWNLOAD_DIR", str(folder))
    return folder


# ── Which rows get an eye button ──────────────────────────────────────────────


def test_the_summary_marks_a_safe_pdf_previewable(client):
    from src import api, database as db

    att_id = _row()
    summary = api._attachment_summary(db.get_attachment(att_id))
    assert summary["previewable"] is True
    assert summary["available"] is True


@pytest.mark.parametrize(
    "kwargs",
    [
        # A type no engine draws by itself — the button would open an empty modal.
        dict(filename="archive.zip", sniffed="application/zip", declared="application/zip"),
        # Markup with a script surface. served_content_type already neutralises
        # it to octet-stream, which is what keeps it out of the whitelist.
        dict(filename="page.svg", sniffed="text/plain", declared="image/svg+xml"),
        dict(filename="page.html", sniffed="text/plain", declared="text/html"),
        # Safari renders TIFF, Chromium does not: a button that works on one OS
        # and shows a blank frame on the other is worse than no button.
        dict(filename="scan.tiff", sniffed="image/tiff", declared="image/tiff"),
        # Not safe → never previewable, whatever the type claims.
        dict(filename="facture.pdf", sniffed="application/pdf",
             declared="application/pdf", threat="suspicious"),
        dict(filename="facture.pdf", sniffed="application/pdf",
             declared="application/pdf", threat="dangerous"),
    ],
)
def test_the_summary_withholds_the_eye_button(client, kwargs):
    from src import api, database as db

    att_id = _row(content=PDF_BYTES + kwargs["filename"].encode(), **kwargs)
    assert api._attachment_summary(db.get_attachment(att_id))["previewable"] is False


def test_a_blocked_row_is_never_previewable(client):
    """Blocked files were never written to disk; there are no bytes to draw."""
    from src import api, database as db

    att_id = _row(threat="blocked", storage_path=None, filename="virus.exe")
    assert api._attachment_summary(db.get_attachment(att_id))["previewable"] is False


# ── GET /preview ──────────────────────────────────────────────────────────────


def test_preview_serves_a_pdf_inline(client):
    att_id = _row()
    r = client.get(f"/api/attachments/{att_id}/preview")
    assert r.status_code == 200
    assert r.content == PDF_BYTES
    assert r.headers["content-type"].startswith("application/pdf")
    # inline, not attachment: this is what lets the modal's iframe draw it.
    assert r.headers["content-disposition"].startswith("inline")
    assert r.headers["x-content-type-options"] == "nosniff"


def test_the_preview_csp_does_not_blank_the_pdf_viewer(client):
    """`default-src 'none'` implies `object-src 'none'`, which is what a
    browser consults before handing a PDF to its built-in viewer, and CSP
    `sandbox` is the other way to lose the frame. /download wants both —
    nothing should ever render there. /preview cannot have either."""
    att_id = _row()
    csp = client.get(f"/api/attachments/{att_id}/preview").headers["content-security-policy"]
    assert "sandbox" not in csp
    assert "object-src 'self'" in csp
    assert "script-src 'none'" in csp
    assert "frame-ancestors 'self'" in csp


def test_download_keeps_the_strict_csp_and_forces_a_save(client):
    att_id = _row()
    r = client.get(f"/api/attachments/{att_id}/download")
    assert r.status_code == 200
    assert r.headers["content-disposition"].startswith("attachment")
    assert "sandbox" in r.headers["content-security-policy"]


def test_preview_refuses_a_type_it_cannot_draw(client):
    att_id = _row(content=b"PK\x03\x04zip", filename="archive.zip",
                  sniffed="application/zip", declared="application/zip")
    assert client.get(f"/api/attachments/{att_id}/preview").status_code == 415


def test_preview_refuses_a_dangerous_file_even_with_confirm(client):
    """The whitelist is safe-only, which is stricter than the confirm gate —
    so there is no `?confirm=1` that opens a preview."""
    att_id = _row(content=b"MZ\x90\x00", filename="facture.pdf.exe",
                  sniffed="application/x-msdownload", declared="application/pdf",
                  threat="dangerous")
    assert client.get(f"/api/attachments/{att_id}/preview?confirm=1").status_code == 415


def test_preview_refuses_a_storage_path_pointing_outside_the_store(client, tmp_path):
    outside = tmp_path / "secret.pdf"
    outside.write_bytes(PDF_BYTES)
    att_id = _row(storage_path="../../../secret.pdf", content=PDF_BYTES)
    assert client.get(f"/api/attachments/{att_id}/preview").status_code == 404


def test_preview_refuses_a_file_whose_bytes_changed_on_disk(client):
    from src import paths

    from src import database as db

    att_id = _row()
    rel = db.get_attachment(att_id)["storage_path"]
    (paths.ATTACHMENTS_DIR / rel).write_bytes(PDF_BYTES + b"tampered")
    assert client.get(f"/api/attachments/{att_id}/preview").status_code == 409


# ── POST /save ────────────────────────────────────────────────────────────────


def test_save_writes_the_file_into_the_downloads_folder(client, downloads):
    att_id = _row()
    r = client.post(f"/api/attachments/{att_id}/save")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["filename"] == "facture.pdf"
    assert body["directory"] == str(downloads.resolve())
    written = downloads / "facture.pdf"
    assert written.read_bytes() == PDF_BYTES
    assert body["path"] == str(written)


def test_saving_twice_keeps_both_copies(client, downloads):
    """A second save must not silently replace the first — same convention as
    every browser's Downloads folder."""
    att_id = _row()
    first = client.post(f"/api/attachments/{att_id}/save").json()["filename"]
    second = client.post(f"/api/attachments/{att_id}/save").json()["filename"]
    assert first == "facture.pdf"
    assert second == "facture (1).pdf"
    assert (downloads / second).read_bytes() == PDF_BYTES


def test_save_keeps_the_name_inside_the_downloads_folder(client, downloads, tmp_path):
    """The filename is the one value in the row the sender chose. It is
    re-sanitised on the way out, because this time it becomes a real path
    outside our data tree."""
    att_id = _row(filename="../../evil.pdf", content=PDF_BYTES)
    saved = client.post(f"/api/attachments/{att_id}/save").json()
    assert saved["path"].startswith(str(downloads.resolve()))
    assert not (tmp_path / "evil.pdf").exists()


def test_save_asks_again_before_a_dangerous_file(client, downloads):
    att_id = _row(content=b"MZ\x90\x00dangerous", filename="facture.exe",
                  sniffed="application/x-msdownload", declared="application/octet-stream",
                  threat="dangerous")
    refused = client.post(f"/api/attachments/{att_id}/save")
    assert refused.status_code == 403
    assert refused.json()["detail"]["error"] == "confirmation_required"
    assert not downloads.exists() or list(downloads.iterdir()) == []

    accepted = client.post(f"/api/attachments/{att_id}/save?confirm=1")
    assert accepted.status_code == 200
    assert (downloads / "facture.exe").exists()


def test_save_refuses_a_blocked_row(client, downloads):
    att_id = _row(threat="blocked", storage_path=None, filename="virus.exe")
    assert client.post(f"/api/attachments/{att_id}/save").status_code == 410


def test_save_leaves_nothing_behind_when_the_fingerprint_is_wrong(client, downloads):
    att_id = _row(sha256="0" * 64)
    assert client.post(f"/api/attachments/{att_id}/save").status_code == 409
    assert not downloads.exists() or list(downloads.iterdir()) == []


def test_save_refuses_an_unknown_attachment(client, downloads):
    assert client.post("/api/attachments/4242/save").status_code == 404


# ── POST /reveal ──────────────────────────────────────────────────────────────


def test_reveal_opens_the_folder_of_the_file_just_saved(client, downloads, monkeypatch):
    import subprocess

    att_id = _row()
    saved = client.post(f"/api/attachments/{att_id}/save").json()["path"]

    calls = []
    monkeypatch.setattr(subprocess, "Popen", lambda args, **kw: calls.append(args))
    r = client.post(f"/api/attachments/{att_id}/reveal")
    assert r.status_code == 200
    assert len(calls) == 1
    # Whatever the platform, the command names the saved path or its folder —
    # the file is never handed to the OS to *open*, which for an email
    # attachment is the one thing we must not do.
    argv = calls[0] if isinstance(calls[0], str) else " ".join(str(a) for a in calls[0])
    assert saved in argv or str(Path(saved).parent) in argv
    assert "open -R" in argv or not argv.startswith("open ")


@pytest.mark.skipif(sys.platform != "win32", reason="Explorer's own argument parsing")
def test_reveal_quotes_the_path_the_one_way_explorer_understands(client, downloads, monkeypatch):
    """`explorer /select,<path>` has to be ONE string with the path quoted
    inside the token. Passed as a list, Popen quotes the whole
    `/select,C:\\…` argument as soon as the path contains a space — and
    Explorer answers that by opening Documents, with no error anywhere."""
    import subprocess

    att_id = _row(filename="rapport de mars.pdf")
    saved = client.post(f"/api/attachments/{att_id}/save").json()["path"]
    assert " " in saved, "the regression needs a path with a space in it"

    calls = []
    monkeypatch.setattr(subprocess, "Popen", lambda args, **kw: calls.append(args))
    client.post(f"/api/attachments/{att_id}/reveal")
    assert calls == [f'explorer /select,"{saved}"']


def test_reveal_has_nothing_to_show_before_a_save(client, monkeypatch):
    import subprocess

    att_id = _row()
    calls = []
    monkeypatch.setattr(subprocess, "Popen", lambda args, **kw: calls.append(args))
    assert client.post(f"/api/attachments/{att_id}/reveal").status_code == 404
    assert calls == []


def test_reveal_never_takes_a_path_from_the_client(client, monkeypatch):
    """The route takes an attachment id and nothing else: a body naming a path
    is ignored, so an endpoint that opens anything on the machine never exists."""
    import subprocess

    att_id = _row()
    calls = []
    monkeypatch.setattr(subprocess, "Popen", lambda args, **kw: calls.append(args))
    r = client.post(f"/api/attachments/{att_id}/reveal",
                    json={"path": "C:/Windows", "folder": "/etc"})
    assert r.status_code == 404
    assert calls == []
