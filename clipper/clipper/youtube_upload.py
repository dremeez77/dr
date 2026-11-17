"""Загрузка Shorts на YouTube через Data API v3 (OAuth-токен на каждый канал)."""
from __future__ import annotations

from pathlib import Path

SCOPES = ["https://www.googleapis.com/auth/youtube.upload"]


def authorize(client_secrets: Path, token_out: Path):
    """Однократная авторизация канала. Запускать на машине с браузером, токен скопировать на сервер."""
    from google_auth_oauthlib.flow import InstalledAppFlow
    flow = InstalledAppFlow.from_client_secrets_file(str(client_secrets), SCOPES)
    creds = flow.run_local_server(port=0, open_browser=True)
    token_out.parent.mkdir(parents=True, exist_ok=True)
    token_out.write_text(creds.to_json())


def upload(token_file: Path, video: Path, title: str, description: str, tags: list[str],
           privacy: str = "public", made_for_kids: bool = False) -> str:
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build
    from googleapiclient.http import MediaFileUpload

    creds = Credentials.from_authorized_user_file(str(token_file), SCOPES)
    if not creds.valid and creds.refresh_token:
        creds.refresh(Request())
        token_file.write_text(creds.to_json())
    yt = build("youtube", "v3", credentials=creds, cache_discovery=False)
    if "#shorts" not in title.lower() and len(title) <= 90:
        title = f"{title} #shorts"
    body = {
        "snippet": {"title": title[:100], "description": description[:4900], "tags": tags[:15],
                    "categoryId": "20"},  # Gaming
        "status": {"privacyStatus": privacy, "selfDeclaredMadeForKids": made_for_kids},
    }
    req = yt.videos().insert(part="snippet,status", body=body,
                             media_body=MediaFileUpload(str(video), chunksize=-1, resumable=True))
    resp = None
    while resp is None:
        _, resp = req.next_chunk()
    return resp["id"]
