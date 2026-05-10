# SPDX-License-Identifier: GPL-3.0-or-later
"""Attachment security policy.

Email attachments are the #1 attack vector (phishing, droppers, ransomware,
spyware). This module enforces defense-in-depth before we ever write a byte
to disk or hand bytes back to the browser:

  1. Filename sanitization     — kills path traversal, NUL/RTL spoofing,
                                 reserved Windows names, double-extension
                                 tricks ("Invoice.pdf.exe").
  2. Extension classification  — explicit blocklist for executables and
                                 LNK/script families; suspicious tier for
                                 macro-enabled Office.
  3. Magic-byte sniffing       — confirms or contradicts the declared MIME
                                 type. A .pdf claiming application/pdf but
                                 starting with "MZ" is a Windows binary.
  4. Known-malware signatures  — EICAR test pattern + a couple of canonical
                                 dropper magics. We don't ship a real AV
                                 engine; this catches the obvious.
  5. Size + count caps         — enforced by the caller using policy().
  6. Threat level              — final verdict the API + UI honor when
                                 deciding whether to serve, warn, or block.

Everything is conservative: we err on the side of blocking. Users can still
preview metadata, just not download a `dangerous` file without explicit
confirmation.
"""

from __future__ import annotations

import hashlib
import os
import re
import unicodedata
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

# ── Threat tiers (UI / API rely on these exact strings) ───────────────────────

THREAT_SAFE       = "safe"
THREAT_SUSPICIOUS = "suspicious"
THREAT_DANGEROUS  = "dangerous"
THREAT_BLOCKED    = "blocked"      # never written to disk; metadata only


# ── Extension blocklists ──────────────────────────────────────────────────────

# Direct execution risks on Windows / cross-platform droppers. Double-clicking
# any of these can run arbitrary code with the user's privileges. We refuse to
# write them to disk in `block_dangerous` mode and force `application/octet-
# stream` + the explicit-confirm download path otherwise.
DANGEROUS_EXTENSIONS = {
    # PE executables / installers
    "exe", "scr", "com", "pif", "msi", "msp", "mst", "cpl", "dll", "sys", "drv",
    # Scripts (run by Windows shell or default associations)
    "bat", "cmd", "vbs", "vbe", "js", "jse", "wsf", "wsh", "ps1", "ps2", "psm1",
    "psc1", "msh", "msh1", "msh2", "mshxml", "ws", "hta", "scf", "lnk", "url",
    "reg", "inf", "gadget", "application", "appref-ms",
    # Containerised executables / disk images often used to bypass MOTW
    "iso", "img", "vhd", "vhdx", "msix", "msixbundle", "appx", "appxbundle",
    # JVM / cross-platform
    "jar", "class",
    # Mac / Linux (rare in Windows desktop traffic, still dangerous)
    "app", "command", "deb", "rpm", "apk", "ipa", "dmg", "pkg",
    # Help files: CHM can execute arbitrary code via embedded scripts
    "chm",
}

# Macro-enabled Office files: legitimate but the historical malware vehicle.
# We don't block; we warn.
SUSPICIOUS_EXTENSIONS = {
    "docm", "dotm", "xlsm", "xltm", "xlam", "pptm", "potm", "ppam", "ppsm",
    "sldm",
    # "Old" Office formats — modern Outlook still receives them, and they
    # carry macros invisibly.
    "doc", "xls", "ppt",
    # Archive formats: compression bombs, hidden binaries. We don't unpack
    # them; we only flag the wrapper.
    "zip", "rar", "7z", "ace", "arj", "cab", "tar", "gz", "tgz", "bz2", "xz",
    "z", "lz", "lzma", "zst",
    # Office add-ins
    "xll", "xlam",
    # SVG can carry inline JS (XSS via webview / <object>)
    "svg",
    # HTML / scriptable docs delivered "as a file"
    "htm", "html", "xhtml", "mht", "mhtml",
}

