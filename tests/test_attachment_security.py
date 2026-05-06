"""
Wraps the pure functions of `src/attachment_security.py` so a regression
in the filename-sanitization or threat-detection paths surfaces in CI.
"""

from __future__ import annotations


def test_sanitize_filename_strips_path_traversal():
    from src.attachment_security import sanitize_filename
    assert sanitize_filename("../../etc/passwd") == "passwd"
    assert sanitize_filename("..\\..\\windows\\system32\\evil.exe") == "evil.exe"


def test_sanitize_filename_strips_nul_and_control():
    from src.attachment_security import sanitize_filename
    assert "\x00" not in sanitize_filename("file\x00.exe")
    assert sanitize_filename("hello\x07world.txt") == "helloworld.txt"


def test_sanitize_filename_handles_rtl_override():
    """CVE-2021-42574 Trojan Source on filenames — the bidi codepoints
    that flip text direction must be stripped."""
    from src.attachment_security import sanitize_filename
    rtl = "‮invoice.exe"  # U+202E = right-to-left override
    cleaned = sanitize_filename(rtl)
    assert "‮" not in cleaned


def test_sanitize_filename_rejects_windows_reserved():
    from src.attachment_security import sanitize_filename
    for name in ("CON", "PRN", "AUX.txt", "NUL.docx", "COM1.zip"):
        out = sanitize_filename(name)
        assert out == "attachment.bin"


def test_double_extension_detected():
    from src.attachment_security import has_double_extension
    assert has_double_extension("Invoice.pdf.exe") == "exe"
    assert has_double_extension("photo.jpg.scr") == "scr"
    assert has_double_extension("archive.tar.gz") is None  # legit
    assert has_double_extension("simple.txt") is None


def test_detect_threats_dangerous_extension():
    from src.attachment_security import detect_threats, THREAT_DANGEROUS
    report = detect_threats("payload.exe", "application/octet-stream", b"MZ\x90\x00")
    assert report.threat_level == THREAT_DANGEROUS


def test_detect_threats_eicar():
    from src.attachment_security import detect_threats, EICAR_SIGNATURE, THREAT_DANGEROUS
    report = detect_threats("test.txt", "text/plain", EICAR_SIGNATURE)
    assert report.threat_level == THREAT_DANGEROUS
    assert any("EICAR" in r for r in report.reasons)


def test_detect_threats_pdf_lying_as_exe():
    """A 'pdf' that's actually a Windows PE binary — magic-byte
    sniffing must call it out as dangerous regardless of declared MIME."""
    from src.attachment_security import detect_threats, THREAT_DANGEROUS
    report = detect_threats("invoice.pdf", "application/pdf", b"MZ\x90\x00\x03\x00")
    assert report.threat_level == THREAT_DANGEROUS


def test_sniff_content_recognises_common_formats():
    from src.attachment_security import sniff_content
    assert sniff_content(b"%PDF-1.4")[0] == "application/pdf"
    assert sniff_content(b"\x89PNG\r\n\x1a\n")[0] == "image/png"
    assert sniff_content(b"PK\x03\x04")[0] == "application/zip"
    assert sniff_content(b"MZ\x90\x00")[1] is True  # is_executable


def test_is_path_within_blocks_traversal(tmp_path):
    from src.attachment_security import is_path_within
    base = tmp_path
    inside = base / "child" / "file.bin"
    outside = tmp_path.parent / "elsewhere.bin"
    assert is_path_within(str(inside), str(base))
    assert not is_path_within(str(outside), str(base))
