# SPDX-License-Identifier: GPL-3.0-or-later
"""The release pipeline's signing chain, end to end.

Every piece of this existed and was individually tested; what nobody tested
was that they connect. `sign_update_manifest.py` reads `*.artifact.json`
sidecars, and nothing in the repository produced one — so the script could
not run at all, no release ever carried a manifest, and because
`check_for_update()` fails closed on an empty or unverifiable manifest, every
shipped build would have refused updates for ever.

These tests run the real scripts over real files. The key pair is generated
in-process and never leaves it.
"""

from __future__ import annotations

import base64
import json
import runpy
import subprocess
import sys
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"


@pytest.fixture
def keypair():
    private = Ed25519PrivateKey.generate()
    raw_private = private.private_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PrivateFormat.Raw,
        encryption_algorithm=serialization.NoEncryption(),
    )
    raw_public = private.public_key().public_bytes(
        encoding=serialization.Encoding.Raw,
        format=serialization.PublicFormat.Raw,
    )
    return base64.b64encode(raw_private).decode(), base64.b64encode(raw_public).decode()


def _trusted_repo() -> str:
    """The repository the shipped binaries accept downloads from.

    Read rather than hard-coded: if GITHUB_REPO ever moves, the manifest
    URLs move with it and this test keeps meaning what it says.
    """
    from src.updater import GITHUB_REPO
    return GITHUB_REPO


def _build_artifacts(tmp_path: Path) -> Path:
    """Three files shaped like the ones the three build jobs upload."""
    out = tmp_path / "release-assets"
    out.mkdir()
    for name, plat, arch, install in [
        ("LullMail-Setup-9.9.9.exe", "windows", "X64", "inno"),
        ("LullMail-9.9.9.dmg", "macos", "arm64", "dmg"),
        ("LullMail-9.9.9.tar.gz", "linux", "X64", "tar.gz"),
    ]:
        (out / name).write_bytes(name.encode() * 32)
        rc = subprocess.run(
            [sys.executable, str(SCRIPTS / "write_artifact_sidecar.py"),
             "--file", str(out / name), "--platform", plat,
             "--arch", arch, "--install", install],
            capture_output=True, text=True)
        assert rc.returncode == 0, rc.stderr
    return out


def _sign(artifact_dir: Path, private_b64: str, key_id: str = "test-key",
          version: str = "9.9.9") -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(SCRIPTS / "sign_update_manifest.py"),
         "--artifact-dir", str(artifact_dir), "--repo", _trusted_repo(),
         "--tag", f"v{version}", "--version", version, "--key-id", key_id,
         "--private-key", private_b64],
        capture_output=True, text=True)


def test_the_sidecars_the_build_jobs_write_are_the_ones_the_signer_reads(tmp_path, keypair):
    """The missing link. The signer globs *.artifact.json and raised
    "No *.artifact.json sidecars found" because nothing wrote any."""
    private_b64, _ = keypair
    artifacts = _build_artifacts(tmp_path)

    assert sorted(p.name for p in artifacts.glob("*.artifact.json")) == [
        "LullMail-9.9.9.dmg.artifact.json",
        "LullMail-9.9.9.tar.gz.artifact.json",
        "LullMail-Setup-9.9.9.exe.artifact.json",
    ]
    rc = _sign(artifacts, private_b64)
    assert rc.returncode == 0, rc.stderr
    assert (artifacts / "updates-v1.json").is_file()
    assert (artifacts / "updates-v1.json.sig").is_file()


def test_the_signed_manifest_is_one_a_shipped_build_can_verify(tmp_path, keypair, fresh_app):
    from src.updater import verify_manifest_bytes

    private_b64, public_b64 = keypair
    artifacts = _build_artifacts(tmp_path)
    assert _sign(artifacts, private_b64).returncode == 0

    manifest = verify_manifest_bytes(
        (artifacts / "updates-v1.json").read_bytes(),
        (artifacts / "updates-v1.json.sig").read_bytes(),
        keys={"test-key": base64.b64decode(public_b64)},
    )
    assert manifest["version"] == "9.9.9"
    assert manifest["_verified_key_id"] == "test-key"