# Generally safe (still served via download — never inline-rendered).
SAFE_EXTENSIONS = {
    "pdf",
    "txt", "csv", "tsv", "log", "md", "rst",
    "json", "xml", "yaml", "yml", "ics",
    "docx", "xlsx", "pptx", "odt", "ods", "odp",
    "rtf",
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "ico", "heic",
    "mp3", "wav", "flac", "ogg", "oga", "opus", "m4a", "aac",
    "mp4", "mov", "webm", "mkv", "avi", "wmv",
    "epub", "mobi",
    "eml", "msg",
}

# Windows reserved device names — even if extension is innocent, the OS will
# refuse to open these and they can crash poorly written tools.
WINDOWS_RESERVED = {
    "con", "prn", "aux", "nul",
    *(f"com{i}" for i in range(0, 10)),   # com0..com9
    *(f"lpt{i}" for i in range(0, 10)),   # lpt0..lpt9
}

# Filename characters we strip outright. Includes:
#  - path separators
#  - ASCII control chars (0x00..0x1F, 0x7F)
#  - Unicode bidirectional/control codepoints used in RTL spoofing attacks
#    (CVE-2021-42574 "Trojan Source" applies to filenames too)
_FILENAME_FORBIDDEN = re.compile(
    r'[\x00-\x1f\x7f<>:"/\\|?*'
    r'‪‫‬‭‮⁦⁧⁨⁩]'
)


# ── Magic-byte signatures ─────────────────────────────────────────────────────

# Magic bytes → (sniffed_mime, is_executable). The list is intentionally
# small and high-confidence; we only need to refuse obvious lies (a "PDF"
# that's really a PE binary) and surface a sensible Content-Type for safe
# files. A real AV / fingerprinting library is out of scope.
_MAGIC_SIGNATURES: List[Tuple[bytes, str, bool]] = [
    # Executables / containers we *never* trust
    (b"MZ",                     "application/x-msdownload", True),    # PE/COFF
    (b"\x7fELF",                "application/x-executable", True),    # ELF
    (b"\xca\xfe\xba\xbe",       "application/x-mach-binary", True),   # Mach-O fat
    (b"\xcf\xfa\xed\xfe",       "application/x-mach-binary", True),   # Mach-O 64
    (b"\xfe\xed\xfa\xce",       "application/x-mach-binary", True),   # Mach-O 32
    (b"\xfe\xed\xfa\xcf",       "application/x-mach-binary", True),
    (b"#!/",                    "text/x-shellscript", True),          # any shebang
    # Archives (suspicious wrappers, not executables themselves)
    (b"PK\x03\x04",             "application/zip", False),            # zip / docx / xlsx / jar
    (b"PK\x05\x06",             "application/zip", False),            # empty zip
    (b"PK\x07\x08",             "application/zip", False),            # spanned zip
    (b"Rar!\x1a\x07\x00",       "application/x-rar-compressed", False),
    (b"Rar!\x1a\x07\x01\x00",   "application/x-rar-compressed", False),
    (b"7z\xbc\xaf\x27\x1c",     "application/x-7z-compressed", False),
    (b"\x1f\x8b",               "application/gzip", False),
    (b"BZh",                    "application/x-bzip2", False),
    (b"\xfd7zXZ\x00",           "application/x-xz", False),
    # Documents
    (b"%PDF-",                  "application/pdf", False),
    (b"{\\rtf",                 "application/rtf", False),
    (b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1",  # OLE2 — legacy Office, .msi, .doc, .xls
                                "application/x-ole-storage", False),
    # Images
    (b"\x89PNG\r\n\x1a\n",      "image/png", False),
    (b"\xff\xd8\xff",           "image/jpeg", False),
    (b"GIF87a",                 "image/gif", False),
    (b"GIF89a",                 "image/gif", False),
    (b"BM",                     "image/bmp", False),
    (b"RIFF",                   "image/webp", False),  # actual webp check below
    (b"II*\x00",                "image/tiff", False),
    (b"MM\x00*",                "image/tiff", False),
    # Audio / video
    (b"ID3",                    "audio/mpeg", False),
    (b"OggS",                   "audio/ogg", False),
    (b"fLaC",                   "audio/flac", False),
    # Disk images / installers (treat as dangerous)
    (b"CD001",                  "application/x-iso9660-image", True),  # ISO9660 (offset 0x8001 normally; partial)
    (b"\x00\x00\x00\x14ftyp",   "video/mp4", False),
    (b"\x00\x00\x00\x18ftyp",   "video/mp4", False),
    (b"\x00\x00\x00\x20ftyp",   "video/mp4", False),
]

