"""
Upload an APK (or any file) to a Google Drive folder.

Auth (pick one):
  A) OAuth user (recommended for personal Gmail):
     - Download Desktop OAuth client JSON → secrets/gdrive-oauth-client.json
     - First run opens a browser; token saved to secrets/gdrive-oauth-token.json
  B) Service account (Workspace Shared Drives only — My Drive has no SA quota)

Env (.env):
  GDRIVE_FOLDER_ID=...
  GDRIVE_OAUTH_CLIENT=secrets/gdrive-oauth-client.json   # optional path
  GOOGLE_APPLICATION_CREDENTIALS=secrets/gdrive-service-account.json  # SA only

Usage:
  .\\.venv\\Scripts\\python.exe scripts\\upload_apk_to_drive.py path\\to\\app.apk
"""

from __future__ import annotations

import mimetypes
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCOPES = ["https://www.googleapis.com/auth/drive.file"]


def load_dotenv() -> None:
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


def resolve_path(raw: str) -> Path:
    path = Path(raw)
    if not path.is_absolute():
        path = ROOT / path
    return path


def save_token(token_path: Path, creds) -> None:
    """Store the OAuth token readable by its owner only: it holds a refresh token."""
    token_path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(token_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(creds.to_json())
    os.chmod(token_path, 0o600)  # also tightens a file written by an older run


def drive_literal(value: str) -> str:
    """Quote a value for a Drive search query (backslash first, then the quote)."""
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def get_credentials():
    """Prefer OAuth user token; fall back to service account."""
    from google.auth.exceptions import RefreshError
    from google.auth.transport.requests import Request
    from google.oauth2 import service_account
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow

    oauth_client = resolve_path(
        os.environ.get("GDRIVE_OAUTH_CLIENT", "secrets/gdrive-oauth-client.json")
    )
    token_path = resolve_path(
        os.environ.get("GDRIVE_OAUTH_TOKEN", "secrets/gdrive-oauth-token.json")
    )

    if oauth_client.is_file() or token_path.is_file():
        creds = None
        if token_path.is_file():
            creds = Credentials.from_authorized_user_file(str(token_path), SCOPES)
        if creds and creds.expired and creds.refresh_token:
            try:
                creds.refresh(Request())
                save_token(token_path, creds)
            except RefreshError:
                # Revoked, or older than 7 days while the OAuth app is in "Testing".
                print("Saved Drive sign-in is no longer valid; signing in again.")
                creds = None
        if not creds or not creds.valid:
            if not oauth_client.is_file():
                print(f"Missing OAuth client JSON: {oauth_client}")
                print(
                    "In Cloud Console → APIs & Services → Credentials → "
                    "Create Credentials → OAuth client ID → Desktop app → Download JSON"
                )
                raise SystemExit(1)
            flow = InstalledAppFlow.from_client_secrets_file(str(oauth_client), SCOPES)
            creds = flow.run_local_server(port=0)
            save_token(token_path, creds)
            print(f"Saved OAuth token -> {token_path}")
        return creds, "oauth"

    sa_raw = os.environ.get(
        "GOOGLE_APPLICATION_CREDENTIALS",
        str(ROOT / "secrets" / "gdrive-service-account.json"),
    )
    sa_file = resolve_path(sa_raw)
    if sa_file.is_file():
        print(
            "Using service account. Note: personal My Drive rejects SA uploads "
            "(no storage quota). Prefer OAuth client for Gmail accounts."
        )
        return (
            service_account.Credentials.from_service_account_file(
                str(sa_file), scopes=SCOPES
            ),
            "service_account",
        )

    print("No Drive credentials found.")
    print("Add secrets/gdrive-oauth-client.json (Desktop OAuth client) and re-run.")
    raise SystemExit(1)


def main() -> int:
    load_dotenv()

    if len(sys.argv) < 2:
        print("Usage: upload_apk_to_drive.py <file> [drive-name]")
        return 2

    file_path = Path(sys.argv[1]).expanduser().resolve()
    if not file_path.is_file():
        print(f"File not found: {file_path}")
        return 1

    folder_id = os.environ.get("GDRIVE_FOLDER_ID", "").strip()
    if not folder_id:
        print("Missing GDRIVE_FOLDER_ID. Copy .env.example → .env and set the folder id.")
        return 1

    try:
        import google_auth_oauthlib.flow  # noqa: F401  (used by get_credentials)
        from googleapiclient.discovery import build
        from googleapiclient.http import MediaFileUpload
    except ImportError:
        print(
            "Install deps: .\\.venv\\Scripts\\python.exe -m pip install "
            "google-api-python-client google-auth google-auth-oauthlib"
        )
        return 1

    credentials, auth_mode = get_credentials()
    drive = build("drive", "v3", credentials=credentials, cache_discovery=False)

    name = sys.argv[2] if len(sys.argv) > 2 else file_path.name
    mime, _ = mimetypes.guess_type(str(file_path))
    mime = mime or "application/vnd.android.package-archive"

    # Replace existing file with same name in folder (keeps one BadloVoice APK link).
    existing = (
        drive.files()
        .list(
            q=(
                f"name={drive_literal(name)} "
                f"and {drive_literal(folder_id)} in parents and trashed=false"
            ),
            spaces="drive",
            fields="files(id, name)",
            pageSize=10,
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
        )
        .execute()
        .get("files", [])
    )

    media = MediaFileUpload(str(file_path), mimetype=mime, resumable=True)

    if existing:
        file_id = existing[0]["id"]
        result = (
            drive.files()
            .update(
                fileId=file_id,
                media_body=media,
                fields="id, name, webViewLink, size",
                supportsAllDrives=True,
            )
            .execute()
        )
        print("Updated existing file on Drive.")
    else:
        result = (
            drive.files()
            .create(
                body={"name": name, "parents": [folder_id]},
                media_body=media,
                fields="id, name, webViewLink, size",
                supportsAllDrives=True,
            )
            .execute()
        )
        print("Uploaded new file to Drive.")

    print(f"auth: {auth_mode}")
    print(f"name: {result.get('name')}")
    print(f"id:   {result.get('id')}")
    print(f"link: {result.get('webViewLink')}")
    print(f"size: {result.get('size')} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
