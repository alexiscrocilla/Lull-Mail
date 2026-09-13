# SPDX-License-Identifier: GPL-3.0-or-later
"""Adding, editing or deleting an account has to reach the IDLE watchers.

The account routes rewrote config.yaml and stopped there. The watchers
kept running against the roster they were started with, so a deleted
account held its IMAP connection open until the next restart and a new
one had no push at all -- a mailbox that just does not deliver instantly
while the one beside it does.
"""

from __future__ import annotations

import yaml


def _seed_config(cfg, emails=("a@x.fr",)):
    cfg.CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(cfg.CONFIG_PATH, "w", encoding="utf-8") as f:
        yaml.safe_dump({
            "openai": {"api_key": "", "model": "gpt-4o-mini"},
            "accounts": [{
                "name": e.split("@")[0], "email": e, "imap_host": "imap.x",
                "imap_port": 993, "username": e, "password": "seeded-password",
                "ssl": True, "enabled": True,
            } for e in emails],
        }, f)


class _SpyManager:
    """Stands in for the real IdleManager: records the rosters it is given."""

    def __init__(self):
        self.rosters = []

    def start(self, accounts, on_new_mail):
        emails = [a["email"] for a in accounts]
        self.rosters.append(emails)
        return emails

    def stop(self, join_timeout: float = 2.0):
        self.rosters.append([])


def _install_spy(monkeypatch):
    from src import lifecycle
    spy = _SpyManager()
    monkeypatch.setattr(lifecycle, "idle_manager", spy)
    # reconcile_idle() no-ops while the app is still in setup mode, which is
    # the state a freshly imported module is in. Pretend the services are up.
    monkeypatch.setattr(lifecycle, "_scheduler", object())
    return spy


def test_adding_an_account_starts_watching_it(client, monkeypatch):
    from src import config as cfg
    _seed_config(cfg)
    spy = _install_spy(monkeypatch)

    r = client.post("/api/setup/accounts", json={
        "name": "Pro", "email": "b@x.fr", "imap_host": "imap.x",
        "imap_port": 993, "username": "b@x.fr", "password": "hunter2",
        "ssl": True, "enabled": True,
    })
    assert r.status_code == 200, r.text

    assert spy.rosters, "the new account was saved but nothing was told to watch it"
    assert spy.rosters[-1] == ["a@x.fr", "b@x.fr"]


def test_deleting_an_account_stops_watching_it(client, monkeypatch):
    from src import config as cfg
    _seed_config(cfg, emails=("a@x.fr", "b@x.fr"))
    spy = _install_spy(monkeypatch)

    r = client.delete("/api/setup/accounts/b@x.fr")
    assert r.status_code == 200, r.text

    assert spy.rosters, "the account is gone from config but its socket is not"
    assert spy.rosters[-1] == ["a@x.fr"]


def test_disabling_an_account_drops_it_from_the_watchers(client, monkeypatch):
    from src import config as cfg
    _seed_config(cfg, emails=("a@x.fr", "b@x.fr"))
    spy = _install_spy(monkeypatch)

    r = client.put("/api/setup/accounts/b@x.fr", json={
        "name": "B", "email": "b@x.fr", "imap_host": "imap.x",
        "imap_port": 993, "username": "b@x.fr", "password": "********",
        "ssl": True, "enabled": False,
    })
    assert r.status_code == 200, r.text

    assert spy.rosters[-1] == ["a@x.fr"]


def test_a_failing_reconcile_never_fails_the_write(client, monkeypatch):
    """Push is an accelerator. The account is already on disk by then."""
    from src import config as cfg, lifecycle
    _seed_config(cfg)

    def boom(*_a, **_k):
        raise RuntimeError("IMAP server unreachable")

    monkeypatch.setattr(lifecycle, "reconcile_idle", boom)

    r = client.post("/api/setup/accounts", json={
        "name": "Pro", "email": "c@x.fr", "imap_host": "imap.x",
        "imap_port": 993, "username": "c@x.fr", "password": "hunter2",
        "ssl": True, "enabled": True,
    })
    assert r.status_code == 200, r.text
    with open(cfg.CONFIG_PATH) as f:
        saved = yaml.safe_load(f)
    assert [a["email"] for a in saved["accounts"]] == ["a@x.fr", "c@x.fr"]