# Tail-end signature for Microsoft Compiled HTML (CHM) — contains JS often
# weaponised in droppers.
_CHM_MAGIC = b"ITSF"

# EICAR antivirus test signature — both flag the file *and* prove our
# pipeline runs end-to-end during pen-tests. The literal pattern is split
# across the source so this very file isn't quarantined by upstream AV.
EICAR_SIGNATURE = (
    b"X5O!P%@AP[4\\PZX54(P^)7CC)7}"
    b"$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"
)

# ── Policy bundle ─────────────────────────────────────────────────────────────

@dataclass
class AttachmentPolicy:
    """Everything tunable from `config.yaml > attachments`."""
    enabled: bool = True
    max_size_mb: int = 25                 # per-file cap
    max_total_mb_per_email: int = 50      # all attachments combined
    max_count_per_email: int = 25
    block_dangerous: bool = True          # refuse to persist `dangerous` files
    block_suspicious: bool = False        # off by default — they're often legit
    download_requires_confirm: bool = True  # `dangerous` → 403 unless ?confirm=1


@dataclass
class ThreatReport:
    threat_level: str
    reasons: List[str] = field(default_factory=list)
    sniffed_mime: Optional[str] = None
    is_executable: bool = False

    def merge(self, other: "ThreatReport") -> "ThreatReport":
        order = [THREAT_SAFE, THREAT_SUSPICIOUS, THREAT_DANGEROUS, THREAT_BLOCKED]
        new_level = max([self.threat_level, other.threat_level], key=order.index)
        return ThreatReport(
            threat_level=new_level,
            reasons=self.reasons + other.reasons,
            sniffed_mime=self.sniffed_mime or other.sniffed_mime,
            is_executable=self.is_executable or other.is_executable,
        )


# ── Filename sanitization ─────────────────────────────────────────────────────

def sanitize_filename(raw: Optional[str], fallback: str = "attachment.bin") -> str:
    """Return a filename safe to display, store in the DB, and put in the
    `Content-Disposition` header.

    Strips: NUL, control chars, RTL/LTR override codepoints, path separators,
    Windows-illegal punctuation, leading/trailing dots & spaces. Truncates
    to 200 bytes (UTF-8). Rejects Windows reserved device names. Strips any
    embedded path components — only the basename is kept.
    """
    if not raw:
        return fallback

    # 1. Normalise and drop anything that looks like a path. We split on path
    #    separators (Windows `\`, POSIX `/`) and keep the basename. NFKC also
    #    collapses fullwidth chars used to evade filters. NUL is *not* split
    #    on — splitting would let `foo\x00bar.exe` become `bar.exe`, which is
    #    the exact spoof we want to defeat. NUL is stripped further down by
    #    the forbidden-chars regex so the parts re-merge into `foobar.exe`.
    name = unicodedata.normalize("NFKC", str(raw))
    for sep in ("/", "\\"):
        if sep in name:
            name = name.rsplit(sep, 1)[-1]

    # 2. Strip forbidden chars (control + bidi + path metas).
    name = _FILENAME_FORBIDDEN.sub("", name)

    # 3. Trim leading/trailing dots and spaces (Windows quirk: "foo.exe " is
    #    treated as "foo.exe" by the OS even though our extension check
    #    sees the trailing space).
    name = name.strip(" .")

    # 4. Reject empty / dotfile-only.
    if not name or name in {".", ".."}:
        return fallback

    # 5. Block Windows reserved device names regardless of extension. CON.txt
    #    is just as un-openable as plain CON.
    stem = name.split(".", 1)[0].lower()
    if stem in WINDOWS_RESERVED:
        return fallback

    # 6. Cap length (filesystems handle 255 bytes; we keep headroom for
    #    Content-Disposition encoding).
    encoded = name.encode("utf-8", errors="ignore")
    if len(encoded) > 200:
        # Preserve the extension; truncate the stem.
        if "." in name:
            stem, dot, ext = name.rpartition(".")
            ext = ext[:30]
            stem = stem.encode("utf-8", errors="ignore")[: 200 - len(ext) - 1].decode("utf-8", errors="ignore")
            name = f"{stem}.{ext}"
        else:
            name = encoded[:200].decode("utf-8", errors="ignore")

    return name or fallback