def test_every_platform_key_is_one_the_app_will_actually_ask_for(tmp_path, keypair, fresh_app):
    """A typo in a sidecar produces a manifest that parses and matches
    nothing — the app reports "no update" for ever, with no error."""
    from src import updater

    private_b64, _ = keypair
    artifacts = _build_artifacts(tmp_path)
    assert _sign(artifacts, private_b64).returncode == 0
    manifest = json.loads((artifacts / "updates-v1.json").read_text(encoding="utf-8"))

    assert set(manifest["artifacts"]) == {
        "windows-x86_64", "macos-arm64", "linux-x86_64"}
    # And each names a real file with the right size and digest.
    for key, art in manifest["artifacts"].items():
        local = artifacts / art["name"]
        assert local.is_file(), key
        assert local.stat().st_size == art["size"]
    # The install kinds are the three src/updater.py accepts.
    assert {a["install"] for a in manifest["artifacts"].values()} == {"inno", "dmg", "tar.gz"}
    for key, art in manifest["artifacts"].items():
        assert updater._validate_artifact(art)["install"] == art["install"]


def test_the_release_gate_rejects_a_key_the_builds_do_not_trust(tmp_path, keypair, monkeypatch):
    """The whole point of the verify step: signing with the wrong private
    key produces a release no install can see, and that must fail the build
    rather than reach users."""
    private_b64, _ = keypair
    other_public = base64.b64encode(
        Ed25519PrivateKey.generate().public_key().public_bytes(
            encoding=serialization.Encoding.Raw,
            format=serialization.PublicFormat.Raw)).decode()

    artifacts = _build_artifacts(tmp_path)
    assert _sign(artifacts, private_b64).returncode == 0

    rc = subprocess.run(
        [sys.executable, str(SCRIPTS / "verify_release_manifest.py"),
         "--artifact-dir", str(artifacts)],
        capture_output=True, text=True,
        env={**dict(__import__("os").environ),
             "LULLMAIL_UPDATE_PUBLIC_KEYS": json.dumps({"test-key": other_public})})
    assert rc.returncode != 0
    assert "cannot verify" in (rc.stdout + rc.stderr)


def test_the_release_gate_passes_with_the_matching_key(tmp_path, keypair):
    private_b64, public_b64 = keypair
    artifacts = _build_artifacts(tmp_path)
    assert _sign(artifacts, private_b64).returncode == 0

    rc = subprocess.run(
        [sys.executable, str(SCRIPTS / "verify_release_manifest.py"),
         "--artifact-dir", str(artifacts)],
        capture_output=True, text=True,
        env={**dict(__import__("os").environ),
             "LULLMAIL_UPDATE_PUBLIC_KEYS": json.dumps({"test-key": public_b64})})
    assert rc.returncode == 0, rc.stdout + rc.stderr
    assert "3 artifact(s)" in rc.stdout


def test_a_release_build_refuses_to_bake_an_empty_trust_store(tmp_path, monkeypatch):
    """LULLMAIL_REQUIRE_SIGNED_UPDATES=1 is what release.yml now sets. Without
    it the build silently succeeded with TRUSTED_UPDATE_KEYS = {} and the
    installer could never be repaired — the keys are sealed at build time."""
    monkeypatch.setenv("LULLMAIL_REQUIRE_SIGNED_UPDATES", "1")
    monkeypatch.delenv("LULLMAIL_UPDATE_PUBLIC_KEYS", raising=False)
    with pytest.raises(SystemExit) as excinfo:
        runpy.run_path(str(SCRIPTS / "embed_update_keys.py"), run_name="__main__")
    assert "required for a signed release build" in str(excinfo.value)


def test_the_embedder_accepts_the_shape_new_update_key_prints(tmp_path, keypair, monkeypatch):
    _, public_b64 = keypair
    monkeypatch.setenv("LULLMAIL_UPDATE_PUBLIC_KEYS",
                       json.dumps({"2026-09": public_b64}))
    monkeypatch.setenv("LULLMAIL_REQUIRE_SIGNED_UPDATES", "1")
    runpy.run_path(str(SCRIPTS / "embed_update_keys.py"), run_name="__main__")

    generated = (ROOT / "src" / "_update_keys.py").read_text(encoding="utf-8")
    assert "2026-09" in generated
    # Do not leave a trust store behind for the rest of the suite.
    (ROOT / "src" / "_update_keys.py").unlink()


