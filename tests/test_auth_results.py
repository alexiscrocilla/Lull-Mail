# SPDX-License-Identifier: GPL-3.0-or-later
"""
SPF/DKIM/DMARC parser tests — small but covers every verdict path.
"""

from __future__ import annotations


def test_all_pass():
    from src.auth_results import parse, overall
    headers = ["mx.x; spf=pass smtp.mailfrom=u@d.com; dkim=pass header.i=@d.com; dmarc=pass header.from=d.com"]
    r = parse(headers)
    assert r == {"spf": "pass", "dkim": "pass", "dmarc": "pass"}
    assert overall(r) == "pass"


def test_dmarc_fail():
    from src.auth_results import parse, overall
    headers = ["mx.x; spf=fail; dkim=fail; dmarc=fail"]
    r = parse(headers)
    assert overall(r) == "fail"


def test_softfail_treated_as_fail():
    from src.auth_results import parse, overall
    headers = ["mx.x; spf=softfail; dkim=pass; dmarc=pass"]
    assert overall(parse(headers)) == "fail"


def test_partial_coverage_warns():
    from src.auth_results import parse, overall
    headers = ["mx.x; spf=pass; dkim=none; dmarc=none"]
    assert overall(parse(headers)) == "warn"


def test_no_headers_unknown():
    from src.auth_results import parse, overall
    assert overall(parse([])) == "unknown"
    assert overall(parse(None)) == "unknown"


def test_only_last_header_trusted():
    """Earlier hops can be replayed — only the receiving MTA's header
    counts. We trust the LAST entry in the list."""
    from src.auth_results import parse
    headers = [
        "evil-mta; spf=pass; dkim=pass; dmarc=pass",  # attacker can fake this
        "trusted-mta; spf=fail; dkim=fail; dmarc=fail",  # this wins
    ]
    r = parse(headers)
    assert r["spf"] == "fail"
    assert r["dkim"] == "fail"


def test_received_spf_fallback():
    from src.auth_results import parse_received_spf
    assert parse_received_spf("pass (domain of x designates …)") == "pass"
    assert parse_received_spf("fail") == "fail"
    assert parse_received_spf(None) is None
    assert parse_received_spf("garbage") is None