def get_extension(filename: str) -> str:
    """Return the lowercase last extension, or '' if none.

    `report.PDF` → `pdf`. `archive.tar.gz` → `gz`. Used by the classifier;
    double-extension detection is handled separately in detect_threats.
    """
    if not filename or "." not in filename:
        return ""
    return filename.rsplit(".", 1)[-1].lower()


def has_double_extension(filename: str) -> Optional[str]:
    """Return the suspicious "outer" extension if the filename uses the
    classic "Invoice.pdf.exe" trick; None otherwise.

    We only flag double-extensions where the *last* segment is dangerous AND
    a known content-y extension (pdf/doc/xls/jpg/png/zip…) precedes it.
    Plain `archive.tar.gz` doesn't trigger.
    """
    if not filename or filename.count(".") < 2:
        return None
    parts = filename.lower().rsplit(".", 2)
    if len(parts) < 3:
        return None
    _, inner, outer = parts
    if outer in DANGEROUS_EXTENSIONS and (inner in SAFE_EXTENSIONS or inner in SUSPICIOUS_EXTENSIONS):
        return outer
    return None


# ── Magic-byte sniffing ───────────────────────────────────────────────────────

def sniff_content(content: bytes) -> Tuple[Optional[str], bool]:
    """Return (sniffed_mime, is_executable_or_disk_image).

    Reads at most the first 32 bytes — magic-byte signatures live there.
    Adds two fixups:
      - RIFF needs to peek at offset 8 to confirm WEBP vs. WAV vs. AVI.
      - OOXML containers (.docx/.xlsx/.pptx) all start with PK and are
        disambiguated by zip directory contents, which we don't unpack — we
        simply report `application/zip` and let the declared MIME refine.
    """
    if not content:
        return (None, False)
    head = content[:32]

    for magic, mime, is_exec in _MAGIC_SIGNATURES:
        if head.startswith(magic):
            # RIFF disambiguation
            if magic == b"RIFF" and len(content) >= 12:
                fmt = content[8:12]
                if fmt == b"WEBP":
                    return ("image/webp", False)
                if fmt == b"WAVE":
                    return ("audio/wav", False)
                if fmt == b"AVI ":
                    return ("video/x-msvideo", False)
                return ("application/octet-stream", False)
            return (mime, is_exec)

    # CHM files have a leading "ITSF" magic.
    if head.startswith(_CHM_MAGIC):
        return ("application/vnd.ms-htmlhelp", True)

    # Heuristic: ASCII-printable head with newlines → text.
    try:
        sample = content[:4096].decode("utf-8")
        if all(c.isprintable() or c in "\r\n\t" for c in sample[:128]):
            return ("text/plain", False)
    except UnicodeDecodeError:
        pass

    return (None, False)


# ── Threat assessment ─────────────────────────────────────────────────────────