# ── the workflow itself ────────────────────────────────────────────────────
#
# The tests above prove the scripts work when called correctly. They cannot
# see whether release.yml calls them at all, or with the right arguments —
# which is exactly how the whole chain sat unreachable through several
# releases. These read the workflow.

def _release_yaml() -> dict:
    import yaml
    return yaml.safe_load((ROOT / ".github" / "workflows" / "release.yml")
                          .read_text(encoding="utf-8"))


def _steps(job: str) -> list:
    return _release_yaml()["jobs"][job]["steps"]


def _run_text(job: str) -> str:
    return "\n".join(str(s.get("run", "")) for s in _steps(job))


@pytest.mark.parametrize("job,platform,install", [
    ("build-windows", "windows", "inno"),
    ("build-macos", "macos", "dmg"),
    ("build-linux", "linux", "tar.gz"),
])
def test_every_build_job_describes_its_artifact(job, platform, install):
    run = _run_text(job)
    assert "write_artifact_sidecar.py" in run, f"{job} produces no sidecar to sign"
    assert f"--platform {platform}" in run
    assert f"--install {install}" in run


@pytest.mark.parametrize("job", ["build-windows", "build-macos", "build-linux"])
def test_every_build_job_bakes_the_trust_store_in(job):
    """The keys are sealed at PyInstaller time. A build that misses them
    ships an app that refuses every update and cannot be repaired later."""
    envs = [s.get("env") or {} for s in _steps(job)]
    build = [e for e in envs if "LULLMAIL_VERSION" in e]
    assert build, f"{job} has no PyInstaller build step"
    for env in build:
        assert "LULLMAIL_UPDATE_PUBLIC_KEYS" in env, f"{job} builds with an empty trust store"
        assert env.get("LULLMAIL_REQUIRE_SIGNED_UPDATES") == "1", (
            f"{job} would silently succeed with no keys")


@pytest.mark.parametrize("job", ["build-windows", "build-macos", "build-linux"])
def test_every_build_job_uploads_its_sidecar(job):
    paths = "\n".join(str((s.get("with") or {}).get("path", "")) for s in _steps(job))
    assert ".artifact.json" in paths, f"{job} builds a sidecar and then drops it"


def test_the_release_job_signs_and_verifies():
    run = _run_text("release")
    assert "sign_update_manifest.py" in run, "no manifest is produced"
    assert "verify_release_manifest.py" in run, "the signature is never checked"
    assert "UPDATE_SIGNING_PRIVATE_KEY" in str(_release_yaml()["jobs"]["release"])


def test_the_manifest_points_at_the_repository_the_binaries_trust():
    """$GITHUB_REPOSITORY is whichever repo the workflow runs in. The app
    only accepts downloads under src/updater.py::GITHUB_REPO, so using the
    former produces a signed manifest every install rejects — silently."""
    run = _run_text("release")
    assert "--repo \"$GITHUB_REPOSITORY\"" not in run
    assert "u.GITHUB_REPO" in run, "the signing repo is not read from the app's constant"


def test_the_release_job_checks_out_the_scripts_it_runs():
    names = [s.get("uses", "") for s in _steps("release")]
    assert any("actions/checkout" in u for u in names), (
        "the release job runs repository scripts without checking the repo out")


def test_a_generated_signing_key_can_never_be_committed():
    """`git add -A` does not ask. The generator writes the private key into
    the working tree by default, so the ignore rule is the only thing between
    a routine commit and publishing the key that signs every update."""
    import subprocess
    for name in ("update-signing-key.private", "update-signing-key",
                 "anything.private"):
        rc = subprocess.run(["git", "check-ignore", "-q", name], cwd=ROOT)
        assert rc.returncode == 0, f"{name} is not gitignored"
