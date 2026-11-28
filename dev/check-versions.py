"""Checks that every place a version is written agrees, and that the Android versionCode is the
one the version maps to: major * 10000 + minor * 100 + patch (0.5.0 -> 500, 0.5.1 -> 501,
1.2.3 -> 10203). Android only installs an update whose versionCode is higher, so this keeps it
rising with every release. Run in CI; run by hand after bumping the version:
    python3 dev/check-versions.py
"""
import json, pathlib, re, sys

root = pathlib.Path(__file__).resolve().parent.parent
conf = json.loads((root / "src-tauri" / "tauri.conf.json").read_text())
version = conf["version"]
m = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)", version)
if not m:
    sys.exit(f"tauri.conf.json version {version!r} isn't MAJOR.MINOR.PATCH")
major, minor, patch = map(int, m.groups())
if minor > 99 or patch > 99:
    sys.exit("minor and patch must stay under 100 for the versionCode scheme")

problems = []
expected_code = major * 10000 + minor * 100 + patch
code = conf.get("bundle", {}).get("android", {}).get("versionCode")
if code != expected_code:
    problems.append(f"bundle.android.versionCode is {code}, expected {expected_code} for {version}")

def cargo_version(path):
    text = (root / path).read_text()
    found = re.search(r'^\[package\][^\[]*?^version = "([^"]+)"', text, re.M | re.S)
    return found and found.group(1)

for path in ["src-tauri/Cargo.toml", "crates/icebox-core/Cargo.toml"]:
    v = cargo_version(path)
    if v != version:
        problems.append(f"{path} says {v}, tauri.conf.json says {version}")

lock = (root / "Cargo.lock").read_text()
for name in ["icebox", "icebox-core"]:
    found = re.search(rf'^name = "{re.escape(name)}"\nversion = "([^"]+)"', lock, re.M)
    if not found or found.group(1) != version:
        problems.append(f"Cargo.lock has {name} {found and found.group(1)}, expected {version}")

demo = (root / "ui" / "demo.js").read_text()
if f'version: "{version}"' not in demo:
    problems.append(f"ui/demo.js app_info version isn't {version}")

if problems:
    print("\n".join("::error::" + p for p in problems))
    sys.exit(1)
print(f"versions agree: {version} (Android versionCode {expected_code})")