def detect_threats(
    filename: str,
    declared_mime: Optional[str],
    content: bytes,
) -> ThreatReport:
    """Synthesize a `ThreatReport` for one attachment.

    The caller decides what to do based on `report.threat_level`:
      - safe        → store + serve normally
      - suspicious  → store, warn in UI, force `application/octet-stream`
      - dangerous   → with `block_dangerous`: refuse to store; otherwise
                      store but require explicit confirm to download
      - blocked     → only when policy.block_suspicious is on AND the file
                      is also suspicious (escalation)

    `content` may be the full payload or a head — we sniff against the
    leading 32 bytes either way, but EICAR detection scans up to 4 KB.
    """
    reasons: List[str] = []
    level = THREAT_SAFE

    # 1. EICAR — the canonical AV test pattern.
    if EICAR_SIGNATURE in content[:4096]:
        reasons.append("Signature de test antivirus EICAR détectée")
        level = THREAT_DANGEROUS

    # 2. Extension classification.
    ext = get_extension(filename)
    if ext in DANGEROUS_EXTENSIONS:
        reasons.append(f"Extension exécutable .{ext}")
        level = THREAT_DANGEROUS
    elif ext in SUSPICIOUS_EXTENSIONS:
        reasons.append(f"Extension à risque .{ext} (macros / archive / script)")
        if level == THREAT_SAFE:
            level = THREAT_SUSPICIOUS
    elif ext and ext not in SAFE_EXTENSIONS:
        reasons.append(f"Extension non listée .{ext}")
        if level == THREAT_SAFE:
            level = THREAT_SUSPICIOUS

    # 3. Double-extension trickery: "Invoice.pdf.exe".
    outer = has_double_extension(filename)
    if outer:
        reasons.append(f"Double extension détectée (.{outer} masqué)")
        level = THREAT_DANGEROUS

    # 4. Magic-byte vs. declared MIME consistency check.
    sniffed_mime, sniffed_exec = sniff_content(content)
    if sniffed_exec:
        reasons.append(f"Contenu binaire exécutable ({sniffed_mime or 'inconnu'})")
        level = THREAT_DANGEROUS

    if declared_mime and sniffed_mime:
        # Compare top-level types; minor subtype mismatches (image/jpeg vs.
        # image/jpg) shouldn't escalate, but text/plain claiming
        # application/x-msdownload should.
        decl_main = declared_mime.split("/", 1)[0].lower()
        sniff_main = sniffed_mime.split("/", 1)[0].lower()
        if decl_main != sniff_main and not (decl_main == "application" and sniff_main == "application"):
            # Special case: Office documents declare specific types but the
            # ZIP container sniffs as application/zip. Don't flag that as a
            # mismatch — it's expected.
            ooxml_types = {
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            }
            if not (declared_mime in ooxml_types and sniffed_mime == "application/zip"):
                reasons.append(
                    f"Type MIME incohérent (déclaré: {declared_mime}, détecté: {sniffed_mime})"
                )
                if level == THREAT_SAFE:
                    level = THREAT_SUSPICIOUS

    # 5. Filename red flags (zero-width / Cyrillic homoglyphs in extension).
    if any(0x0400 <= ord(c) <= 0x04FF for c in (filename or "").rsplit(".", 1)[-1]):
        reasons.append("Caractères cyrilliques dans l'extension (homographe possible)")
        if level == THREAT_SAFE:
            level = THREAT_SUSPICIOUS

    return ThreatReport(
        threat_level=level,
        reasons=reasons,
        sniffed_mime=sniffed_mime,
        is_executable=sniffed_exec,
    )


# ── Storage path helpers ──────────────────────────────────────────────────────

def storage_subpath(account_email: str, message_id: str) -> str:
    """Return a relative directory `<acct_hash>/<msg_hash>` keeping the on-
    disk tree unguessable and short. Both segments are 16 hex chars of
    SHA-256, which is plenty for collision avoidance and small enough to
    keep paths readable in logs.
    """
    a = hashlib.sha256((account_email or "").lower().encode("utf-8")).hexdigest()[:16]
    m = hashlib.sha256((message_id or "").encode("utf-8")).hexdigest()[:16]
    return f"{a}/{m}"


