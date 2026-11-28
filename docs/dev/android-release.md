# Releasing the Android app (maintainers)

The Android app ships in lockstep with the desktop app: same version, same GitHub release, listed
as **Android (beta)**. GitHub builds it from the tagged source, but **unsigned**. The release key
stays offline on the maintainer's own computer, and the APK is signed there before it's added to
the release.

Why it matters: Android only installs an update signed with the same key as the installed app. If
the key is lost, nobody can update; they'd have to uninstall (losing Icebox's data on the phone)
and install again. If it's stolen, someone could ship an "update" phones would accept. So the key
is made once, backed up carefully, and never uploaded anywhere.

## Once: make the release key

You need Java's `keytool` (it comes with Android Studio: `"$JAVA_HOME/bin/keytool"` in Git Bash,
with `JAVA_HOME` set as in [android.md](android.md)).

1. Pick a folder that isn't inside the repo or any synced folder (OneDrive, Dropbox), e.g.
   `~/icebox-signing/`.
2. Make the key (4096-bit RSA, valid for 30 years). It asks for a password: use a long, unique
   one, and when asked for the key password, press Enter to use the same one.

   ```bash
   mkdir -p ~/icebox-signing && cd ~/icebox-signing
   "$JAVA_HOME/bin/keytool" -genkeypair -v -keystore icebox-release.jks -alias icebox \
     -keyalg RSA -keysize 4096 -validity 10950 \
     -dname "CN=Icebox, O=Blockchainology, C=GB"
   ```

3. **Back it up before using it.** Copy `icebox-release.jks` to at least two offline places (for
   example two USB sticks kept in different places), and keep the password separately from them
   (a password manager, or written down and stored with your other important papers). Test a backup
   by listing it: `"$JAVA_HOME/bin/keytool" -list -keystore /path/to/backup/icebox-release.jks`.
4. Get the certificate fingerprint people will check against:

   ```bash
   "$JAVA_HOME/bin/keytool" -list -v -keystore icebox-release.jks -alias icebox | grep SHA256
   ```

   Put it in the README's Android section and in each release's notes. Zapstore and Obtainium
   users pin it, and anyone can compare it with what `apksigner verify --print-certs` shows.

Never commit the keystore, never put it or its password in a GitHub secret, and don't email it.

## Each release

1. Tag and push as usual. The **release** workflow builds the desktop installers into a draft
   release, and the **android** job builds `Icebox_X.Y.Z_android-beta_unsigned.apk`.
2. Download the job's **android-unsigned** artifact from the workflow run's page (Summary →
   Artifacts) and unzip it into a new folder. It holds the unsigned APK and
   `SHA256SUMS-unsigned`.
3. Optional but good practice: check it came from the workflow and the tag:
   `gh attestation verify Icebox_X.Y.Z_android-beta_unsigned.apk --repo amisatoshi/icebox`
   (works once the repository is public).
4. Sign it, from the repo folder in Git Bash:

   ```bash
   dev/sign-android.sh ~/Downloads/android-unsigned/Icebox_X.Y.Z_android-beta_unsigned.apk \
     ~/icebox-signing/icebox-release.jks
   ```

   It checks the file against `SHA256SUMS-unsigned`, aligns it if needed, signs it (asking for the
   password), verifies it, checks the certificate fingerprint against the one in the README (and
   stops if they differ), and prints the exact line to add to `SHA256SUMS`. The Java "restricted
   method" warnings it shows are harmless.
5. Install the signed APK on a test phone over the previous release (`adb install -r …`) to be sure
   it updates in place, and give it a quick go with a device plugged in.
6. On the draft release, upload `Icebox_X.Y.Z_android-beta.apk`, and add its line to
   `SHA256SUMS`: download `SHA256SUMS`, append the line the script printed (hash, two spaces, file
   name), keep the file's line endings as LF, and upload it again (replacing the old one).
7. In the release notes, under **Android (beta)**, give the certificate fingerprint and say it's a
   beta.
8. Publish the release.

## Version codes

Android needs a whole number (`versionCode`) that goes up with every update. Icebox uses
`major × 10000 + minor × 100 + patch`, so 0.5.0 is 500, 0.5.1 is 501 and 1.0.0 is 10000. It's set
in `src-tauri/tauri.conf.json` under `bundle.android.versionCode`; when you bump the version, bump
it too. `python3 dev/check-versions.py` (also run by CI) checks every version agrees.

## Later: Zapstore

Once a signed APK is on the GitHub release, Zapstore can index it from there (it reads the
release's APK and checks its signing certificate). Set that up with `zapstore.yaml` and the
`zapstore` CLI after the first beta is out.