def is_path_within(child: str, parent: str) -> bool:
    """Return True iff `child` is inside `parent` after symlink resolution.

    Used by the download endpoint as a last-ditch traversal guard: even if
    a malicious DB row contained `../../etc/passwd`, the resolved absolute
    path must still live under the configured attachments directory.
    """
    try:
        c = os.path.realpath(os.path.abspath(child))
        p = os.path.realpath(os.path.abspath(parent))
        return os.path.commonpath([c, p]) == p
    except (ValueError, OSError):
        return False


def safe_disposition_header(filename: str) -> str:
    """Build a robust `Content-Disposition: attachment` header.

    Always uses RFC 5987 (`filename*=UTF-8''…`) so non-ASCII names survive
    Outlook/Thunderbird-style names. Never honors `inline` — every
    attachment is forced to download to keep the browser from rendering
    untrusted HTML/SVG/PDF in-tab.
    """
    from urllib.parse import quote
    safe_ascii = re.sub(r'[^A-Za-z0-9._\-]', "_", filename) or "attachment.bin"
    encoded = quote(filename.encode("utf-8"), safe="")
    return f"attachment; filename=\"{safe_ascii}\"; filename*=UTF-8''{encoded}"


def hardened_response_headers(threat_level: str) -> Dict[str, str]:
    """Return headers that neutralize browser content sniffing + sandboxing.

    Applied to every download regardless of threat level. The CSP `sandbox`
    directive ensures even an HTML/SVG payload can't run scripts if the
    user opens it in a new tab via the browser viewer instead of saving.
    """
    return {
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox;",
        "Referrer-Policy": "no-referrer",
        "Cross-Origin-Resource-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
        "Cache-Control": "private, no-store",
        "X-Attachment-Threat-Level": threat_level,  # debugging / client UI
    }


def served_content_type(threat_level: str, sniffed: Optional[str], declared: Optional[str]) -> str:
    """Pick the MIME type we send to the browser.

    Anything `dangerous` or `suspicious` is forced to `application/octet-
    stream` so no helper application or browser plugin auto-launches the
    payload. For safe content we prefer the sniffed type (the email-
    declared MIME is attacker-controlled).
    """
    if threat_level in (THREAT_DANGEROUS, THREAT_SUSPICIOUS, THREAT_BLOCKED):
        return "application/octet-stream"
    # Always neutralise text/html and SVG regardless of how they got declared.
    # Even with `Content-Disposition: attachment` some browsers + extensions
    # will preview HTML; rendering attacker markup in-tab is exactly what
    # CSP is meant to stop, but the simplest defense is "don't say it's HTML".
    for candidate in (sniffed, declared):
        if not candidate:
            continue
        low = candidate.lower()
        if low.startswith("text/html") or low.startswith("application/xhtml") or low.startswith("image/svg"):
            return "application/octet-stream"
    if sniffed:
        return sniffed
    if declared:
        return declared
    return "application/octet-stream"


def policy_from_config(conf: Dict) -> AttachmentPolicy:
    """Build an `AttachmentPolicy` from the `attachments` config block,
    falling back to safe defaults when the key is missing."""
    raw = (conf or {}).get("attachments") or {}
    return AttachmentPolicy(
        enabled=bool(raw.get("enabled", True)),
        max_size_mb=int(raw.get("max_size_mb", 25)),
        max_total_mb_per_email=int(raw.get("max_total_mb_per_email", 50)),
        max_count_per_email=int(raw.get("max_count_per_email", 25)),
        block_dangerous=bool(raw.get("block_dangerous", True)),
        block_suspicious=bool(raw.get("block_suspicious", False)),
        download_requires_confirm=bool(raw.get("download_requires_confirm", True)),
    )
